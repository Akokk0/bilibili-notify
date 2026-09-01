import { readdirSync } from "node:fs";
import type { UpdateSettings } from "@bilibili-notify/internal";
import { decideUpdate } from "./decide-update.js";
import { fetchSignedManifest } from "./fetch-signed-manifest.js";
import { fetchThroughMirrors } from "./fetch-through-mirrors.js";
import { installPayload } from "./install-payload.js";
import { clearPinnedVersion, pinVersion } from "./select-version-for-boot.js";
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

export type UpdateErrorReason =
	/** 每个候选站都试过了,一个都没拿到。 */
	| "unreachable"
	/** 签名验不过 —— 分发链上可能有人动过手脚,这条才该弹红字。 */
	| "untrusted"
	/** 签名没问题,但内容不是一份合法清单 —— **我们自己**发错了东西。 */
	| "malformed"
	/** 清单拿到了,包没下下来。 */
	| "download-failed"
	/** 包下下来了,但不是清单说的那一坨字节。 */
	| "checksum-mismatch"
	/** 包是对的,写进版本目录时失败(磁盘满 / 只读 / 包里有越界路径)。 */
	| "install-failed"
	/** 已经在最底下那一版上了,没得退。 */
	| "nothing-to-roll-back";

export type UpdateState =
	/** 这个构建没有内置任何信任公钥 —— 整个功能是关的,不是「验签失败」。 */
	| { phase: "disabled" }
	/** 还没查过。 */
	| { phase: "idle" }
	| { phase: "up-to-date"; checkedAt: number }
	| { phase: "available"; target: string; releaseUrl: string; notes?: string; checkedAt: number }
	| { phase: "downloading"; target: string; releaseUrl: string; notes?: string }
	/** 已经装进版本目录,重启就会跑它。 */
	| { phase: "ready"; target: string; releaseUrl: string; notes?: string }
	/** 这一版要更新的镜像才跑得动,在线升不上去。 */
	| { phase: "needs-image-pull"; target: string; releaseUrl: string; checkedAt: number }
	/** 钉子已落,重启就会回到上一版。 */
	| { phase: "rolled-back"; target: string }
	| { phase: "error"; reason: UpdateErrorReason; helpUrl?: string; checkedAt: number };

export interface UpdateStatus {
	currentVersion: string;
	/** 退一步会退到哪。`null` = 已经在最底下那版,按钮该是灰的。 */
	rollbackTarget: string | null;
	state: UpdateState;
}

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
		return { currentVersion, rollbackTarget: rollbackTarget(), state };
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
		});
		// 清单在手,所以这里能精确指到**那一版**的发布页,比只给发布列表有用得多。
		if (!fetched.ok) return fail("download-failed", manifest.releaseUrl);

		const installed = installPayload({
			zip: fetched.bytes,
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

		state = {
			phase: "ready",
			target: manifest.version,
			releaseUrl: manifest.releaseUrl,
			notes: manifest.notes,
		};
		return status();
	}

	return {
		getStatus: status,

		async check(): Promise<UpdateStatus> {
			// 没钥匙就别去打扰网络 —— 拿回来也验不了。
			if (!enabled) return status();

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
		},

		async download(): Promise<UpdateStatus> {
			if (!enabled) return status();
			// 没先 check 过就按下载 —— 让它自己去查一次,而不是回一个「先点检查」。
			if (pending === null) return this.check();
			return installFrom(pending, mirrorChain(readSettings()));
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
