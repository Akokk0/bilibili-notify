import { createReadStream } from "node:fs";
import { appendFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Logger } from "@bilibili-notify/internal";

/**
 * Per-UID 的「UP 产出」时序持久化 —— 数据统计页 Tab 的原始数据源。
 *
 * 文件布局:
 *   `<dataDir>/stats/dyn/<uid>.jsonl`   每行一条 {@link UpDynamicEvent}
 *   `<dataDir>/stats/live/<uid>.jsonl`  每行一帧 {@link LiveFrame}
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
export interface UpDynamicEvent {
	/** B 站动态 id_str;同时作为幂等键。 */
	id: string;
	/** B 站原始动态类型,未做语义归类(归类策略在 aggregate 层)。 */
	type: string;
	/** 发布时间(ISO)。 */
	ts: string;
}

/** 配对后的一场直播。`endedAt` 缺失 = 仍在直播或 end 帧丢失,不计入时长。 */
export interface LiveSessionRecord {
	startedAt: string;
	endedAt?: string;
	/** B 站预格式化的累计观看字符串(如 "1.2万");未采到时缺失。 */
	peakViewers?: string;
	/**
	 * 帧流读完时**仍敞开**的那一场 —— 至多一个。
	 *
	 * 「未闭合」的场次可能有好几个(每次硬杀进程留一个),但其中只有这一个有
	 * 可能是真·正在播,其余都是崩溃遗留。调用方不能靠数组位置去猜:场次按
	 * `startedAt` 认,早先的场次会被重新打开,敞开的那场未必排在末尾。
	 */
	current?: boolean;
}

/** 落盘的单帧。读时按顺序配对成 {@link LiveSessionRecord}。 */
interface LiveFrame {
	k: "start" | "end";
	ts: string;
	peak?: string;
}

export interface StatsStore {
	/** 追加一条动态事件。同 id 重复调用只保留首条(引擎重放不虚增计数)。 */
	appendDynamic(uid: string, event: UpDynamicEvent): Promise<void>;
	/** 读回 ts >= sinceIso 的动态事件,按落盘顺序。 */
	listDynamics(uid: string, sinceIso: string): Promise<UpDynamicEvent[]>;
	/** 记一帧开播。 */
	openLiveSession(uid: string, startedAtIso: string): Promise<void>;
	/** 记一帧下播,可带本场峰值观看。 */
	closeLiveSession(uid: string, endedAtIso: string, peakViewers?: string): Promise<void>;
	/** 配对后返回开播时间 >= sinceIso 的场次,按开播时间顺序。 */
	listLiveSessions(uid: string, sinceIso: string): Promise<LiveSessionRecord[]>;
	/**
	 * 活动采集的起始时刻(ISO)。首次建库时落盘,此后恒定。
	 *
	 * 存在的理由:活动是「有事才留痕」的稀疏数据,**没有记录**与**没在记录**在
	 * 盘上长得一模一样。粉丝采样又比统计功能上线得早,拿它当「我们当时在看着」
	 * 的证据,会把统计上线之前的日子一律判成「活跃度 0」——等于向用户断言
	 * 「这位 UP 那天什么都没发」。这条水位线就是用来把那段日子还原成「无记录」的。
	 */
	recordingSince(): Promise<string>;
	/** 删除该 uid 的两类文件(订阅被移除时调用)。 */
	dropUid(uid: string): Promise<void>;
}

export interface CreateStatsStoreOptions {
	dataDir: string;
	logger: Logger;
	/** 注入时钟,测试用;缺省取系统时间。 */
	now?: () => Date;
}

export function createStatsStore(opts: CreateStatsStoreOptions): StatsStore {
	const statsRoot = join(opts.dataDir, "stats");
	const dynRoot = join(statsRoot, "dyn");
	const liveRoot = join(statsRoot, "live");
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

	const dynFile = (uid: string) => join(dynRoot, `${uid}.jsonl`);
	const liveFile = (uid: string) => join(liveRoot, `${uid}.jsonl`);

	/**
	 * 逐行流式读一个 jsonl,把每行交给 `onLine`。文件不存在是正常情况
	 * (该 uid 还没有任何记录),静默返回而不 warn —— 与 FansStore 一致。
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

	async function readDynamics(uid: string): Promise<UpDynamicEvent[]> {
		const out: UpDynamicEvent[] = [];
		await readLines(dynFile(uid), (parsed) => {
			const e = parsed as UpDynamicEvent;
			if (typeof e?.id !== "string" || typeof e?.type !== "string" || typeof e?.ts !== "string") {
				return;
			}
			out.push({ id: e.id, type: e.type, ts: e.ts });
		});
		return out;
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
		async appendDynamic(uid, event) {
			await ensureRoots();
			// 幂等靠读时去重代价更低,但那样 jsonl 会无限增长且 listDynamics 每次
			// 都要建 Set;动态写入频率极低(一轮 cron 至多几条),这里直接读一遍
			// 现有 id 挡掉重复,换取文件本身就是干净的。
			const existing = await readDynamics(uid);
			if (existing.some((e) => e.id === event.id)) return;
			await appendLine(dynFile(uid), event, `dyn ${uid}`);
		},

		async listDynamics(uid, sinceIso) {
			await ensureRoots();
			const all = await readDynamics(uid);
			return all.filter((e) => e.ts >= sinceIso);
		},

		async openLiveSession(uid, startedAtIso) {
			await ensureRoots();
			await appendLine(liveFile(uid), { k: "start", ts: startedAtIso }, `live ${uid}`);
		},

		async closeLiveSession(uid, endedAtIso, peakViewers) {
			await ensureRoots();
			const frame: LiveFrame = { k: "end", ts: endedAtIso };
			if (peakViewers !== undefined) frame.peak = peakViewers;
			await appendLine(liveFile(uid), frame, `live ${uid}`);
		},

		async listLiveSessions(uid, sinceIso) {
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
			await readLines(liveFile(uid), (parsed) => {
				const f = parsed as LiveFrame;
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
				if (typeof f.peak === "string") open.peakViewers = f.peak;
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

		async dropUid(uid) {
			await unlinkQuiet(dynFile(uid));
			await unlinkQuiet(liveFile(uid));
		},
	};
}
