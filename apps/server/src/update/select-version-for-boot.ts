import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "./durable-json.js";
import { installedVersions } from "./version-dirs.js";
import { compareVersions } from "./version-order.js";

export interface SelectVersionForBootInput {
	/** 镜像 / 安装包自带的版本 —— 换不掉的那个底。 */
	imageVersion: string;
	/** 镜像自带那份载荷的位置(容器里是 `/app`)。 */
	imagePath: string;
	/** 已装载荷的根,如 `/data/versions`。 */
	versionsRoot: string;
	/** 连续启动失败多少次就把一个版本判死。 */
	maxBootFailures: number;
}

/**
 * 自愈用的一点点持久状态。放在 `versionsRoot` 下,跟着版本目录一起活。
 *
 * `attempts` 记「选中了但还没确认起来」的次数;`markBootSucceeded` 把它清掉。
 * 达到上限就进 `failed`,从此不再当候选。
 */
interface BootState {
	attempts: Record<string, number>;
	failed: string[];
	/**
	 * 回退用的钉子:钉上之后不再按「取最新」选版。
	 *
	 * 定案是「只保留当前 + 上一版,只退一步,不给版本列表」—— 所以它是一颗一次性的
	 * 钉子,不是通用的版本选择器。两件事压得过它:①这个版本被自愈判死(否则退到一个
	 * 起不来的版本 = 再也进不去面板 = 再也拔不掉钉子);②用户拉了更新的镜像(那是
	 * 一次明确的用户动作,压过之前那次回退的意思)。
	 */
	pinned?: string;
}

const STATE_FILE = "boot-state.json";

function readState(versionsRoot: string): BootState {
	// 文件不在、读不动、被写坏了都会走到这条默认值上 —— 一律当作「还没有任何记录」。
	const raw = readJsonFile(versionsRoot, STATE_FILE) as Partial<BootState> | undefined;
	return {
		attempts: raw?.attempts ?? {},
		failed: Array.isArray(raw?.failed) ? raw.failed : [],
		pinned: typeof raw?.pinned === "string" ? raw.pinned : undefined,
	};
}

function writeState(versionsRoot: string, state: BootState): void {
	writeJsonAtomic(versionsRoot, STATE_FILE, state);
}

export interface BootSelection {
	version: string;
	path: string;
	/** 选中的是镜像自带那份(没有可用载荷,或载荷都比它旧/被判死)。 */
	isImageVersion: boolean;
}

/**
 * 决定这次跑哪一份载荷。
 *
 * 取 `max(镜像版本, 已装载荷)`。**镜像也参与比较**是关键:用户
 * `docker compose pull` 到更新的镜像时,不能被 `/data` 里的旧载荷压住 ——
 * 否则症状是「我明明拉了新镜像,怎么还是旧版」,而且完全没有线索。
 */
export function selectVersionForBoot({
	imageVersion,
	imagePath,
	versionsRoot,
	maxBootFailures,
}: SelectVersionForBootInput): BootSelection {
	const state = readState(versionsRoot);
	const installed = installedVersions(versionsRoot);

	const pinned = usablePin(state, installed, imageVersion);
	if (pinned !== null) {
		if (pinned === imageVersion)
			return { version: imageVersion, path: imagePath, isImageVersion: true };
		return recordAttempt(state, versionsRoot, pinned, maxBootFailures, {
			version: pinned,
			path: join(versionsRoot, pinned),
			isImageVersion: false,
		});
	}

	let best: string | null = null;
	for (const candidate of installed) {
		if (state.failed.includes(candidate)) continue;
		if (compareVersions(candidate, imageVersion) <= 0) continue;
		if (best === null || compareVersions(candidate, best) > 0) best = candidate;
	}

	if (best === null) return { version: imageVersion, path: imagePath, isImageVersion: true };

	return recordAttempt(state, versionsRoot, best, maxBootFailures, {
		version: best,
		path: join(versionsRoot, best),
		isImageVersion: false,
	});
}

/**
 * 钉子还算不算数。
 *
 * 三种情况下当没钉过:被判死(自愈压过钉子)、目录没了(手动清过 / 保留策略清掉了)、
 * 镜像已经比它新(用户拉了新镜像)。钉的就是镜像版本本身时不看目录 —— 镜像那份
 * 永远在。
 */
function usablePin(
	state: BootState,
	installed: readonly string[],
	imageVersion: string,
): string | null {
	const { pinned } = state;
	if (!pinned) return null;
	if (state.failed.includes(pinned)) return null;
	if (compareVersions(imageVersion, pinned) > 0) return null;
	if (pinned === imageVersion) return pinned;
	return installed.includes(pinned) ? pinned : null;
}

/**
 * **选中就记一次尝试**,由 `markBootSucceeded` 来销账。反过来(起来了才记)的话,
 * 崩溃循环永远累加不到上限 —— 而崩溃循环正是这套机制唯一要救的场景。
 */
function recordAttempt(
	state: BootState,
	versionsRoot: string,
	version: string,
	maxBootFailures: number,
	selection: BootSelection,
): BootSelection {
	const attempts = (state.attempts[version] ?? 0) + 1;
	const next: BootState = { ...state, attempts: { ...state.attempts, [version]: attempts } };
	if (attempts >= maxBootFailures) next.failed = [...state.failed, version];
	writeState(versionsRoot, next);
	return selection;
}

export interface ReadBootViewInput {
	versionsRoot: string;
	imageVersion: string;
}

/** 下次开机时选版看到的那幅图景。 */
export interface BootView {
	/**
	 * 盘上现在钉着谁 —— 按**选版那一套**判定(被判死 / 目录没了 / 镜像更新了都算没钉),
	 * 这样面板看到的和下次开机真会发生的是同一件事。
	 *
	 * 回退是靠重启生效的,重启之后内存里那个「rolled-back」早没了,面板只认内存态的话,
	 * 开一次面板就把用户按的回退撤销了。
	 */
	pinned: string | null;
	/** 判死的版本(自愈累计失败,或被清单撤回)。退进一个开不了机的版本等于把人锁在外面。 */
	failed: readonly string[];
	/** 盘上装着的版本。 */
	installed: readonly string[];
}

/**
 * 一次读盘,回答更新服务要问的三件事。
 *
 * 合成一个是因为它们**必须来自同一次快照**:钉子是否算数取决于判死名单和目录在不在,
 * 分三次读的话面板会看到一幅拼接出来的、任何一刻都不曾真实存在过的图景 ——
 * 而这幅图景正是用来预测「下次开机会发生什么」的。顺带也省掉两次同步 IO。
 */
export function readBootView({ versionsRoot, imageVersion }: ReadBootViewInput): BootView {
	const state = readState(versionsRoot);
	const installed = installedVersions(versionsRoot);
	return { pinned: usablePin(state, installed, imageVersion), failed: state.failed, installed };
}

/**
 * 把一个版本判死 —— 给撤回用:正在跑的那份删不得(Windows 上文件还开着),但开机选版
 * 取的是最新,不判死的话重启后还是它。和自愈判死走同一个名单,选版那边不用多认一种。
 */
export function markVersionFailed({
	versionsRoot,
	version,
}: {
	versionsRoot: string;
	version: string;
}): void {
	const state = readState(versionsRoot);
	if (state.failed.includes(version)) return;
	writeState(versionsRoot, { ...state, failed: [...state.failed, version] });
}

export interface PinVersionInput {
	versionsRoot: string;
	version: string;
}

/**
 * 钉住一个版本(回退)。写不进去也不抛 —— 与 boot-state 其余部分同一条纪律:
 * 这份状态是启发,坏了不该让进程起不来。代价是这次回退没生效,而那是用户看得见、
 * 能重试的事。
 */
export function pinVersion({ versionsRoot, version }: PinVersionInput): void {
	writeState(versionsRoot, { ...readState(versionsRoot), pinned: version });
}

/** 拔钉子 —— 装上新版本之后必须做,否则用户会永远停在他退回去的那一版。 */
export function clearPinnedVersion({ versionsRoot }: { versionsRoot: string }): void {
	const { pinned: _dropped, ...rest } = readState(versionsRoot);
	writeState(versionsRoot, rest);
}

export interface MarkBootSucceededInput {
	versionsRoot: string;
	version: string;
}

/**
 * 这个版本真的起来了 —— 把它的失败计数销掉,**也从黑名单里放出来**。
 *
 * 由应用在确认自己活过来之后调用(比如 HTTP 开始 listen)。少了这一步,偶发的
 * 一次起不来(宿主重启、被 OOM 杀、用户手动 kill)会一路累加,最后把一个好版本
 * 判死并悄悄降级 —— 那比不做自愈还糟。
 *
 * 黑名单也要清:判死是在**选中的那一刻**记的,所以阈值那一次它已经在 `failed` 里了
 * —— 而它这次起来了。起来了就不是死的,只清计数不清黑名单的话,它从下一次开机起
 * 就被永久打入冷宫。
 */
export function markBootSucceeded({ versionsRoot, version }: MarkBootSucceededInput): void {
	const state = readState(versionsRoot);
	const wasCounted = state.attempts[version] !== undefined;
	const wasFailed = state.failed.includes(version);
	if (!wasCounted && !wasFailed) return;

	const { [version]: _cleared, ...rest } = state.attempts;
	writeState(versionsRoot, {
		...state,
		attempts: rest,
		failed: state.failed.filter((v) => v !== version),
	});
}
