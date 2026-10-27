import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Logger } from "@bilibili-notify/internal";
import { appendJsonl, atomicWriteFile, isLeftoverName } from "@bilibili-notify/storage";
import { dataPath } from "../runtime/roots.js";
import { compressRecordingEntries } from "./recording-compress.js";

/**
 * 按订阅分文件的「UP 产出」时序持久化 —— 数据统计页 Tab 的原始数据源。
 *
 * 文件布局(`<key>` 是 {@link statsFileKey}:两支都是订阅 id):
 *   `<dataDir>/stats/posts/<key>.jsonl` 每行一条 {@link PostEntry}
 *   `<dataDir>/stats/live/<key>.jsonl`  每行一帧 {@link LiveFrame}
 *   `<dataDir>/stats/recording/<key>.jsonl` 每行一条 {@link RecordingEntry}(「在记」的小账:这一项从几点到几点在记)
 * 0.x 按 uid 命名的 B 站文件由迁移器改成订阅 id(`migration/stats.ts`)。
 *
 * **盘上的行是中立的**(ADR-0020 决策 16、ADR-0027):作品行记「有没有视频」与发布时刻,下播帧的峰值存
 * 数字。平台的写法由各来源的适配在交进来之前翻好;0.x 落盘的老 B 站行由迁移器一次翻好(`migration/stats.ts`),
 * 这一层不认任何平台的写法。**开播公告不记**:直播按场次另算,公告再记一行就是把一场直播算两次。
 *
 * 与 FollowersStore 同构:append-only、逐行 JSON、坏行跳过、缺文件视为空。区别在于
 * 直播场次天然是「区间」而非「采样点」,而 append-only 又写不了区间,所以落盘的
 * 是 start / end 两种**帧**,配对推迟到读时({@link StatsStore.listLiveSessions})。
 * 这样进程在直播中途崩溃只会留下一个未闭合的 start,不需要启动时做修复扫描。
 * 代价是「仍在直播」与「崩溃遗留」在落盘层面长得一模一样,分不开 —— 这个歧义
 * 由 `summarizeLiveSessions` 结合引擎的实时在播状态消解(只有最后一场且确实
 * 在播才计时长),别在这一层假设未闭合就等于在播。
 *
 * **没有 retention pass**:与 fans jsonl 同理,一条动态/一场直播的体量比 fans
 * 采样点小几个数量级(一个活跃 UP 一天也就个位数),几年内不构成磁盘问题。
 */

/**
 * 一条作品行。
 *
 * 「投稿」= `hasVideo` 为真,「动态」= 其余(图文、纯文字、转发……);这一层只记有没有视频,
 * 种类的叫法归读它的人。分类由各来源自己做(ADR-0020 决策 5 的 🔗),这一层不认平台类型。
 */
export interface PostEntry {
	/** 平台给的作品 id(B 站是动态 id_str);同一个键下的幂等键。 */
	id: string;
	/** 作品里带不带视频。 */
	hasVideo: boolean;
	/** 发布时间(ISO)。 */
	publishedAt: string;
	/**
	 * 以下五格是多收的(ADR-0027 决策 4 / 12,规矩见 `docs/agents/conventions/stats-collection.md`):来源交到手的现成字段,
	 * **全部可选**、没有就不写;老行没有这些格。取法在 `post-entry-extras.ts`。
	 */
	/** 作品链接。 */
	url?: string;
	/** 标题(截 100 字)。 */
	title?: string;
	/** 摘要:取段函数的 AI 拼法,截 200 字。 */
	summary?: string;
	/** 话题,一个字符串(同 `Post.topic`)。 */
	topic?: string;
	/** 视频时长,秒。 */
	videoDurationSec?: number;
}

/** 开一场直播要交的整包。标题与分区都是来源已经交到手的现成字段。 */
export interface LiveSessionStart {
	startedAt: string;
	title?: string;
	category?: string;
}

/** 关一场直播要交的整包;峰值与五格互动汇总都只在来源给出时才有。 */
export interface LiveSessionClose {
	endedAt: string;
	peakTotalViewers?: number;
	viewerChatCount?: number;
	viewerChatSenderCount?: number;
	superchatCount?: number;
	superchatTotals?: Record<string, number>;
	membershipCounts?: Record<string, Record<string, number>>;
}

/** 配对后的一场直播。`endedAt` 缺失 = 仍在直播或 end 帧丢失,不计入时长。 */
export interface LiveSessionEntry {
	startedAt: string;
	endedAt?: string;
	/** 开播时直播间的标题(至多 100 字)。 */
	title?: string;
	/** 开播时的直播分区。 */
	category?: string;
	/** 本场累计观看(看过的人数,ADR-0020 决策 7);未采到时缺失。 */
	peakTotalViewers?: number;
	/** 这一场收到的弹幕条数。 */
	viewerChatCount?: number;
	/** 这一场发过弹幕的人数。 */
	viewerChatSenderCount?: number;
	/** 这一场的醒目留言条数。 */
	superchatCount?: number;
	/** 币种 → 这一场的醒目留言总额。 */
	superchatTotals?: Record<string, number>;
	/** 会员体系 id → 档 key → 这一场的新增会员数。 */
	membershipCounts?: Record<string, Record<string, number>>;
	/**
	 * 帧流读完时**仍敞开**的那一场 —— 至多一个。
	 *
	 * 「未闭合」的场次可能有好几个(每次硬杀进程留一个),但其中只有这一个有
	 * 可能是真·正在播,其余都是崩溃遗留。调用方不能靠数组位置去猜:场次按
	 * `startedAt` 认,早先的场次会被重新打开,敞开的那场未必排在末尾。
	 */
	current?: boolean;
}

/** 「在记」账里的三项:作品、直播、粉丝(ADR-0027 决策 2)。 */
export type RecordingKind = "posts" | "live" | "followers";

/**
 * 「在记」小账的一行(ADR-0027 决策 13):`kind` 这一项从 `startedAt` 到 `endedAt`(ISO,左闭右开)一直在记。
 * 记录器写的每一行正好是一个 UTC 整点小时;读的一方吃任意长度的区间(迁移直接写合好的长区间,压缩也会把相邻的合成长区间),
 * 对重复与重叠不在乎。读的时候按请求的时区切天:那天与任何一段区间有交集,这一项那天就算在记。
 */
export interface RecordingEntry {
	kind: RecordingKind;
	startedAt: string;
	endedAt: string;
}

/** 落盘的单帧(新写的形状)。读时按顺序配对成 {@link LiveSessionEntry}。 */
interface LiveFrame {
	kind: "start" | "end";
	occurredAt: string;
	title?: string;
	category?: string;
	/** 本场累计观看。 */
	peakTotalViewers?: number;
	viewerChatCount?: number;
	viewerChatSenderCount?: number;
	superchatCount?: number;
	superchatTotals?: Record<string, number>;
	membershipCounts?: Record<string, Record<string, number>>;
}

export interface StatsStore {
	/** 追加一条作品。同一个键下同 id 重复调用只保留首条(动态轮询重放不虚增计数)。 */
	appendPost(key: string, event: PostEntry): Promise<void>;
	/**
	 * 读回 publishedAt >= sinceIso 的作品行,按落盘顺序;同 id 只留先落盘的那条。
	 */
	listPosts(key: string, sinceIso: string): Promise<PostEntry[]>;
	/**
	 * 最近 `limit` 条作品,按 `publishedAt` 从新到旧,同 id 只留先落盘的那条;`limit` 不是正整数回空。
	 * 今天没有调用方(3b 的 `get_creator_posts` 用)。
	 */
	listRecentPosts(key: string, limit: number): Promise<PostEntry[]>;
	/** 记一帧开播。 */
	openLiveSession(key: string, start: LiveSessionStart): Promise<void>;
	/** 记一帧下播,可带本场累计观看与五格互动汇总(坏格不落)。 */
	closeLiveSession(key: string, close: LiveSessionClose): Promise<void>;
	/** 配对后返回开播时间 >= sinceIso 的场次,按开播时间顺序。 */
	listLiveSessions(key: string, sinceIso: string): Promise<LiveSessionEntry[]>;
	/** 追加一行「在记」。不去重 —— 同一小时同一项只写一行是记录器的事。 */
	appendRecording(key: string, entry: RecordingEntry): Promise<void>;
	/** 读回结束时刻晚于 `sinceIso` 的「在记」行(与 `since` 之后有交集的),按落盘顺序;坏行跳过。`""` 读全部。 */
	listRecording(key: string, sinceIso: string): Promise<RecordingEntry[]>;
	/** 盘上有「在记」账文件的键(订阅 id)。目录还没建回空。 */
	recordingKeys(): Promise<string[]>;
	/** 盘上有作品、直播场次或「在记」账文件的键(三个目录的并集,订阅 id)。整类清空要对每个键各删一次。 */
	keys(): Promise<string[]>;
	/**
	 * 压缩这个键的账:读整份 → 逐行解析(坏行丢掉并计数)→ {@link compressRecordingEntries} → 与原来逐行相同就什么都不写,
	 * 不同就原子换名写回。文件不在回全 0;读不动抛。
	 *
	 * ⚠️ **与账的追加互斥归调用方**:仓自己不排队(账的追加走记录器按键的那条队),压缩读完整份、写回之前追加的行
	 * 会被换名盖掉。所以只许经记录器的 `compactRecording` 调它 —— 它把压缩排进同一个键的队里。
	 */
	compactRecording(key: string, now: Date): Promise<RecordingCompactReport>;
	/** 删除这个键的三类文件(订阅被移除时调用)。 */
	drop(key: string): Promise<void>;
}

/** 一次账压缩的结果。 */
export interface RecordingCompactReport {
	/** 压缩前认得的行数(坏行与空行不算)。 */
	rowsBefore: number;
	/** 压缩后的行数。 */
	rowsAfter: number;
	/** 丢掉的坏行数;空行不算。 */
	badLines: number;
	/** 有没有写盘。 */
	rewritten: boolean;
}

/** 读一行「在记」。返回 `undefined` = 这行不认(缺格、项不认得、起止倒置、时刻解析不了),跳过。 */
function readRecordingRow(parsed: unknown): RecordingEntry | undefined {
	const row = parsed as { kind?: unknown; startedAt?: unknown; endedAt?: unknown } | null;
	if (row?.kind !== "posts" && row?.kind !== "live" && row?.kind !== "followers") return undefined;
	if (typeof row.startedAt !== "string" || typeof row.endedAt !== "string") return undefined;
	if (!(Date.parse(row.startedAt) < Date.parse(row.endedAt))) return undefined;
	return { kind: row.kind, startedAt: row.startedAt, endedAt: row.endedAt };
}

/** 读一行作品。返回 `undefined` = 这行不认(坏行、缺格、格不对),跳过。 */
function readPostRow(parsed: unknown): PostEntry | undefined {
	const row = parsed as { id?: unknown; hasVideo?: unknown; publishedAt?: unknown } | null;
	if (typeof row?.id !== "string" || typeof row.publishedAt !== "string") return undefined;
	if (typeof row.hasVideo !== "boolean") return undefined;
	return {
		id: row.id,
		hasVideo: row.hasVideo,
		publishedAt: row.publishedAt,
		...optionalPostFields(parsed),
	};
}

/** 多收的五格:类型对的才要,类型不对就当没有这一格(行不丢)。 */
function optionalPostFields(parsed: unknown): Partial<PostEntry> {
	const row = parsed as Record<string, unknown>;
	const out: Partial<PostEntry> = {};
	if (typeof row.url === "string") out.url = row.url;
	if (typeof row.title === "string") out.title = row.title;
	if (typeof row.summary === "string") out.summary = row.summary;
	if (typeof row.topic === "string") out.topic = row.topic;
	if (typeof row.videoDurationSec === "number" && Number.isFinite(row.videoDurationSec)) {
		out.videoDurationSec = row.videoDurationSec;
	}
	return out;
}

type LiveStartExtras = Pick<LiveSessionEntry, "title" | "category">;
type LiveCloseExtras = Pick<
	LiveSessionEntry,
	| "viewerChatCount"
	| "viewerChatSenderCount"
	| "superchatCount"
	| "superchatTotals"
	| "membershipCounts"
>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function finiteNonNegativeEntries(value: unknown): Array<[string, number]> {
	if (!isRecord(value)) return [];
	return Object.entries(value).filter((entry): entry is [string, number] =>
		isFiniteNonNegative(entry[1]),
	);
}

/** 多收的开播两格:字符串才要,坏的格单独丢掉。 */
function liveStartExtras(parsed: unknown): LiveStartExtras {
	if (!isRecord(parsed)) return {};
	const out: LiveStartExtras = {};
	if (typeof parsed.title === "string") out.title = parsed.title;
	if (typeof parsed.category === "string") out.category = parsed.category;
	return out;
}

/** 多收的下播五格:计数只收有限的非负数,汇总逐键过滤并用无原型风险的方式重建。 */
function liveCloseExtras(parsed: unknown): LiveCloseExtras {
	if (!isRecord(parsed)) return {};
	const out: LiveCloseExtras = {};
	if (isFiniteNonNegative(parsed.viewerChatCount)) {
		out.viewerChatCount = parsed.viewerChatCount;
	}
	if (isFiniteNonNegative(parsed.viewerChatSenderCount)) {
		out.viewerChatSenderCount = parsed.viewerChatSenderCount;
	}
	if (isFiniteNonNegative(parsed.superchatCount)) out.superchatCount = parsed.superchatCount;
	if (isRecord(parsed.superchatTotals)) {
		out.superchatTotals = Object.fromEntries(finiteNonNegativeEntries(parsed.superchatTotals));
	}
	if (isRecord(parsed.membershipCounts)) {
		const programs: Array<[string, Record<string, number>]> = [];
		for (const [program, tiers] of Object.entries(parsed.membershipCounts)) {
			if (!isRecord(tiers)) continue;
			programs.push([program, Object.fromEntries(finiteNonNegativeEntries(tiers))]);
		}
		out.membershipCounts = Object.fromEntries(programs);
	}
	return out;
}

/** 两段计数相加;后一段没报就保留前一段(「没报」不是零)。 */
function addCount(previous: number | undefined, next: number | undefined): number | undefined {
	if (next === undefined) return previous;
	return (previous ?? 0) + next;
}

/** 两段取最大;后一段没报就保留前一段。 */
function maxCount(previous: number | undefined, next: number | undefined): number | undefined {
	if (previous === undefined) return next;
	if (next === undefined) return previous;
	return Math.max(previous, next);
}

/**
 * 按外来字符串键逐键相加(币种、会员体系 id、档 key)。用 `Map` 累加再转回对象:键是外来数据,
 * 普通对象上 `constructor` 会读到原型里的函数(与收集器里的两张表同一条规矩)。
 */
function addCountMap(
	previous: Record<string, number> | undefined,
	next: Record<string, number>,
): Record<string, number> {
	const sums = new Map<string, number>(Object.entries(previous ?? {}));
	for (const [key, count] of Object.entries(next)) {
		sums.set(key, (sums.get(key) ?? 0) + count);
	}
	return Object.fromEntries(sums);
}

/** 按体系 → 按档逐键相加。 */
function addMembershipCounts(
	previous: Record<string, Record<string, number>> | undefined,
	next: Record<string, Record<string, number>>,
): Record<string, Record<string, number>> {
	const programs = new Map<string, Map<string, number>>();
	for (const [program, tiers] of Object.entries(previous ?? {})) {
		programs.set(program, new Map(Object.entries(tiers)));
	}
	for (const [program, tiers] of Object.entries(next)) {
		const merged = programs.get(program) ?? new Map<string, number>();
		for (const [tier, count] of Object.entries(tiers)) {
			merged.set(tier, (merged.get(tier) ?? 0) + count);
		}
		programs.set(program, merged);
	}
	return Object.fromEntries(
		[...programs].map(([program, tiers]) => [program, Object.fromEntries(tiers)]),
	);
}

/**
 * 同一场直播的第二帧(及以后)的下播帧怎么并进已记下的那一场:一场被重启切成几段时,每段各写一帧
 * end,各段的计数互不重叠,所以 ——
 *
 * - `viewerChatCount` / `superchatCount`:相加;
 * - `superchatTotals`(按币种)、`membershipCounts`(按体系 → 按档):逐键相加;
 * - `viewerChatSenderCount`:取各段**最大值**。跨段去重没法精确(统计不收观众名单),相加会把两段都
 *   发过言的人算两次,取最大只会少报;
 * - `peakTotalViewers`:取最大 —— 它是本场累计观看,只增不减(ADR-0020 决策 7)。接回之后那一段是从
 *   重新认出这一场才开始取的:平台这回少报了、或压根没报,都不该把前一段已经记下的数拽下去
 *   (没带的帧本来就不动它);
 * - `endedAt`:取最后一帧;
 * - 后一帧没有的格保留前一帧的值(相加语义下本来就对)。
 */
function mergeLiveClose(open: LiveSessionEntry, occurredAt: string, parsed: unknown): void {
	open.endedAt = occurredAt;
	const extras = liveCloseExtras(parsed);
	open.viewerChatCount = addCount(open.viewerChatCount, extras.viewerChatCount);
	open.superchatCount = addCount(open.superchatCount, extras.superchatCount);
	open.viewerChatSenderCount = maxCount(open.viewerChatSenderCount, extras.viewerChatSenderCount);
	if (extras.superchatTotals) {
		open.superchatTotals = addCountMap(open.superchatTotals, extras.superchatTotals);
	}
	if (extras.membershipCounts) {
		open.membershipCounts = addMembershipCounts(open.membershipCounts, extras.membershipCounts);
	}
	const peak = isRecord(parsed) ? parsed.peakTotalViewers : undefined;
	if (typeof peak === "number") {
		open.peakTotalViewers =
			open.peakTotalViewers === undefined ? peak : Math.max(open.peakTotalViewers, peak);
	}
}

/**
 * 两类文件各住的目录(数据根下的路径段,展开进 `dataPath`)。开机迁移认的也是这两处,别各写一份。
 * 写成元组而不是拼好的串,是为了让第一段能被 `dataPath` 的类型认出是目录表里的键。
 */
export const STATS_POSTS_DIR = ["stats", "posts"] as const;
export const STATS_LIVE_DIR = ["stats", "live"] as const;
/** 「在记」小账住的目录。从一开始就按订阅 id 命名,开机迁移不认它(迁移自己写它)。 */
export const STATS_RECORDING_DIR = ["stats", "recording"] as const;

export interface CreateStatsStoreOptions {
	dataRoot: string;
	logger: Logger;
	/** 注入时钟,测试用;缺省取系统时间。 */
	now?: () => Date;
}

export function createStatsStore(opts: CreateStatsStoreOptions): StatsStore {
	const postsRoot = dataPath(opts.dataRoot, ...STATS_POSTS_DIR);
	const liveRoot = dataPath(opts.dataRoot, ...STATS_LIVE_DIR);
	const recordingRoot = dataPath(opts.dataRoot, ...STATS_RECORDING_DIR);
	let ensured = false;

	async function ensureRoots(): Promise<void> {
		if (ensured) return;
		await mkdir(postsRoot, { recursive: true });
		await mkdir(liveRoot, { recursive: true });
		await mkdir(recordingRoot, { recursive: true });
		ensured = true;
	}

	const postsFile = (key: string) => join(postsRoot, `${key}.jsonl`);
	const liveFile = (key: string) => join(liveRoot, `${key}.jsonl`);
	const recordingFile = (key: string) => join(recordingRoot, `${key}.jsonl`);

	/**
	 * 逐行流式读一个 jsonl,把每行交给 `onLine`。文件不存在是正常情况
	 * (这个键还没有任何记录),静默返回而不 warn —— 与 FollowersStore 一致。
	 */
	async function readLines(file: string, onLine: (parsed: unknown) => void): Promise<void> {
		try {
			const stream = createReadStream(file, { encoding: "utf-8" });
			const reader = createInterface({ input: stream });
			for await (const raw of reader) {
				const line = raw.trim();
				if (!line) continue;
				try {
					onLine(JSON.parse(line));
				} catch {
					/* skip malformed line */
				}
			}
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
				opts.logger.warn(`[stats-store] read ${file} failed: ${String(err)}`);
			}
		}
	}

	async function appendLine(file: string, value: unknown, what: string): Promise<void> {
		try {
			await appendJsonl(file, [value]);
		} catch (err) {
			opts.logger.warn(`[stats-store] append ${what} failed: ${String(err)}`);
		}
	}

	/**
	 * 读回这个键的全部作品行,同 id 只留先落盘的那条。
	 *
	 * append 那头已经按 id 挡过一道,读这头还要再挡一道:append 是「先读再追加」,挡不住
	 * 两个版本各写各的 —— 0.x 里旧版的去重只认得带 `type` 的老行、看不见新行的 id,而
	 * 0.x 的动态事件又不保证只发一次(进程崩在两轮之间、或本轮整轮抛错,下一轮重判重发)。0.x 之间降级跑过
	 * 一阵再升级回来,同一条作品在盘上就有两行,迁移器翻完行也还是两行,不去重的话计数全部翻倍。
	 */
	async function readPosts(key: string): Promise<PostEntry[]> {
		const posts: PostEntry[] = [];
		const ids = new Set<string>();
		await readLines(postsFile(key), (parsed) => {
			const post = readPostRow(parsed);
			if (!post || ids.has(post.id)) return;
			ids.add(post.id);
			posts.push(post);
		});
		return posts;
	}

	async function unlinkQuiet(file: string): Promise<void> {
		try {
			await unlink(file);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
				opts.logger.warn(`[stats-store] drop ${file} failed: ${String(err)}`);
			}
		}
	}

	/** 一个目录里的键(`<键>.jsonl` 的键,不含改名换写的临时残留);目录还没建回空。 */
	async function keysIn(root: string): Promise<string[]> {
		let names: string[];
		try {
			names = await readdir(root);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw err;
		}
		return names
			.filter((name) => name.endsWith(".jsonl") && !isLeftoverName(name))
			.map((name) => name.slice(0, -".jsonl".length));
	}

	return {
		async appendPost(key, event) {
			await ensureRoots();
			// 幂等靠读时去重代价更低,但那样 jsonl 会无限增长且 listPosts 每次
			// 都要建 Set;动态写入频率极低(一轮 cron 至多几条),这里直接读一遍
			// 现有 id 挡掉重复,换取文件本身就是干净的。
			const existing = await readPosts(key);
			if (existing.some((e) => e.id === event.id)) return;
			// 只写定义好的这些格:行格式是契约(决策 16),调用方对象上多带的东西不许漏进盘;多收的五格没有就不写。
			const row: PostEntry = {
				id: event.id,
				hasVideo: event.hasVideo,
				publishedAt: event.publishedAt,
				...optionalPostFields(event),
			};
			await appendLine(postsFile(key), row, `posts ${key}`);
		},

		async listPosts(key, sinceIso) {
			await ensureRoots();
			const all = await readPosts(key);
			return all.filter((e) => e.publishedAt >= sinceIso);
		},

		async listRecentPosts(key, limit) {
			if (!Number.isInteger(limit) || limit <= 0) return [];
			await ensureRoots();
			const all = await readPosts(key);
			// 稳定排序:发布时刻相同的保持落盘顺序。
			return [...all]
				.sort((a, b) =>
					a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : 0,
				)
				.slice(0, limit);
		},

		async openLiveSession(key, start) {
			await ensureRoots();
			const frame: LiveFrame = { kind: "start", occurredAt: start.startedAt };
			Object.assign(frame, liveStartExtras(start));
			await appendLine(liveFile(key), frame satisfies LiveFrame, `live ${key}`);
		},

		async closeLiveSession(key, close) {
			await ensureRoots();
			const frame: LiveFrame = { kind: "end", occurredAt: close.endedAt };
			// NaN / Infinity 进 JSON 会变成 null,不落这种东西。
			if (close.peakTotalViewers !== undefined && Number.isFinite(close.peakTotalViewers)) {
				frame.peakTotalViewers = close.peakTotalViewers;
			}
			Object.assign(frame, liveCloseExtras(close));
			await appendLine(liveFile(key), frame, `live ${key}`);
		},

		async listLiveSessions(key, sinceIso) {
			await ensureRoots();
			const sessions: LiveSessionEntry[] = [];
			// 配对:start 开一场并立即入列(所以未闭合的场次也留得住),随后的
			// end 就近闭合最后一场未闭合的。孤立的 end 无处可挂 → 丢弃,绝不
			// 凭空造一场只有下播时间的「半场」出来污染场次数。
			//
			// **一场直播由 `startedAt` 唯一标识**,而不是由「读到第几帧」决定。
			// 上游给的是 B 站的真实 `live_time`,同一场无论被观测到多少次都是同一个
			// 值;而一次直播期间可能写下任意多帧 start(每次重启一帧)与多帧 end
			// (关服截断一帧、真下播一帧)。曾经只比对「当前敞开的那场」,于是
			// 「end 之后又来一帧同时刻 start」会凭空开出第二场 —— 线上真出现过,
			// 一场直播被记成三场。
			//
			// 下播帧按顺序并进这一场:重启 / 关服把一场切成几段时每段各写一帧 end,计数与按币种 /
			// 按体系档的汇总逐键相加,发弹幕人数取各段最大值,峰值取最大,下播时刻取最后一帧 ——
			// 细则见 {@link mergeLiveClose}。
			const byStart = new Map<string, LiveSessionEntry>();
			let open: LiveSessionEntry | undefined;
			await readLines(liveFile(key), (parsed) => {
				if (!isRecord(parsed)) return;
				const kind = parsed.kind;
				const occurredAt = parsed.occurredAt;
				if (typeof occurredAt !== "string") return;
				if (kind === "start") {
					const seen = byStart.get(occurredAt);
					if (seen) {
						// 这一场又被观测到了。重新挂成 open,后续的 end 会把下播时间
						// 覆盖成更晚的那个 —— 关服截断的 end 因此能被真下播时间修正。
						// `endedAt` 刻意**留着**:帧序 start/end/start 有两种可能 ——
						// 关服截断后重启再观测(这一场还在播),或真下播后又写了一帧同
						// 时刻的 start(这一场已结束)。盘上的帧分不出这两者,唯一知道
						// 真相的是引擎的 isLive,所以这里只如实记「最后一次观测时它敞着」
						// (下面打 `current`),该怎么算交给 aggregate 结合 isLive 定夺。
						Object.assign(seen, liveStartExtras(parsed));
						open = seen;
						return;
					}
					open = { startedAt: occurredAt, ...liveStartExtras(parsed) };
					byStart.set(occurredAt, open);
					sessions.push(open);
					return;
				}
				if (kind !== "end" || !open) return;
				mergeLiveClose(open, occurredAt, parsed);
				open = undefined;
			});
			// 读完仍挂着的那场 = 最后一次观测时它是敞着的,也就是唯一可能在播的那场。
			// 标出来,免得调用方靠数组位置猜 —— 场次按 startedAt 认之后它未必排在末尾。
			//
			// 不再要求 `!open.endedAt`:关服补的那帧 end 会留在记录上,但紧随其后的
			// start 说明重启时它还在播。带着 endedAt 也照样打 `current`,由 aggregate
			// 拿引擎的 isLive 拍板 —— 曾经这里卡着 `!open.endedAt`,于是「直播中重启」
			// 这条最常见的路径上时长被永久冻结在关服那一刻。
			if (open) open.current = true;
			// `current` 那一场无论起于何时都要留下 —— 它就是「此刻可能正在播」的那场,
			// 前端同一行正亮着直播中徽章。单按 startedAt 滤的话,跨窗口起始的挂机直播
			// 会整场消失,而 hasCoverage 仍为真,于是「直播场次 0 / 直播时长 0.0h」与
			// 徽章在同一行里互相打脸,AI 锐评也被告知这位 UP 一场没播。
			// 窗口之前的那段时长由 aggregate 的 sinceMs 夹掉,不会记到本窗口头上。
			return sessions.filter((s) => s.current === true || s.startedAt >= sinceIso);
		},

		async appendRecording(key, entry) {
			await ensureRoots();
			// 只写这三格:行格式是契约,调用方对象上多带的东西不许漏进盘。
			const row: RecordingEntry = {
				kind: entry.kind,
				startedAt: entry.startedAt,
				endedAt: entry.endedAt,
			};
			await appendLine(recordingFile(key), row, `recording ${key}`);
		},

		async listRecording(key, sinceIso) {
			await ensureRoots();
			const rows: RecordingEntry[] = [];
			await readLines(recordingFile(key), (parsed) => {
				const row = readRecordingRow(parsed);
				if (row && row.endedAt > sinceIso) rows.push(row);
			});
			return rows;
		},

		recordingKeys: () => keysIn(recordingRoot),

		async keys() {
			const all = await Promise.all([postsRoot, liveRoot, recordingRoot].map(keysIn));
			return [...new Set(all.flat())];
		},

		async compactRecording(key, now) {
			let text: string;
			try {
				text = await readFile(recordingFile(key), "utf8");
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") {
					return { rowsBefore: 0, rowsAfter: 0, badLines: 0, rewritten: false };
				}
				throw err;
			}
			const originalLines = text.split("\n").filter((line) => line.trim() !== "");
			const rows: RecordingEntry[] = [];
			let badLines = 0;
			for (const line of originalLines) {
				let row: RecordingEntry | undefined;
				try {
					row = readRecordingRow(JSON.parse(line));
				} catch {
					row = undefined;
				}
				if (row) rows.push(row);
				else badLines += 1;
			}
			const compressed = compressRecordingEntries(rows, now);
			const nextLines = compressed.map((row) => JSON.stringify(row));
			const same =
				badLines === 0 &&
				nextLines.length === originalLines.length &&
				nextLines.every((line, i) => line === originalLines[i]?.trim());
			if (badLines > 0) {
				opts.logger.warn(`[stats-store] compact recording ${key} dropped ${badLines} bad line(s)`);
			}
			if (!same) {
				await atomicWriteFile(
					recordingFile(key),
					nextLines.length === 0 ? "" : `${nextLines.join("\n")}\n`,
				);
			}
			return { rowsBefore: rows.length, rowsAfter: compressed.length, badLines, rewritten: !same };
		},

		async drop(key) {
			await unlinkQuiet(postsFile(key));
			await unlinkQuiet(liveFile(key));
			await unlinkQuiet(recordingFile(key));
		},
	};
}
