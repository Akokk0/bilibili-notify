/**
 * 统计与粉丝时序:0.x 各个版本留下的形状 → 0.x 最新的形状。一项一项收进来(⑥c);从前文件名在每次开机时
 * 改、行在每次读的时候翻,统计仓开机只认最新的形状。两步,先改名再翻行(翻的是改好名的那一份):
 *
 * 1. **文件键**(ADR-0020 决策 2 的 🔗):B 站的作品、直播、粉丝文件从 `<uid>.jsonl` 并进 `<订阅 id>.jsonl`;
 * 2. **行**(决策 5 / 7 的 🔗):老作品行 `{id, type, ts}` → `{id, kind, ts}`,老下播帧的字符串峰值("1.2万")
 *    → 数字。翻译的规矩与 B 站适配共用 `stats/bili-format.ts` 那一份。
 *
 * 从前每次开机都改名,是为了接住「回退到老版本、它又写出 uid 文件、再升回来」;有了代以后回退再升级是从
 * 第 0 代重迁一代(ADR-0022 决策 3),新代里不会再冒出 uid 文件,迁一次就够。
 */

import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { syncDirectory } from "@bilibili-notify/storage";
import { FOLLOWERS_DIR } from "../fans/store.js";
import { type DataRootKey, dataPath } from "../runtime/roots.js";
import { classifyBiliDynamic, parseBiliViewers } from "../stats/bili-format.js";
import { STATS_DYN_DIR, STATS_LIVE_DIR } from "../stats/store.js";
import {
	isPlainObject,
	listFiles,
	parseJsonLine,
	rewriteJsonlFile,
	rewriteTextFile,
} from "./files.js";
import type { BiliSubscriptionKey } from "./subscriptions.js";

type Dir = readonly [DataRootKey, ...string[]];

/** 这三处按文件键分文件。`stats/seen` 从一开始就按订阅 id 命名,不认它。 */
const KEYED_DIRS: readonly Dir[] = [STATS_DYN_DIR, STATS_LIVE_DIR, FOLLOWERS_DIR];

/**
 * 新代里的统计与粉丝文件迁成最新的形状,回改写过的文件(绝对路径;改了名的回新名字)。`subscriptions` 是
 * 迁好的 B 站订阅(拓展订阅的文件从一开始就按订阅 id 命名)。
 */
export async function migrateStatsFiles(
	dataRoot: string,
	subscriptions: readonly BiliSubscriptionKey[],
): Promise<string[]> {
	const rewritten = new Set(await migrateStatsFileKeys(dataRoot, subscriptions));
	const rows: [Dir, (lines: readonly string[]) => string[]][] = [
		[STATS_DYN_DIR, (lines) => lines.map(migratePostLine)],
		[STATS_LIVE_DIR, migrateLiveFrameLines],
	];
	for (const [dir, rewrite] of rows) {
		const root = dataPath(dataRoot, ...dir);
		for (const name of await listFiles(root, ".jsonl")) {
			if (await rewriteJsonlFile(join(root, name), rewrite)) rewritten.add(join(root, name));
		}
	}
	return [...rewritten];
}

// ── 文件键 ──────────────────────────────────────────────────────────────────────

/**
 * 对每一条 B 站订阅(启用与否都算),三个目录各看一眼:
 *   - 没有 `<uid>.jsonl`:什么都不做;
 *   - 只有 uid 那份:整份写成 id 那份(权限沿用 uid 那份),再删 uid 那份;
 *   - 两份都在(0.x 之间回退过):id 那份在前、uid 那份接在后面 —— 回退期间写的一定更晚,接在后面时间
 *     仍然只增不减;粉丝仓按「时间只增不减」扫文件,见 FansStore.findNearestBefore。id 那份已经以 uid 那份
 *     的内容结尾的(0.x 自己并到一半崩了:并好了、还没删),只删不再接。
 *
 * 找不到 B 站订阅的 uid 文件不碰(可能是删订阅时没删干净的,也可能是别的什么 —— 不是我们的就别动)。同一个
 * uid 两条 B 站订阅(0.x 的服务端不判重,只有面板挡着):两条都拿到一份,与改之前两行共读一个 uid 文件同一个结果。
 *
 * 出错就抛:迁移没有「下次开机再试」,吞掉等于把迁了一半的统计带进新代;抛出去整代作废、下次开机重迁。
 * 0.x 迁到一半留下的 `.migrating` 不用管,搬的时候就当残留丢下了。
 */
async function migrateStatsFileKeys(
	dataRoot: string,
	subscriptions: readonly BiliSubscriptionKey[],
): Promise<string[]> {
	const idsByUid = new Map<string, string[]>();
	for (const sub of subscriptions) {
		const ids = idsByUid.get(sub.uid) ?? [];
		ids.push(sub.id);
		idsByUid.set(sub.uid, ids);
	}
	const written: string[] = [];
	for (const dir of KEYED_DIRS) {
		const root = dataPath(dataRoot, ...dir);
		for (const [uid, ids] of idsByUid) written.push(...(await migrateOne(root, uid, ids)));
	}
	return written;
}

async function migrateOne(root: string, uid: string, ids: readonly string[]): Promise<string[]> {
	const uidFile = join(root, `${uid}.jsonl`);
	const uidContent = await readIfExists(uidFile);
	if (uidContent === undefined) return [];

	const written: string[] = [];
	for (const id of ids) {
		const idFile = join(root, `${id}.jsonl`);
		const idContent = await readIfExists(idFile);
		if (idContent === undefined) {
			await rewriteTextFile(idFile, uidContent, uidFile);
			written.push(idFile);
			continue;
		}
		const head = withTrailingNewline(idContent);
		const tail = withTrailingNewline(uidContent);
		if (head.endsWith(tail)) continue;
		await rewriteTextFile(idFile, head + tail);
		written.push(idFile);
	}
	// 每一份都已经落好了,这时才删 uid 那份。
	await unlink(uidFile);
	await syncDirectory(root);
	return written;
}

/** 读整份;不存在返回 undefined。目录不存在同样当不存在。 */
async function readIfExists(file: string): Promise<string | undefined> {
	try {
		return await readFile(file, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw err;
	}
}

function withTrailingNewline(text: string): string {
	return text === "" || text.endsWith("\n") ? text : `${text}\n`;
}

// ── 行 ──────────────────────────────────────────────────────────────────────────

/** 老作品行:没有 `kind`、带着 B 站类型串。其余的(新行、坏行、认不得的种类)原样留着。 */
function migratePostLine(line: string): string {
	const row = parseJsonLine(line) as
		| { id?: unknown; kind?: unknown; type?: unknown; ts?: unknown }
		| null
		| undefined;
	if (typeof row?.id !== "string" || typeof row.ts !== "string") return line;
	if (row.kind !== undefined || typeof row.type !== "string") return line;
	return JSON.stringify({ id: row.id, kind: classifyBiliDynamic(row.type), ts: row.ts });
}

/**
 * 一份直播帧。老下播帧的字符串峰值翻成数字;解析不出的,这一场当没采到。
 *
 * 「当没采到」不是逐帧翻得出来的:读的人从前在这一帧上把这一场已经记下的峰值**抹掉**(之后的帧再从头取
 * 最大),新形状里一帧表达不了「抹掉」。所以照统计仓的配对认出这一帧下的是哪一场(按开播时刻认:start 开、
 * 随后的 end 闭合它、同一时刻的 start 重新打开同一场),把这一场前面带着峰值的下播帧一起剥掉峰值 —— 读出来
 * 和从前一样。
 */
function migrateLiveFrameLines(lines: readonly string[]): string[] {
	const out = [...lines];
	/** 每一场(开播时刻)前面带着峰值的下播帧:第几行、解开来的那一帧。 */
	const peaked = new Map<string, { index: number; frame: Record<string, unknown> }[]>();
	let open: string | undefined;
	for (const [index, line] of lines.entries()) {
		const frame = parseJsonLine(line);
		if (!isPlainObject(frame) || typeof frame.ts !== "string") continue;
		if (frame.k === "start") {
			open = frame.ts;
			continue;
		}
		if (frame.k !== "end") continue;
		const session = open;
		open = undefined;
		const remember = (next: Record<string, unknown>) => {
			if (session === undefined) return;
			peaked.set(session, [...(peaked.get(session) ?? []), { index, frame: next }]);
		};
		if (typeof frame.peak === "number") {
			remember(frame);
			continue;
		}
		if (typeof frame.peak !== "string") continue;
		const peak = parseBiliViewers(frame.peak);
		if (Number.isFinite(peak)) {
			const next = { ...frame, peak };
			out[index] = JSON.stringify(next);
			remember(next);
			continue;
		}
		out[index] = JSON.stringify(withoutPeak(frame));
		if (session === undefined) continue;
		for (const earlier of peaked.get(session) ?? []) {
			out[earlier.index] = JSON.stringify(withoutPeak(earlier.frame));
		}
		peaked.delete(session);
	}
	return out;
}

function withoutPeak(frame: Record<string, unknown>): Record<string, unknown> {
	const { peak: _peak, ...rest } = frame;
	return rest;
}
