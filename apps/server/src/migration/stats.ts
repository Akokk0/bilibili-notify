/**
 * 统计与粉丝时序:0.x 各个版本留下的形状 → 0.x 最新的形状。一项一项收进来(⑥c);从前文件名在每次开机时
 * 改、行在每次读的时候翻,统计仓开机只认最新的形状。两步,先改名再翻行(翻的是改好名的那一份):
 *
 * 1. **文件键**(ADR-0020 决策 2 的 🔗):B 站的作品、直播、粉丝文件从 `<uid>.jsonl` 并进 `<订阅 id>.jsonl`;
 * 2. **行与目录**(决策 5 / 7 的 🔗、ADR-0027):老作品行 `{id, type, ts}`(0.x 中间版本带 `kind`)→ `{id, hasVideo, publishedAt}`,
 *    **开播公告那两种行丢掉**(统计不再记它),文件连同目录从 `stats/dyn/` 搬到 `stats/posts/`;老直播帧
 *    `{k, ts, peak}` → `{kind, occurredAt, peakTotalViewers}`,字符串峰值("1.2万")→ 数字({@link parseBiliViewers},
 *    1.0 起「1.2万」的解析只留在这里)。行一步翻到最新形状,不先写旧形状再改;作品的类型串翻译与 B 站适配共用
 *    `stats/bili-format.ts` 那一份。
 *
 * 从前每次开机都改名,是为了接住「回退到老版本、它又写出 uid 文件、再升回来」;有了代以后回退再升级照用
 * 迁好的那一代,手动从第 0 代重迁也走这里(ADR-0022 决策 3 下 10-01 的 🔗),新代里不会冒出 uid 文件,迁一次就够。
 */

import { readFile, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { syncDirectory } from "@bilibili-notify/storage";
import { FOLLOWERS_DIR } from "../followers/store.js";
import { type DataRootKey, dataPath } from "../runtime/roots.js";
import { classifyBiliDynamic } from "../stats/bili-format.js";
import { STATS_LIVE_DIR, STATS_POSTS_DIR } from "../stats/store.js";
import {
	isPlainObject,
	listFiles,
	parseJsonLine,
	rewriteJsonlFile,
	rewriteTextFile,
} from "./files.js";
import type { BiliSubscriptionKey } from "./subscriptions.js";

type Dir = readonly [DataRootKey, ...string[]];

/**
 * 把 B 站「X 人看过」的压缩写法("1.2万" / "3.5亿" / "9500")解析成数字;解析不出返回 `NaN`。
 *
 * 不能拿字符串直接比大小("9500" 会大于 "1.2万"),也不能把解析失败当 0 —— 未知不是零,
 * 一个静默的 0 会把场均拖下水。调用方拿 `Number.isFinite` 判。
 *
 * 只给迁移读 0.x 的字符串峰值用:1.0 起总线上的观看人数是精确数,统计的 B 站适配不再解析它。
 */
export function parseBiliViewers(raw: string): number {
	const m = raw.trim().match(/^([\d.]+)\s*(万|亿)?$/);
	if (!m) return Number.NaN;
	const n = Number(m[1]);
	if (!Number.isFinite(n)) return Number.NaN;
	if (m[2] === "万") return n * 10_000;
	if (m[2] === "亿") return n * 100_000_000;
	return n;
}

/**
 * 0.x 里作品住的目录。**只有迁移认它**:搬过来之后先按文件键改名,再逐份翻行写进 {@link STATS_POSTS_DIR}、删掉这一份。
 */
const ZERO_POSTS_DIR: Dir = ["stats", "dyn"];

/** 这三处按文件键分文件。`stats/seen` 从一开始就按订阅 id 命名,不在这里改;它与 `stats/since` 由「在记」那一步读完就删(`recording.ts`)。 */
const KEYED_DIRS: readonly Dir[] = [ZERO_POSTS_DIR, STATS_LIVE_DIR, FOLLOWERS_DIR];

/**
 * 新代里的统计与粉丝文件迁成最新的形状,回改写过的文件(绝对路径;改了名的回新名字)。`subscriptions` 是
 * 迁好的 B 站订阅(拓展订阅的文件从一开始就按订阅 id 命名)。
 */
export async function migrateStatsFiles(
	dataRoot: string,
	subscriptions: readonly BiliSubscriptionKey[],
): Promise<string[]> {
	const rewritten = new Set(await migrateStatsFileKeys(dataRoot, subscriptions));
	// 作品:翻行 + 搬进新目录。文件键那一步写的是旧目录里的文件,这一步把它们搬走,所以汇报里只留新位置。
	const zeroPostsRoot = dataPath(dataRoot, ...ZERO_POSTS_DIR);
	const postsRoot = dataPath(dataRoot, ...STATS_POSTS_DIR);
	for (const name of await listFiles(zeroPostsRoot, ".jsonl")) {
		const from = join(zeroPostsRoot, name);
		rewritten.delete(from);
		const text = migratePostLines((await readFile(from, "utf8")).split("\n")).join("\n");
		// 一条作品都没剩(全是开播公告)就不留一份空文件。
		if (text !== "") {
			await rewriteTextFile(join(postsRoot, name), text, from);
			rewritten.add(join(postsRoot, name));
		}
		await unlink(from);
	}
	await removeDirIfEmpty(zeroPostsRoot);
	// 直播帧:原地改形。
	const liveRoot = dataPath(dataRoot, ...STATS_LIVE_DIR);
	for (const name of await listFiles(liveRoot, ".jsonl")) {
		if (await rewriteJsonlFile(join(liveRoot, name), migrateLiveFrameLines)) {
			rewritten.add(join(liveRoot, name));
		}
	}
	return [...rewritten];
}

/** 旧目录搬空了就删;里面还有别的东西(残留件)就留着 —— 统计仓只认新目录,不认它。 */
async function removeDirIfEmpty(dir: string): Promise<void> {
	try {
		await rmdir(dir);
		await syncDirectory(join(dir, ".."));
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ENOTEMPTY") throw err;
	}
}

// ── 文件键 ──────────────────────────────────────────────────────────────────────

/**
 * 对每一条 B 站订阅(启用与否都算),三个目录各看一眼:
 *   - 没有 `<uid>.jsonl`:什么都不做;
 *   - 只有 uid 那份:整份写成 id 那份(权限沿用 uid 那份),再删 uid 那份;
 *   - 两份都在(0.x 之间回退过):id 那份在前、uid 那份接在后面 —— 回退期间写的一定更晚,接在后面时间
 *     仍然只增不减;粉丝仓按「时间只增不减」扫文件,见 FollowersStore.findNearestBefore。id 那份已经以 uid 那份
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

/**
 * 一份作品行 → 最新的形状。
 *   - 0.x 的 `{id, type, ts}`:按 B 站类型串分有没有视频,**开播那两种丢掉**;
 *   - 0.x 中间版本的 `{id, kind, ts}`:`video` 是有视频,`live` 丢掉;
 *   - 已经是 `{id, hasVideo, publishedAt}` 的、坏行、认不得的种类:原样留着。
 */
function migratePostLines(lines: readonly string[]): string[] {
	const out: string[] = [];
	for (const line of lines) {
		const row = parseJsonLine(line) as
			| { id?: unknown; kind?: unknown; type?: unknown; ts?: unknown }
			| null
			| undefined;
		if (typeof row?.id !== "string" || typeof row.ts !== "string") {
			out.push(line);
			continue;
		}
		let hasVideo: boolean | undefined;
		if (row.kind === "video" || row.kind === "post") hasVideo = row.kind === "video";
		else if (row.kind === "live") continue;
		else if (row.kind === undefined && typeof row.type === "string") {
			const post = classifyBiliDynamic(row.type);
			if (!post) continue;
			hasVideo = post.hasVideo;
		}
		out.push(
			hasVideo === undefined ? line : JSON.stringify({ id: row.id, hasVideo, publishedAt: row.ts }),
		);
	}
	return out;
}

/**
 * 一份直播帧 → 最新的形状 `{kind, occurredAt, peakTotalViewers?}`。老下播帧的字符串峰值翻成数字;解析不出的,
 * 这一场当没采到。已经是新形状的帧与坏行原样留着。
 *
 * 「当没采到」不是逐帧翻得出来的:读的人从前在这一帧上把这一场已经记下的峰值**抹掉**(之后的帧再从头取
 * 最大),新形状里一帧表达不了「抹掉」。所以照统计仓的配对认出这一帧下的是哪一场(按开播时刻认:start 开、
 * 随后的 end 闭合它、同一时刻的 start 重新打开同一场),把这一场前面带着峰值的下播帧一起剥掉峰值 —— 读出来
 * 和从前一样。
 */
function migrateLiveFrameLines(lines: readonly string[]): string[] {
	const out = [...lines];
	/** 每一场(开播时刻)前面带着峰值的下播帧:第几行、翻好的那一帧。 */
	const peaked = new Map<string, { index: number; frame: NewLiveFrame }[]>();
	let open: string | undefined;
	for (const [index, line] of lines.entries()) {
		const frame = parseJsonLine(line);
		if (!isPlainObject(frame) || typeof frame.ts !== "string") continue;
		if (frame.k === "start") {
			out[index] = JSON.stringify({ kind: "start", occurredAt: frame.ts });
			open = frame.ts;
			continue;
		}
		if (frame.k !== "end") continue;
		const session = open;
		open = undefined;
		const next: NewLiveFrame = { kind: "end", occurredAt: frame.ts };
		const remember = () => {
			if (session === undefined) return;
			peaked.set(session, [...(peaked.get(session) ?? []), { index, frame: next }]);
		};
		if (typeof frame.peak === "number") {
			next.peakTotalViewers = frame.peak;
			out[index] = JSON.stringify(next);
			remember();
			continue;
		}
		if (typeof frame.peak !== "string") {
			out[index] = JSON.stringify(next);
			continue;
		}
		const peak = parseBiliViewers(frame.peak);
		if (Number.isFinite(peak)) {
			next.peakTotalViewers = peak;
			out[index] = JSON.stringify(next);
			remember();
			continue;
		}
		out[index] = JSON.stringify(next);
		if (session === undefined) continue;
		for (const earlier of peaked.get(session) ?? []) {
			const { peakTotalViewers: _peak, ...rest } = earlier.frame;
			out[earlier.index] = JSON.stringify(rest);
		}
		peaked.delete(session);
	}
	return out;
}

interface NewLiveFrame {
	kind: "end";
	occurredAt: string;
	peakTotalViewers?: number;
}
