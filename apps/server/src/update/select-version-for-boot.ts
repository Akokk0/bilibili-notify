import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
}

const STATE_FILE = "boot-state.json";

function readState(versionsRoot: string): BootState {
	try {
		const raw = JSON.parse(readFileSync(join(versionsRoot, STATE_FILE), "utf8")) as
			| Partial<BootState>
			| undefined;
		return {
			attempts: raw?.attempts ?? {},
			failed: Array.isArray(raw?.failed) ? raw.failed : [],
		};
	} catch {
		// 文件不在、读不动、或者被写坏了 —— 一律当作「还没有任何记录」。这份状态
		// 只是启发,坏掉了不该让进程起不来。
		return { attempts: {}, failed: [] };
	}
}

function writeState(versionsRoot: string, state: BootState): void {
	try {
		mkdirSync(versionsRoot, { recursive: true });
		writeFileSync(join(versionsRoot, STATE_FILE), JSON.stringify(state));
	} catch {
		// 写不进去(只读挂载、磁盘满)也不能拦着启动。代价是自愈失灵,但那也好过
		// 因为记不上账就干脆不启动。
	}
}

export interface BootSelection {
	version: string;
	path: string;
	/** 选中的是镜像自带那份(没有可用载荷,或载荷都比它旧/被判死)。 */
	isImageVersion: boolean;
}

/**
 * 只有长得像版本号的目录才算候选。
 *
 * `/data` 是用户挂出来的,他们真的会往里丢东西 —— 一个叫 `2026-09-01` 的手动备份
 * 按数字段会被读成主版本 **2026**,压过一切真版本,然后我们就从一个根本不是载荷
 * 的目录里启动。安装中途留下的 `.staging-*` 也一并被这条挡住。
 */
const VERSION_DIR_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function installedVersions(versionsRoot: string): string[] {
	try {
		return readdirSync(versionsRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.filter((name) => VERSION_DIR_RE.test(name));
	} catch {
		// 目录还不存在(从没升过级)——一个候选都没有,不是错误。
		return [];
	}
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

	let best: string | null = null;
	for (const candidate of installedVersions(versionsRoot)) {
		if (state.failed.includes(candidate)) continue;
		if (compareVersions(candidate, imageVersion) <= 0) continue;
		if (best === null || compareVersions(candidate, best) > 0) best = candidate;
	}

	if (best === null) return { version: imageVersion, path: imagePath, isImageVersion: true };

	// **选中就记一次尝试**,由 `markBootSucceeded` 来销账。反过来(起来了才记)的话,
	// 崩溃循环永远累加不到上限 —— 而崩溃循环正是这套机制唯一要救的场景。
	const attempts = (state.attempts[best] ?? 0) + 1;
	if (attempts >= maxBootFailures) {
		writeState(versionsRoot, {
			attempts: { ...state.attempts, [best]: attempts },
			failed: [...state.failed, best],
		});
	} else {
		writeState(versionsRoot, { ...state, attempts: { ...state.attempts, [best]: attempts } });
	}

	return { version: best, path: join(versionsRoot, best), isImageVersion: false };
}

export interface MarkBootSucceededInput {
	versionsRoot: string;
	version: string;
}

/**
 * 这个版本真的起来了 —— 把它的失败计数销掉。
 *
 * 由应用在确认自己活过来之后调用(比如 HTTP 开始 listen)。少了这一步,偶发的
 * 一次起不来(宿主重启、被 OOM 杀、用户手动 kill)会一路累加,最后把一个好版本
 * 判死并悄悄降级 —— 那比不做自愈还糟。
 */
export function markBootSucceeded({ versionsRoot, version }: MarkBootSucceededInput): void {
	const state = readState(versionsRoot);
	if (state.attempts[version] === undefined) return;

	const { [version]: _cleared, ...rest } = state.attempts;
	writeState(versionsRoot, { ...state, attempts: rest });
}
