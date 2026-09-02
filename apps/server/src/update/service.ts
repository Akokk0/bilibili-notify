import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import type {
	MirrorProbeResult,
	UpdateErrorReason,
	UpdateState,
	UpdateStatusDTO,
} from "@bilibili-notify/contract";
import type { UpdateSettings } from "@bilibili-notify/internal";
import { decideUpdate } from "./decide-update.js";
import { fetchSignedManifest } from "./fetch-signed-manifest.js";
import { fetchThroughMirrors } from "./fetch-through-mirrors.js";
import { installPayload } from "./install-payload.js";
import { pruneOldVersions } from "./prune-versions.js";
import { clearPinnedVersion, pinVersion, readPinnedVersion } from "./select-version-for-boot.js";
import type { Manifest } from "./signed-manifest.js";
import { compareVersions } from "./version-order.js";

/**
 * 把已经各自钉好的几块串成用户看得见的那条流程:取清单 → 决策 → 下载 → 落盘 → 钉版本。
 *
 * 这一层真正的职责是**把「升不上去」拆开归因**。连不上、我们自己签错了东西、有人在
 * 中间改包 —— 三件事的处置完全不同,混成一句「更新失败」的话,代理站抽风会被当成
 * 安全事件,而真篡改会被当成小毛病。所以下面每一条失败都带着自己的 `reason`,
 * 以及(拿得到的话)一个用户能自己动手的链接。
 *
 * **它不负责重启。** 应用新版本要停掉正在跑的这个进程,那是 index.ts 的事 ——
 * 这里只把载荷准备到「下次启动就会选中它」的状态。
 */

const DEFAULT_TIMEOUT_MS = 15_000;
/** 清单是一份几百字节的 JSON。给到 256KB 已经是天大的余量,再多就是对方在灌我们。 */
const DEFAULT_MAX_MANIFEST_BYTES = 256 * 1024;

export type { UpdateErrorReason, UpdateState };

/** `GET /api/update` 的响应形状,契约在 `@bilibili-notify/contract`。 */
export type UpdateStatus = UpdateStatusDTO;

export interface CreateUpdateServiceInput {
	/** 当前正在跑的那份载荷的版本。 */
	currentVersion: string;
	/** 镜像 / 安装包自带的版本 —— 回退的地板。 */
	imageVersion: string;
	versionsRoot: string;
	nodeMajor: number;
	/** 内置信任列表。**空 = 这个构建不做自主升级**。 */
	trustedKeys: readonly string[];
	manifestUrls: { stable: string; prerelease: string };
	/** 清单都拿不到时,唯一还能给用户的落脚点。 */
	releasesPageUrl: string;
	/** 每次读都取最新 —— 用户在面板上改完设置,下一次检查就该按新的来。 */
	readSettings: () => UpdateSettings;
	timeoutMs?: number;
	maxManifestBytes?: number;
	now?: () => number;
}

export interface UpdateService {
	getStatus(): UpdateStatus;
	check(): Promise<UpdateStatus>;
	/** 手动下载 —— 关掉自动下载时,用户按下按钮走这条。 */
	download(): Promise<UpdateStatus>;
	rollback(): UpdateStatus;
	/**
	 * 「测一遍」:对每个候选前缀(空串 = 直连)各拉一次当前渠道的清单 + 验签,
	 * 回毫秒数与看到的版本,或者归因后的失败。**不碰状态** —— 它不是检查更新。
	 */
	probeMirrors(prefixes: readonly string[]): Promise<MirrorProbeResult[]>;
}

const VERSION_DIR_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function installedVersions(versionsRoot: string): string[] {
	try {
		return readdirSync(versionsRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.filter((name) => VERSION_DIR_RE.test(name));
	} catch {
		return [];
	}
}

export function createUpdateService(input: CreateUpdateServiceInput): UpdateService {
	const {
		currentVersion,
		imageVersion,
		versionsRoot,
		nodeMajor,
		trustedKeys,
		manifestUrls,
		releasesPageUrl,
		readSettings,
		timeoutMs = DEFAULT_TIMEOUT_MS,
		maxManifestBytes = DEFAULT_MAX_MANIFEST_BYTES,
		now = Date.now,
	} = input;

	const enabled = trustedKeys.length > 0;
	let state: UpdateState = enabled ? { phase: "idle" } : { phase: "disabled" };
	/** 最近一次验过签的清单 —— 手动下载要用它,免得再跑一趟网络。 */
	let pending: Manifest | null = null;
	/**
	 * 这个进程里已经装到盘上的那份(版本 + 包的 sha256)。面板每次打开都会查一次,
	 * 装好了还没重启的这段时间里,同一份包不该每开一次面板就重下一遍 —— 但只认
	 * 版本号不够:发版侧重传过资产的话,同版本号下面是另一个包。
	 */
	let onDisk: { version: string; sha256: string } | null = null;
	/**
	 * 正在跑的那趟检查 / 下载。打开面板那次自动检查还在下载,用户走到系统页又按
	 * 「检查更新」—— 不共用的话两趟各下一份、各解一次压,最后谁写盘谁赢。
	 */
	let inflight: Promise<UpdateStatus> | null = null;

	/**
	 * 退一步会退到哪:装着的版本里比当前旧的那个最高的;都没有就退回镜像自带那版。
	 * 已经在镜像那版上就是没得退 —— 与其给一个按了没反应的按钮,不如让它是灰的。
	 */
	function rollbackTarget(): string | null {
		let best: string | null = null;
		for (const candidate of installedVersions(versionsRoot)) {
			if (compareVersions(candidate, currentVersion) >= 0) continue;
			if (best === null || compareVersions(candidate, best) > 0) best = candidate;
		}
		if (best !== null) return best;
		return compareVersions(imageVersion, currentVersion) < 0 ? imageVersion : null;
	}

	function status(): UpdateStatus {
		return {
			currentVersion,
			rollbackTarget: rollbackTarget(),
			// 每次现读:钉子是靠重启生效的,内存态活不过那一下,盘上的才是真相。
			pinnedVersion: readPinnedVersion({ versionsRoot, imageVersion }),
			state,
		};
	}

	function fail(reason: UpdateErrorReason, helpUrl?: string): UpdateStatus {
		state = { phase: "error", reason, helpUrl, checkedAt: now() };
		return status();
	}

	/** 顺序即优先级:用户填的加速前缀先试,**直连永远垫底但永远在**。 */
	function mirrorChain(settings: UpdateSettings): string[] {
		return [...settings.mirrors.filter((m) => m.trim() !== ""), ""];
	}

	async function installFrom(manifest: Manifest, mirrors: string[]): Promise<UpdateStatus> {
		state = {
			phase: "downloading",
			target: manifest.version,
			releaseUrl: manifest.releaseUrl,
			notes: manifest.notes,
		};

		const fetched = await fetchThroughMirrors({
			url: manifest.payload.url,
			mirrors,
			// 清单说了它多大,多一个字节都不收 —— 内容对不对由 sha256 说了算,
			// 但「愿意往内存里读多少」不能交给对方决定。
			maxBytes: manifest.payload.size,
			timeoutMs,
			// sha256 在候选循环里验:代理站给了一坨不对的字节就换下一个,而不是把它
			// 报成「包被掉包」—— 那个归因只配给直连(最后一个候选)。
			accept: (bytes) =>
				createHash("sha256").update(bytes).digest("hex") === manifest.payload.sha256
					? { ok: true, value: bytes }
					: { ok: false, reason: "checksum-mismatch" as const },
		});
		// 清单在手,所以这里能精确指到**那一版**的发布页,比只给发布列表有用得多。
		if (!fetched.ok) {
			return fail(
				fetched.reason === "checksum-mismatch" ? "checksum-mismatch" : "download-failed",
				manifest.releaseUrl,
			);
		}

		const installed = installPayload({
			zip: fetched.value,
			expectedSha256: manifest.payload.sha256,
			version: manifest.version,
			versionsRoot,
		});
		if (!installed.ok) {
			return fail(
				installed.reason === "checksum-mismatch" ? "checksum-mismatch" : "install-failed",
				manifest.releaseUrl,
			);
		}

		// 装上新版本 = 用户明确要往前走,之前那次回退的钉子必须拔掉。留着的话他点了
		// 「立即更新」、重启、版本号纹丝不动,而界面上一切正常 —— 最难查的一类症状。
		clearPinnedVersion({ versionsRoot });

		// 只留「正在跑的」和「刚装的」这两份。回退只退一步,再老的版本没人够得着,
		// 留着就只是在小机器上白占 25MB 一份。**当前那份必须留** —— 它是我们此刻
		// 正在执行的代码,也是待会儿要退回去的地方。
		pruneOldVersions({ versionsRoot, keep: [currentVersion, manifest.version] });

		onDisk = { version: manifest.version, sha256: manifest.payload.sha256 };
		state = {
			phase: "ready",
			target: manifest.version,
			releaseUrl: manifest.releaseUrl,
			notes: manifest.notes,
		};
		return status();
	}

	/** 同一时刻只让一趟在跑;后来的搭前一趟的车,拿到的是同一个结果。 */
	function serialized(run: () => Promise<UpdateStatus>): Promise<UpdateStatus> {
		if (inflight === null) {
			inflight = run().finally(() => {
				inflight = null;
			});
		}
		return inflight;
	}

	async function runCheck(): Promise<UpdateStatus> {
		const settings = readSettings();
		const mirrors = mirrorChain(settings);
		const fetched = await fetchSignedManifest({
			url: manifestUrls[settings.channel === "prerelease" ? "prerelease" : "stable"],
			mirrors,
			trustedKeys,
			timeoutMs,
			maxBytes: maxManifestBytes,
		});
		if (!fetched.ok) {
			// 清单都没拿到,给不出「那一版」的发布页,只能给发布列表 —— 但必须给得出:
			// 「下不动就通知 + 给个链接」是设计里的兜底出口。
			return fail(fetched.reason, releasesPageUrl);
		}

		const manifest = fetched.manifest;
		const decision = decideUpdate({
			currentVersion,
			manifest,
			runtime: { nodeMajor },
			allowPrerelease: settings.channel === "prerelease",
		});

		if (decision.kind === "up-to-date") {
			pending = null;
			state = { phase: "up-to-date", checkedAt: now() };
			return status();
		}
		if (decision.kind === "needs-image-pull") {
			// 载荷能比镜像新,但 Node / chromium / 字体全来自镜像。下下来也跑不起来,
			// 所以连下都不下,直接告诉用户这一版得重拉镜像。
			pending = null;
			state = {
				phase: "needs-image-pull",
				target: decision.target,
				releaseUrl: manifest.releaseUrl,
				checkedAt: now(),
			};
			return status();
		}

		pending = manifest;
		// 这份包这个进程已经装过了,盘上就是它 —— 别再下一遍,也别把 ready 打回
		// available(那会让「立即重启」按钮凭空消失)。不管自动下载开没开。
		if (
			state.phase === "ready" &&
			onDisk?.version === manifest.version &&
			onDisk.sha256 === manifest.payload.sha256
		) {
			return status();
		}
		if (!settings.autoDownload) {
			state = {
				phase: "available",
				target: manifest.version,
				releaseUrl: manifest.releaseUrl,
				notes: manifest.notes,
				checkedAt: now(),
			};
			return status();
		}
		return installFrom(manifest, mirrors);
	}

	return {
		getStatus: status,

		async check(): Promise<UpdateStatus> {
			// 没钥匙就别去打扰网络 —— 拿回来也验不了。
			if (!enabled) return status();
			return serialized(runCheck);
		},

		async download(): Promise<UpdateStatus> {
			if (!enabled) return status();
			return serialized(async () => {
				// 没先 check 过就按下载 —— 让它自己去查一次,而不是回一个「先点检查」。
				if (pending === null) return runCheck();
				return installFrom(pending, mirrorChain(readSettings()));
			});
		},

		async probeMirrors(prefixes) {
			// 没钥匙什么都验不过,测了也只会得到一排「签名验不过」—— 那是误导。
			if (!enabled) return [];
			const settings = readSettings();
			const url = manifestUrls[settings.channel === "prerelease" ? "prerelease" : "stable"];
			// 并行:候选站之间互不影响,串行的话一个卡满超时的站会拖住整张表。
			return Promise.all(
				prefixes.map(async (prefix): Promise<MirrorProbeResult> => {
					const started = now();
					const fetched = await fetchSignedManifest({
						url,
						mirrors: [prefix],
						trustedKeys,
						timeoutMs,
						maxBytes: maxManifestBytes,
					});
					const ms = Math.max(0, now() - started);
					return fetched.ok
						? { prefix, ok: true, ms, version: fetched.manifest.version }
						: { prefix, ok: false, ms, reason: fetched.reason };
				}),
			);
		},

		rollback(): UpdateStatus {
			const target = rollbackTarget();
			if (target === null) return fail("nothing-to-roll-back");
			pinVersion({ versionsRoot, version: target });
			state = { phase: "rolled-back", target };
			return status();
		},
	};
}
