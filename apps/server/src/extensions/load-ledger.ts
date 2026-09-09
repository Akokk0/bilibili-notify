import { readJsonFile, writeJsonAtomic } from "../update/durable-json.js";

/**
 * 拓展的失败记账 —— 一点点持久状态,住在装载根目录里(`<dataDir>/extensions/`)。
 *
 * 读写纪律复用 `update/durable-json`:**tmp + rename**,而且**两头都吞掉失败** ——
 * 读不出来当没记过,写不进去也不拦着加载。这份状态是启发,坏了不该让拓展起不来。
 */
interface LoadState {
	/** 「选中了但还没确认起来」的次数,键是 `<id>@<version>`。 */
	attempts: Record<string, number>;
	/**
	 * 连着起不来这么多次、**自动停用**了的那些,键同上。
	 *
	 * 与主人按的那个开关(`globals.extensions.<id>.enabled`)**分开**是刻意的:两者
	 * 语义相反。共用一格的话,「修好了重装一版」会变成「装好了但开关莫名其妙是关的」,
	 * 而主人根本不记得自己关过。
	 */
	blocked: string[];
}

const STATE_FILE = "load-state.json";

/** 记账键 —— **带版本**:换一版就是重新给一次机会,不必去哪里手动解封。 */
function ledgerKey(id: string, version: string): string {
	return `${id}@${version}`;
}

function readState(root: string): LoadState {
	const raw = readJsonFile(root, STATE_FILE) as Partial<LoadState> | undefined;
	return {
		attempts: raw?.attempts ?? {},
		blocked: Array.isArray(raw?.blocked) ? raw.blocked : [],
	};
}

/** 盘上现在记着什么。面板要据此说清「为什么它没加载」。 */
export function readLoadLedger(root: string): { blocked: readonly string[] } {
	return { blocked: readState(root).blocked };
}

export interface RecordLoadAttemptInput {
	root: string;
	id: string;
	version: string;
	/** 连着失败多少次就自动停用。 */
	maxFailures: number;
}

export interface LoadAttempt {
	attempts: number;
	/** 这一次就到上限了 —— 加载器该停手。 */
	blocked: boolean;
}

/**
 * **要加载它了,先记一笔。** 由 {@link markLoadSucceeded} 销账。
 *
 * 顺序不能反:等加载成功再记的话,「一 import 就把进程带走」这种循环永远累加不到上限
 * —— 而那正是这套机制唯一要救的场景。
 */
export function recordLoadAttempt({
	root,
	id,
	version,
	maxFailures,
}: RecordLoadAttemptInput): LoadAttempt {
	const state = readState(root);
	const key = ledgerKey(id, version);
	const attempts = (state.attempts[key] ?? 0) + 1;
	const blocked = attempts >= maxFailures;
	writeJsonAtomic(root, STATE_FILE, {
		attempts: { ...state.attempts, [key]: attempts },
		blocked: blocked && !state.blocked.includes(key) ? [...state.blocked, key] : state.blocked,
	} satisfies LoadState);
	return { attempts, blocked };
}

/**
 * 它真的起来了 —— 销掉计数,**也从停用名单里放出来**。
 *
 * 名单是在「要加载的那一刻」记的,所以到阈值那一次它已经在名单里了,而它这次活了。
 * 只清计数不清名单的话,一个其实修好了的拓展从下一次开机起被永久关在门外。
 */
export function markLoadSucceeded({
	root,
	id,
	version,
}: {
	root: string;
	id: string;
	version: string;
}): void {
	const state = readState(root);
	const key = ledgerKey(id, version);
	if (state.attempts[key] === undefined && !state.blocked.includes(key)) return;
	const { [key]: _cleared, ...rest } = state.attempts;
	writeJsonAtomic(root, STATE_FILE, {
		attempts: rest,
		blocked: state.blocked.filter((entry) => entry !== key),
	} satisfies LoadState);
}
