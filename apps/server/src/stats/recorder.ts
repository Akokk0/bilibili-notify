import type { Disposable, Logger, MessageBus } from "@bilibili-notify/internal";
import type { FansStore } from "../fans/store.js";
import { attachBiliStatsSource } from "./bili-source.js";
import { attachExtensionStatsSource } from "./extension-source.js";
import type { StatsSubscription } from "./file-key.js";
import type { StatsStore, UpDynamicEvent } from "./store.js";

/**
 * 统计的采集层 = 一个**中立的记录器** + 每个来源一个**适配**(ADR-0020 决策 17)。
 *
 * - 记录器(本文件的 {@link createStatsRecorderCore})只收中立的调用:记一条作品、开一场、
 *   报本场累计观看、关一场;按**文件键**({@link statsFileKey})落进 {@link StatsStore}。
 *   它不认识任何平台,也不听总线。
 * - 适配把各来源的事件翻成这些调用,平台的规矩只写在适配里:
 *     · B 站(`bili-source.ts`):听 B 站引擎已经在总线上的三条事件,就地把类型分成
 *       `video` / `post` / `live`、把「1.2万」解析成数字,把 uid 换成订阅 id 记。引擎与总线
 *       为统计一行不改。
 *     · 拓展(`extension-source.ts`):听订阅上报与拓展直播的场次,带视频的作品记 `video`、资料里的粉丝数
 *       按 B 站粉丝轮询的间隔稀释、累计观看取本场最大,外加一条「在记」的证据。
 *
 * **写盘按键排队**:同一个键的写入一条接一条落(开播帧不会被紧跟着的下播帧抢到前面,删文件不会被还在路上的
 * 追加重新写出来),{@link StatsRecorderHandle.flush} 等得到全部落地 —— 关机补帧靠它。
 */

/** 「在记」最密多少一条(ADR-0020 决策 16):10 分钟。 */
export const STATS_SEEN_MIN_GAP_MS = 10 * 60_000;

/** 各来源适配看得到的那一面。所有写入都是 fire-and-forget,失败只丢这一条统计。 */
export interface StatsRecorderCore {
	/** 记一条作品行(含 `live` 开播公告)。同一个键下同 id 只留首条(去重在 store)。 */
	recordPost(key: string, post: UpDynamicEvent): void;
	/** 开一场。这个键在飞的累计观看清零,从这一场重新取最大值。 */
	openSession(key: string, startedAtIso: string): void;
	/** 报一次本场累计观看(看过的人数)。只留最大值;不是有限数就不收。 */
	reportViewers(key: string, cumulative: number): void;
	/**
	 * 关一场。落盘的峰值 = 这一场报过的最大累计观看与 `peak` 里较大的那个(都没有就不带)——
	 * 累计数只增不减,取大的那个就是本场最后的累计。
	 */
	closeSession(key: string, endedAtIso: string, peak?: number): void;
	/** 忘掉这个键在飞的场次与累计观看(只动内存,不动盘)。来源那头不再观测它时调。 */
	forget(key: string): void;
	/** 忘掉 + 删掉这个键的全部文件(作品、直播、「在记」、粉丝;订阅被删时调)。 */
	drop(key: string): void;
	/**
	 * 记一个粉丝数,时刻取「现在」。离这个键上一条落盘的样本(重启之前落的也算)不足 `minGapMs` 就不记 ——
	 * 留先到的那条,不密过来源给的间隔。
	 */
	recordFans(key: string, value: number, minGapMs: number): void;
	/** 记一次「在记」,时刻取「现在」。最密 {@link STATS_SEEN_MIN_GAP_MS} 一条,规矩同 {@link recordFans}。 */
	recordSeen(key: string): void;
}

export interface StatsRecorderCoreOptions {
	store: StatsStore;
	/** 粉丝时序 —— 拓展的粉丝数从这里落(B 站的由粉丝轮询自己写)。 */
	fans: FansStore;
	logger: Logger;
	/** 注入时钟,测试用;缺省取系统时间。 */
	now?: () => Date;
}

/** 不属于任何键的写入(水位线)排的那一队。订阅 id 是 UUID,撞不上。 */
const UNKEYED = "\u0000";

export function createStatsRecorderCore(opts: StatsRecorderCoreOptions): StatsRecorderCore & {
	/** 给还在播的场次补一帧下播,时刻取「现在」,并等全部写入落地。见 {@link StatsRecorderHandle.closeOpenSessions}。 */
	closeOpenSessions(): Promise<void>;
	/** 等已经交出去的写入全部落地。见 {@link StatsRecorderHandle.flush}。 */
	flush(): Promise<void>;
	/** 清掉全部在飞状态(dispose 时)。 */
	clear(): void;
} {
	const now = opts.now ?? (() => new Date());
	/** 每个键本场的最大累计观看。开播时清空,下播时取走 —— 天然不跨场、不跨订阅串味。 */
	const peaks = new Map<string, number>();
	/** 当前仍在播的键。关服时据此补下播帧;正常下播会把它摘掉。 */
	const openLive = new Set<string>();
	/** 每个键上一条落盘的粉丝样本 / 「在记」的时刻(毫秒)。第一次用到时从盘上接上,见 {@link thinned}。 */
	const lastFans = new Map<string, number>();
	const lastSeen = new Map<string, number>();

	/**
	 * 落盘不挡调用方:bus handler 是同步签名,而这些写入都不在任何关键路径上。统计写失败只该丢一条统计,
	 * 绝不能把异常冒泡回推送链路。
	 */
	const swallow = (what: string) => (err: unknown) =>
		opts.logger.warn(`[stats-recorder] ${what} failed: ${String(err)}`);

	/**
	 * 每个键一队:这个键上一条写入落地了才开始下一条。
	 *
	 * 不排队的话两条挨着交出去的写入谁先落盘说不准(`appendFile` 各开各的文件句柄):没报下播就又开播时,上一场
	 * 的下播帧与新一场的开播帧是同一刻交出去的,落反了读的时候就配错场;删文件也可能跑在还没落地的追加前面,
	 * 文件被重新写出来。队首那一条**当场**交给 store(不等一个微任务),与不排队时一样。
	 */
	const tails = new Map<string, Promise<void>>();
	function enqueue(key: string, what: string, task: () => Promise<unknown>): void {
		const onError = swallow(`${what} ${key === UNKEYED ? "" : key}`.trim());
		const run = (): Promise<void> => {
			try {
				return task().then(() => undefined, onError);
			} catch (err) {
				onError(err);
				return Promise.resolve();
			}
		};
		const prev = tails.get(key);
		const tail = prev ? prev.then(run) : run();
		tails.set(key, tail);
		void tail.then(() => {
			if (tails.get(key) === tail) tails.delete(key);
		});
	}

	async function flush(): Promise<void> {
		// 等的时候队里可能又进了新的(比如前一条的回调里),等到一条不剩为止。
		while (tails.size > 0) await Promise.all([...tails.values()]);
	}

	/**
	 * 稀释过的追加:离这个键上一条不足 `gapMs` 就不写。上一条的时刻在内存里记着;这个进程第一次碰这个键时
	 * 从盘上接上(`latestSince` 只读最近 `gapMs` 那一段)—— 不然每次重启后的第一条都可能紧贴着重启前的最后一条。
	 * 判断放在队里做:同一刻交进来的两条,后一条看得见前一条已经写了。
	 */
	function thinned(
		key: string,
		what: string,
		gapMs: number,
		last: Map<string, number>,
		latestSince: (sinceIso: string) => Promise<number | undefined>,
		write: (tsIso: string) => Promise<void>,
	): void {
		const at = now().getTime();
		const known = last.get(key);
		if (known !== undefined && at - known < gapMs) return;
		enqueue(key, what, async () => {
			const prev = last.get(key) ?? (await latestSince(new Date(at - gapMs).toISOString()));
			if (prev !== undefined && at - prev < gapMs) {
				last.set(key, prev);
				return;
			}
			await write(new Date(at).toISOString());
			last.set(key, at);
		});
	}

	/** 一串 ISO 时刻里最晚的那个(毫秒);一个都没有是 `undefined`。 */
	const latestOf = (stamps: readonly string[]): number | undefined => {
		let latest: number | undefined;
		for (const ts of stamps) {
			const ms = Date.parse(ts);
			if (Number.isFinite(ms) && (latest === undefined || ms > latest)) latest = ms;
		}
		return latest;
	};

	// 采集一开始就把水位线钉下来。**这里就是「采集开始」的定义** —— 记录器
	// 在位才有人往盘上写活动。
	//
	// 留给首次 overview 请求去惰性创建的话,盖下的是「第一次有人打开统计页」的
	// 时刻:升级后过几天才点开,这几天真采到的活动全部落在水位线之前,被判成
	// 「无记录」—— 数据在盘上,界面上却是空白,而且水位线一旦落下就恒定,这段
	// 永远显示不出来。
	enqueue(UNKEYED, "recordingSince", () => opts.store.recordingSince());

	const forget = (key: string) => {
		peaks.delete(key);
		openLive.delete(key);
	};

	return {
		recordPost(key, post) {
			enqueue(key, "appendDynamic", () => opts.store.appendDynamic(key, post));
		},

		openSession(key, startedAtIso) {
			peaks.delete(key);
			openLive.add(key);
			enqueue(key, "openLiveSession", () => opts.store.openLiveSession(key, startedAtIso));
		},

		reportViewers(key, cumulative) {
			if (!Number.isFinite(cumulative)) return;
			const cur = peaks.get(key);
			if (cur === undefined || cumulative > cur) peaks.set(key, cumulative);
		},

		closeSession(key, endedAtIso, peak) {
			const tracked = peaks.get(key);
			const given = peak !== undefined && Number.isFinite(peak) ? peak : undefined;
			const final =
				tracked === undefined ? given : given === undefined ? tracked : Math.max(tracked, given);
			forget(key);
			enqueue(key, "closeLiveSession", () => opts.store.closeLiveSession(key, endedAtIso, final));
		},

		forget,

		drop(key) {
			// 在飞的状态也要摘掉。留着 `openLive` 的话,关服时 closeOpenSessions 会给这个
			// 已删的键再 append 一帧 end,把 drop 刚 unlink 掉的 jsonl 整个重新创建出来 ——
			// 从此是一份没人会读、也没人会再清的孤儿。
			forget(key);
			lastFans.delete(key);
			lastSeen.delete(key);
			// 排在这个键还没落地的写入后面:先删的话,它们落地时会把文件重新写出来。
			enqueue(key, "drop", async () => {
				await opts.store.drop(key);
				await opts.fans.drop(key);
			});
		},

		recordFans(key, value, minGapMs) {
			if (!Number.isFinite(value)) return;
			thinned(
				key,
				"appendFans",
				minGapMs,
				lastFans,
				async (sinceIso) =>
					latestOf((await opts.fans.listSamplesSince(key, sinceIso)).map((sample) => sample.ts)),
				(ts) => opts.fans.append(key, { ts, value }),
			);
		},

		recordSeen(key) {
			thinned(
				key,
				"appendSeen",
				STATS_SEEN_MIN_GAP_MS,
				lastSeen,
				async (sinceIso) =>
					latestOf((await opts.store.listSeenSince(key, sinceIso)).map((row) => row.ts)),
				(ts) => opts.store.appendSeen(key, ts),
			);
		},

		async closeOpenSessions() {
			const ts = now().toISOString();
			for (const key of openLive) {
				const peak = peaks.get(key);
				enqueue(key, "closeLiveSession(shutdown)", () =>
					opts.store.closeLiveSession(key, ts, peak),
				);
			}
			openLive.clear();
			peaks.clear();
			// 这里**要等**:关服写盘不能丢,进程随后就退出了。serviceCtx.dispose() 会逐个 await onDispose
			// 钩子,所以等得到。等的是**全部**写入,不只上面补的这几帧 —— 拓展直播的场次在更早的关机步骤里
			// 就结束了(拓展收摊、引擎拆),它们的下播帧交出去了还没落地。
			await flush();
		},

		flush,

		clear() {
			peaks.clear();
			openLive.clear();
		},
	};
}

export interface StatsRecorderOptions {
	bus: MessageBus;
	store: StatsStore;
	/** 粉丝时序 —— 拓展的粉丝数从资料上报里来,落在这里(B 站的由粉丝轮询写)。 */
	fans: FansStore;
	/**
	 * B 站粉丝轮询的 cron(`globals.app.fansCron`,现取)。拓展报的粉丝数不密过它(ADR-0020 决策 8),
	 * 两边的粉丝曲线一样疏密。
	 */
	fansCron: () => string;
	logger: Logger;
	/**
	 * 当前全部订阅。B 站事件只带 uid,B 站适配按它找到订阅 id;拓展适配按它判「这条订阅还在、启用着」。
	 */
	subscriptions: () => readonly StatsSubscription[];
	/** 注入时钟,测试用;缺省取系统时间。 */
	now?: () => Date;
}

/** Recorder 句柄:除了解绑,还要在关服前把在播的场次收尾。 */
export interface StatsRecorderHandle extends Disposable {
	/**
	 * 给当前仍在播的场次补一帧下播,时刻取「现在」。**关服前调用**。
	 *
	 * 关服路径(`teardown` / `stop` / `cancel`)都不翻 `liveStatus`,所以不会有
	 * 真实的下播事件 —— 对统计来说服务器是「人间蒸发」而不是「下播」。不补这一帧
	 * 的话,这一场永远等不到 end,已经观测到的那几个小时就白丢了。
	 *
	 * 补的是**观测截止时刻**,不是真实下播时刻(那个我们无从得知)。若服务在同一
	 * 场直播期间重启回来,`listLiveSessions` 会按 `startedAt` 认出是同一场并让更晚
	 * 的 end 覆盖上去,时长自动修正回完整值。
	 *
	 * resolve 时**全部**已交出去的写入都落了盘 —— 不只这里补的帧,还有更早的关机步骤里结束的拓展直播场次
	 * (拓展收摊时发的 `extension-stopped`、引擎拆场次时补的 `shutdown`)交出去的下播帧。那些场次已经关过了,
	 * 这里不会再给它们补第二帧。
	 */
	closeOpenSessions(): Promise<void>;
	/** 等已经交出去的写入全部落地(写失败的只记日志,也算落地)。 */
	flush(): Promise<void>;
}

/**
 * 起采集:一个记录器,挂上各来源的适配。bootstrap 只认这一个入口。
 *
 * 之所以整个采集都长在 apps/server 而非 packages/live、packages/dynamic 里:B 站需要的
 * 三条事件本来就已经在总线上了,业务包不必为统计再开一个出口。
 */
export function createStatsRecorder(opts: StatsRecorderOptions): StatsRecorderHandle {
	const now = opts.now ?? (() => new Date());
	const recorder = createStatsRecorderCore({
		store: opts.store,
		fans: opts.fans,
		logger: opts.logger,
		now,
	});
	const sources: Disposable[] = [
		attachBiliStatsSource({ bus: opts.bus, recorder, now, subscriptions: opts.subscriptions }),
		attachExtensionStatsSource({
			bus: opts.bus,
			recorder,
			subscriptions: opts.subscriptions,
			fansCron: opts.fansCron,
		}),
	];

	return {
		closeOpenSessions: () => recorder.closeOpenSessions(),
		flush: () => recorder.flush(),

		dispose() {
			for (const s of sources) s.dispose();
			sources.length = 0;
			recorder.clear();
		},
	};
}
