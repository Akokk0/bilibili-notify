import { createHash } from "node:crypto";
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
import { readSeenIssuedAt, rememberIssuedAt } from "./manifest-freshness.js";
import { pruneOldVersions, removeVersionDir } from "./prune-versions.js";
import {
	type BootView,
	clearPinnedVersion,
	markVersionRevoked,
	pinVersion,
	readBootView,
} from "./select-version-for-boot.js";
import type { Manifest } from "./signed-manifest.js";
import { installedVersions } from "./version-dirs.js";
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
}

export interface UpdateService {
	getStatus(): UpdateStatus;
	check(): Promise<UpdateStatus>;
	/** 手动下载 —— 关掉自动下载时,用户按下按钮走这条。 */
	download(): Promise<UpdateStatus>;
	/** 也走串行闸:下载途中按回退,钉子要落在下载**之后**,否则会被下载完成时的拔钉子抹掉。 */
	rollback(): Promise<UpdateStatus>;
	/**
	 * 「测一遍」:对每个候选前缀(空串 = 直连)各拉一次当前渠道的清单 + 验签,
	 * 回毫秒数与看到的版本,或者归因后的失败。**不碰状态** —— 它不是检查更新。
	 */
	probeMirrors(prefixes: readonly string[]): Promise<MirrorProbeResult[]>;
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
	} = input;

	const enabled = trustedKeys.length > 0;
	let state: UpdateState = enabled ? { phase: "idle" } : { phase: "disabled" };
	/**
	 * 最近一次验过签的清单 —— 手动下载要用它,免得再跑一趟网络。带上它是在哪个渠道
	 * 查到的:用户换了渠道之后按下载,不能把上个渠道那份装上去。
	 */
	let pending: { manifest: Manifest; channel: "stable" | "prerelease" } | null = null;
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
	 *
	 * 挑的规矩必须和选版那边对钉子的判定(`usablePin`)**一致**:比镜像旧的、被判死或被撤回的
	 * 都不能当目标,否则面板说「已回退,重启生效」,重启后选版把钉子当没钉过,版本纹丝不动。
	 * 所以判死名单与已装列表都取自**选版那边给出的同一幅快照**(`readBootView`)。
	 */
	function rollbackTarget({ unbootable, installed }: BootView): string | null {
		let best: string | null = null;
		for (const candidate of installed) {
			if (compareVersions(candidate, currentVersion) >= 0) continue;
			if (compareVersions(candidate, imageVersion) < 0) continue;
			if (unbootable.includes(candidate)) continue;
			if (best === null || compareVersions(candidate, best) > 0) best = candidate;
		}
		if (best !== null) return best;
		// 镜像那份不在 `installed` 里(它不住在 versionsRoot),但同样要过判死这一关 ——
		// 撤回的就是它时,退回去等于把用户送回一个厂商已经召回的构建。
		if (unbootable.includes(imageVersion)) return null;
		return compareVersions(imageVersion, currentVersion) < 0 ? imageVersion : null;
	}

	function status(): UpdateStatus {
		// 每次现读:钉子是靠重启生效的,内存态活不过那一下,盘上的才是真相。一次读出
		// 整幅快照,回退目标和钉子说的才是同一个盘面。
		const view = readBootView({ versionsRoot, imageVersion });
		return {
			currentVersion,
			rollbackTarget: rollbackTarget(view),
			pinnedVersion: view.pinned,
			state,
		};
	}

	function fail(reason: UpdateErrorReason, helpUrl?: string): UpdateStatus {
		state = { phase: "error", reason, helpUrl, checkedAt: Date.now() };
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
			timeoutMs: DEFAULT_TIMEOUT_MS,
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

	/**
	 * 排在正在跑的那趟**后面**跑,而不是搭它的车 —— 回退这种「结果和前一趟不同」的操作
	 * 用这个:搭车拿到的会是前一趟(比如一次下载)的结果,自己根本没跑。
	 */
	function queued(run: () => Promise<UpdateStatus>): Promise<UpdateStatus> {
		const prior: Promise<unknown> = inflight ?? Promise.resolve();
		const next: Promise<UpdateStatus> = prior.then(run, run).finally(() => {
			if (inflight === next) inflight = null;
		});
		inflight = next;
		return next;
	}

	/**
	 * 这个进程装好的那份还躺在盘上等重启。这时 `ready` 是**盘上的事实**(重启就会跑它,
	 * 选版只看盘上谁最新),不是这次检查的结论 —— 一次失败的检查、或清单退回去了,都不能
	 * 把它盖掉:盖成 error 会让「立即重启」凭空消失,盖成 up-to-date 则是在说谎。
	 */
	function readyOnDisk(): boolean {
		return state.phase === "ready" && onDisk !== null;
	}

	function alreadyOnDisk(manifest: Manifest): boolean {
		return (
			state.phase === "ready" &&
			onDisk?.version === manifest.version &&
			onDisk.sha256 === manifest.payload.sha256
		);
	}

	/**
	 * 清单说这些版本被撤回了 —— 服务端撤回闸只拦得住还没升的人,这里管**已经在盘上**的:
	 *
	 * - 装好了还没重启的那份:删目录、撤掉 ready。选版只看盘上谁最新,不删的话用户随手
	 *   一重启就装上了厂商已经召回的构建。
	 * - 正在跑的那份:删不得(Windows 上文件还开着),记进**撤回**名单 —— 开机选版从此
	 *   不选它,而清单那版(哪怕更旧)会被当成更新目标装上,见 decideUpdate。
	 *
	 * 撤回记的是 `revoked` 而不是自愈那份 `failed`:后者会被「这一版起来了」清掉,
	 * 而被撤回的正好是镜像自带那版时,重启后它必然起来 —— 于是召回被自己撤销。
	 */
	function quarantineRevoked(revoked: readonly string[]): void {
		if (revoked.length === 0) return;
		const installed = installedVersions(versionsRoot);
		for (const version of revoked) {
			if (version === currentVersion) {
				markVersionRevoked({ versionsRoot, version });
				continue;
			}
			if (!installed.includes(version)) continue;
			removeVersionDir(versionsRoot, version);
			if (onDisk?.version === version) onDisk = null;
			if (pending?.manifest.version === version) pending = null;
			if ("target" in state && state.target === version) state = { phase: "idle" };
		}
	}

	/**
	 * 取一份当前渠道的签过名的清单。检查更新与「测一遍」都从这里出去 —— 两边对
	 * 超时、体积上限、防回放下限的要求本来就该一模一样,分开写两份的下一步就是
	 * 「面板上测着好好的,一检查就说清单太旧」。
	 */
	function fetchManifest(channel: "stable" | "prerelease", mirrors: readonly string[]) {
		return fetchSignedManifest({
			url: manifestUrls[channel],
			mirrors,
			trustedKeys,
			timeoutMs: DEFAULT_TIMEOUT_MS,
			maxBytes: DEFAULT_MAX_MANIFEST_BYTES,
			// 比之前见过的旧的清单不收:签名有效不等于是当前那份,加速站可以回放旧的。
			minIssuedAt: readSeenIssuedAt(versionsRoot, channel),
		});
	}

	async function runCheck(): Promise<UpdateStatus> {
		const settings = readSettings();
		const mirrors = mirrorChain(settings);
		const { channel } = settings;
		const fetched = await fetchManifest(channel, mirrors);
		if (!fetched.ok) {
			if (readyOnDisk()) return status();
			// 上一次查到的那份不能留着:它可能已经被撤回了,而这次没查到 —— 用户按「下载」
			// 时得重新查,不能把一份来历不明的旧清单装上去。
			pending = null;
			// 清单都没拿到,给不出「那一版」的发布页,只能给发布列表 —— 但必须给得出:
			// 「下不动就通知 + 给个链接」是设计里的兜底出口。
			return fail(fetched.reason === "stale" ? "stale-manifest" : fetched.reason, releasesPageUrl);
		}

		const manifest = fetched.manifest;
		rememberIssuedAt(versionsRoot, channel, manifest.issuedAt);
		quarantineRevoked(manifest.revoked ?? []);
		const decision = decideUpdate({
			currentVersion,
			manifest,
			runtime: { nodeMajor },
			allowPrerelease: settings.channel === "prerelease",
		});

		if (decision.kind === "up-to-date") {
			pending = null;
			if (readyOnDisk()) return status();
			state = { phase: "up-to-date", checkedAt: Date.now() };
			return status();
		}
		if (decision.kind === "needs-image-pull") {
			// 载荷能比镜像新,但 Node / chromium / 字体全来自镜像。下下来也跑不起来,
			// 所以连下都不下,直接告诉用户这一版得重拉镜像。
			pending = null;
			if (readyOnDisk()) return status();
			state = {
				phase: "needs-image-pull",
				target: decision.target,
				releaseUrl: manifest.releaseUrl,
				checkedAt: Date.now(),
			};
			return status();
		}

		pending = { manifest, channel };
		// 这份包这个进程已经装过了,盘上就是它 —— 别再下一遍,也别把 ready 打回
		// available(那会让「立即重启」按钮凭空消失)。不管自动下载开没开。
		if (alreadyOnDisk(manifest)) return status();
		if (!settings.autoDownload) {
			state = {
				phase: "available",
				target: manifest.version,
				releaseUrl: manifest.releaseUrl,
				notes: manifest.notes,
				checkedAt: Date.now(),
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
			// 排在正在跑的检查**后面**,而不是搭它的车:搭车拿到的是那次检查的结果,一个字节
			// 都没下,按钮像是死了。
			return queued(async () => {
				const settings = readSettings();
				// 没先 check 过、或者上次查的是另一个渠道 —— 让它自己去查一次,而不是回一个
				// 「先点检查」,更不能把上个渠道那份装上去。
				if (pending === null || pending.channel !== settings.channel) return runCheck();
				// 已经装好的就别再下一遍 —— 「下载」按了两次不该变成两次 7MB。
				if (alreadyOnDisk(pending.manifest)) return status();
				return installFrom(pending.manifest, mirrorChain(settings));
			});
		},

		async probeMirrors(prefixes) {
			// 没钥匙什么都验不过,测了也只会得到一排「签名验不过」—— 那是误导。
			if (!enabled) return [];
			const { channel } = readSettings();
			// 并行:候选站之间互不影响,串行的话一个卡满超时的站会拖住整张表。
			return Promise.all(
				prefixes.map(async (prefix): Promise<MirrorProbeResult> => {
					const started = Date.now();
					// 只给一个候选:测的就是「这一站行不行」,垫底直连会让每一行都变成绿的。
					const fetched = await fetchManifest(channel, [prefix]);
					const ms = Math.max(0, Date.now() - started);
					return fetched.ok
						? { prefix, ok: true, ms, version: fetched.manifest.version }
						: { prefix, ok: false, ms, reason: fetched.reason };
				}),
			);
		},

		rollback(): Promise<UpdateStatus> {
			// 走串行闸:正在下载时,钉子必须落在 installFrom 的 clearPinnedVersion **之后**,
			// 不然用户看到「已回退」,几秒后下载落地又把钉子拔了、状态盖成 ready。
			return queued(async () => {
				const target = rollbackTarget(readBootView({ versionsRoot, imageVersion }));
				if (target === null) return fail("nothing-to-roll-back");
				pinVersion({ versionsRoot, version: target });
				state = { phase: "rolled-back", target };
				return status();
			});
		},
	};
}
