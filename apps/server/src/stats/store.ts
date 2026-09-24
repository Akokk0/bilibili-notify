import { createReadStream } from "node:fs";
import { appendFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Logger } from "@bilibili-notify/internal";
import { classifyBiliDynamic, parseBiliViewers } from "./bili-format.js";

/**
 * 按订阅分文件的「UP 产出」时序持久化 —— 数据统计页 Tab 的原始数据源。
 *
 * 文件布局(`<key>` 是 {@link statsFileKey}:两支都是订阅 id):
 *   `<dataDir>/stats/dyn/<key>.jsonl`   每行一条 {@link UpDynamicEvent}
 *   `<dataDir>/stats/live/<key>.jsonl`  每行一帧 {@link LiveFrame}
 * 老版本的 B 站文件叫 `<uid>.jsonl`,开机迁移把它们并进订阅 id 那份(`migrate-file-keys.ts`)。
 *
 * **盘上的行是中立的**(ADR-0020 决策 16):作品行记 `video` / `post` / `live`,峰值存数字。平台的
 * 写法由各来源的适配在交进来之前翻好;这一层唯一认得 B 站写法的地方是下面的「老 B 站行的
 * 翻译」,只给改之前落盘的老行用 —— 老数据不迁移,读的时候翻。
 *
 * 与 FansStore 同构:append-only、逐行 JSON、坏行跳过、缺文件视为空。区别在于
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

/** 算「作品」的两种:`video` = 发了视频(「投稿」),`post` = 其余(「动态」)。 */
export type StatsPostKind = "video" | "post";

/**
 * 作品行的种类 = 作品两种 + `live`。
 *
 * `live` = 动态流里出现了一条**开播公告**(ADR-0020 决策 5 的第二个 🔗)。它从来不算作品
 * (投稿 / 动态 / 热力图都不计,直播按场次另算),但它是「最后活动」与「那天有记录」的
 * 证据 —— 没开直播类推送的 B 站 UP 不记场次,开播公告是他开过播的唯一痕迹。只有 B 站
 * 产这一种;拓展的场次与推送开关无关、总会记,用不着它。
 */
export type StatsFeedKind = StatsPostKind | "live";

/** 一条作品行。 */
export interface UpDynamicEvent {
	/** 平台给的作品 id(B 站是动态 id_str);同一个键下的幂等键。 */
	id: string;
	/** 中立种类。分类由各来源自己做(ADR-0020 决策 5 的 🔗),这一层不认平台类型。 */
	kind: StatsFeedKind;
	/** 发布时间(ISO)。 */
	ts: string;
}

/** 配对后的一场直播。`endedAt` 缺失 = 仍在直播或 end 帧丢失,不计入时长。 */
export interface LiveSessionRecord {
	startedAt: string;
	endedAt?: string;
	/**
	 * 本场累计观看(看过的人数,ADR-0020 决策 7);未采到时缺失。老 B 站行的字符串读的时候
	 * 已经解析成数字。
	 */
	peakViewers?: number;
	/**
	 * 帧流读完时**仍敞开**的那一场 —— 至多一个。
	 *
	 * 「未闭合」的场次可能有好几个(每次硬杀进程留一个),但其中只有这一个有
	 * 可能是真·正在播,其余都是崩溃遗留。调用方不能靠数组位置去猜:场次按
	 * `startedAt` 认,早先的场次会被重新打开,敞开的那场未必排在末尾。
	 */
	current?: boolean;
}

/** 落盘的单帧(新写的形状)。读时按顺序配对成 {@link LiveSessionRecord}。 */
interface LiveFrame {
	k: "start" | "end";
	ts: string;
	/** 本场累计观看。老 B 站帧这里是字符串,见 {@link fromLegacyBiliPeak}。 */
	peak?: number;
}

export interface StatsStore {
	/** 追加一条作品。同一个键下同 id 重复调用只保留首条(引擎重放不虚增计数),新老行都算。 */
	appendDynamic(key: string, event: UpDynamicEvent): Promise<void>;
	/**
	 * 读回 ts >= sinceIso 的作品行,按落盘顺序;同 id 只留先落盘的那条。老 B 站行已翻成
	 * 中立种类(开播公告是 `live`,调用方自己决定它算不算作品)。
	 */
	listDynamics(key: string, sinceIso: string): Promise<UpDynamicEvent[]>;
	/** 记一帧开播。 */
	openLiveSession(key: string, startedAtIso: string): Promise<void>;
	/** 记一帧下播,可带本场累计观看(不是有限数就不带)。 */
	closeLiveSession(key: string, endedAtIso: string, peakViewers?: number): Promise<void>;
	/** 配对后返回开播时间 >= sinceIso 的场次,按开播时间顺序。 */
	listLiveSessions(key: string, sinceIso: string): Promise<LiveSessionRecord[]>;
	/**
	 * 活动采集的起始时刻(ISO)。首次建库时落盘,此后恒定。
	 *
	 * 存在的理由:活动是「有事才留痕」的稀疏数据,**没有记录**与**没在记录**在
	 * 盘上长得一模一样。粉丝采样又比统计功能上线得早,拿它当「我们当时在看着」
	 * 的证据,会把统计上线之前的日子一律判成「活跃度 0」——等于向用户断言
	 * 「这位 UP 那天什么都没发」。这条水位线就是用来把那段日子还原成「无记录」的。
	 */
	recordingSince(): Promise<string>;
	/** 删除这个键的两类文件(订阅被移除时调用)。 */
	drop(key: string): Promise<void>;
}

// ── 老 B 站行的翻译 ─────────────────────────────────────────────────────────────
//
// 这一层**唯一**认得 B 站写法的地方,而且只给改之前落盘的老行用(ADR-0020 决策 5 / 7 的 🔗:
// 老数据不迁移,读的时候照原来的规矩翻)。新写的行一律是中立的,平台的写法归各来源的适配。
// 规矩本身与 B 站适配共用 `bili-format` 那一份,两边不会各翻各的。

/** 老作品行 `{id, type, ts}` 的 `type` → 中立种类(开播那两种 → `live`)。 */
function fromLegacyBiliPostType(type: string): StatsFeedKind {
	return classifyBiliDynamic(type);
}

/** 老下播帧的字符串峰值("1.2万")→ 数字;解析不出 → `undefined`(这一场当没采到)。 */
function fromLegacyBiliPeak(raw: string): number | undefined {
	const n = parseBiliViewers(raw);
	return Number.isFinite(n) ? n : undefined;
}

// ────────────────────────────────────────────────────────────────────────────────

const FEED_KINDS: ReadonlySet<unknown> = new Set<StatsFeedKind>(["video", "post", "live"]);

/** 读一行作品。返回 `undefined` = 这行不认(坏行、种类不认识),跳过。 */
function readPostRow(parsed: unknown): UpDynamicEvent | undefined {
	const row = parsed as { id?: unknown; kind?: unknown; type?: unknown; ts?: unknown } | null;
	if (typeof row?.id !== "string" || typeof row.ts !== "string") return undefined;
	if (FEED_KINDS.has(row.kind)) {
		return { id: row.id, kind: row.kind as StatsFeedKind, ts: row.ts };
	}
	// 没有 kind、带着 type 串的是改之前写的老 B 站行。
	if (row.kind === undefined && typeof row.type === "string") {
		return { id: row.id, kind: fromLegacyBiliPostType(row.type), ts: row.ts };
	}
	return undefined;
}

/**
 * 读一帧的峰值:数字原样收(新帧),字符串按老 B 站写法解析(老帧)。
 * 返回 `"absent"` = 这帧没带峰值(或带的是认不得的形状),不动这一场已有的峰值。
 */
function readFramePeak(peak: unknown): number | undefined | "absent" {
	if (typeof peak === "number") return Number.isFinite(peak) ? peak : undefined;
	if (typeof peak === "string") return fromLegacyBiliPeak(peak);
	return "absent";
}

/** 两类文件各住的目录(相对 dataDir)。开机迁移认的也是这两处,别各写一份。 */
export const STATS_DYN_DIR = join("stats", "dyn");
export const STATS_LIVE_DIR = join("stats", "live");

export interface CreateStatsStoreOptions {
	dataDir: string;
	logger: Logger;
	/** 注入时钟,测试用;缺省取系统时间。 */
	now?: () => Date;
}

export function createStatsStore(opts: CreateStatsStoreOptions): StatsStore {
	const statsRoot = join(opts.dataDir, "stats");
	const dynRoot = join(opts.dataDir, STATS_DYN_DIR);
	const liveRoot = join(opts.dataDir, STATS_LIVE_DIR);
	const sinceFile = join(statsRoot, "since");
	const now = opts.now ?? (() => new Date());
	let ensured = false;
	/** 进程内缓存 —— 水位线一旦定下就不再变,每次 overview 没必要重读。 */
	let sinceCache: string | undefined;

	async function ensureRoots(): Promise<void> {
		if (ensured) return;
		await mkdir(dynRoot, { recursive: true });
		await mkdir(liveRoot, { recursive: true });
		ensured = true;
	}

	/**
	 * 读水位线,没有就以「此刻」建一个。
	 *
	 * 老库(统计功能上线前就存在的 dataDir)没有这个文件,补写的是升级那一刻而非
	 * 真实起始 —— 但比较按**本地日**做,所以只会影响升级当天之前的日子,而那些
	 * 日子本来就没有活动数据,判成「无记录」正是我们要的。
	 */
	async function readSince(): Promise<string> {
		if (sinceCache) return sinceCache;
		await ensureRoots();
		try {
			const raw = (await readFile(sinceFile, "utf-8")).trim();
			if (raw && Number.isFinite(Date.parse(raw))) {
				sinceCache = raw;
				return raw;
			}
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
				opts.logger.warn(`[stats-store] read since failed: ${String(err)}`);
			}
		}
		const stamp = now().toISOString();
		try {
			await writeFile(sinceFile, stamp, "utf-8");
		} catch (err) {
			// 写不进去不致命:这次按「此刻」处理,下次再试。
			opts.logger.warn(`[stats-store] write since failed: ${String(err)}`);
		}
		sinceCache = stamp;
		return stamp;
	}

	const dynFile = (key: string) => join(dynRoot, `${key}.jsonl`);
	const liveFile = (key: string) => join(liveRoot, `${key}.jsonl`);

	/**
	 * 逐行流式读一个 jsonl,把每行交给 `onLine`。文件不存在是正常情况
	 * (这个键还没有任何记录),静默返回而不 warn —— 与 FansStore 一致。
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
			await appendFile(file, `${JSON.stringify(value)}\n`, "utf-8");
		} catch (err) {
			opts.logger.warn(`[stats-store] append ${what} failed: ${String(err)}`);
		}
	}

	/**
	 * 读回这个键的全部作品行,同 id 只留先落盘的那条。
	 *
	 * append 那头已经按 id 挡过一道,读这头还要再挡一道:append 是「先读再追加」,挡不住
	 * 两个版本各写各的 —— 旧版的去重只认得带 `type` 的老行、看不见新行的 id,而
	 * `dynamic-detected` 又不保证只发一次(投递失败走 markFail,下轮重发)。降级跑过一阵
	 * 再升级回来,同一条作品在盘上就有两行,不去重的话计数全部翻倍。
	 */
	async function readDynamics(key: string): Promise<UpDynamicEvent[]> {
		const posts: UpDynamicEvent[] = [];
		const ids = new Set<string>();
		await readLines(dynFile(key), (parsed) => {
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

	return {
		async appendDynamic(key, event) {
			await ensureRoots();
			// 幂等靠读时去重代价更低,但那样 jsonl 会无限增长且 listDynamics 每次
			// 都要建 Set;动态写入频率极低(一轮 cron 至多几条),这里直接读一遍
			// 现有 id 挡掉重复,换取文件本身就是干净的。新老两种行的 id 一起算。
			const existing = await readDynamics(key);
			if (existing.some((e) => e.id === event.id)) return;
			// 只写这三格:行格式是契约(决策 16),调用方对象上多带的东西不许漏进盘。
			const row: UpDynamicEvent = { id: event.id, kind: event.kind, ts: event.ts };
			await appendLine(dynFile(key), row, `dyn ${key}`);
		},

		async listDynamics(key, sinceIso) {
			await ensureRoots();
			const all = await readDynamics(key);
			return all.filter((e) => e.ts >= sinceIso);
		},

		async openLiveSession(key, startedAtIso) {
			await ensureRoots();
			await appendLine(liveFile(key), { k: "start", ts: startedAtIso }, `live ${key}`);
		},

		async closeLiveSession(key, endedAtIso, peakViewers) {
			await ensureRoots();
			const frame: LiveFrame = { k: "end", ts: endedAtIso };
			// NaN / Infinity 进 JSON 会变成 null,不落这种东西。
			if (peakViewers !== undefined && Number.isFinite(peakViewers)) frame.peak = peakViewers;
			await appendLine(liveFile(key), frame, `live ${key}`);
		},

		async listLiveSessions(key, sinceIso) {
			await ensureRoots();
			const sessions: LiveSessionRecord[] = [];
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
			const byStart = new Map<string, LiveSessionRecord>();
			let open: LiveSessionRecord | undefined;
			await readLines(liveFile(key), (parsed) => {
				const f = parsed as { k?: unknown; ts?: unknown; peak?: unknown } | null;
				if (typeof f?.ts !== "string") return;
				if (f.k === "start") {
					const seen = byStart.get(f.ts);
					if (seen) {
						// 这一场又被观测到了。重新挂成 open,后续的 end 会把下播时间
						// 覆盖成更晚的那个 —— 关服截断的 end 因此能被真下播时间修正。
						// `endedAt` 刻意**留着**:帧序 start/end/start 有两种可能 ——
						// 关服截断后重启再观测(这一场还在播),或真下播后又写了一帧同
						// 时刻的 start(这一场已结束)。盘上的帧分不出这两者,唯一知道
						// 真相的是引擎的 isLive,所以这里只如实记「最后一次观测时它敞着」
						// (下面打 `current`),该怎么算交给 aggregate 结合 isLive 定夺。
						open = seen;
						return;
					}
					open = { startedAt: f.ts };
					byStart.set(f.ts, open);
					sessions.push(open);
					return;
				}
				if (f.k !== "end" || !open) return;
				open.endedAt = f.ts;
				// 带了峰值的 end 帧**盖掉**这一场先前的峰值(接回同一场时,后一帧是更晚的观测)——
				// 解析不出的老字符串也照盖,这一场于是当没采到:与改之前「字符串原样盖上、
				// aggregate 解析失败就跳过」同一个结果。
				const peak = readFramePeak(f.peak);
				if (peak === undefined) delete open.peakViewers;
				else if (peak !== "absent") open.peakViewers = peak;
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

		recordingSince: readSince,

		async drop(key) {
			await unlinkQuiet(dynFile(key));
			await unlinkQuiet(liveFile(key));
		},
	};
}
