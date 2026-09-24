import type { Disposable, Logger, MessageBus } from "@bilibili-notify/internal";
import { attachBiliStatsSource } from "./bili-source.js";
import type { KeyedSubscription } from "./file-key.js";
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
 *     · 拓展:ADR-0020 的 S3 在 {@link createStatsRecorder} 里挂上,同样按订阅 id 记。
 */

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
	/** 忘掉 + 删掉这个键的统计文件(订阅被删时调)。 */
	drop(key: string): void;
}

export interface StatsRecorderCoreOptions {
	store: StatsStore;
	logger: Logger;
	/** 注入时钟,测试用;缺省取系统时间。 */
	now?: () => Date;
}

export function createStatsRecorderCore(opts: StatsRecorderCoreOptions): StatsRecorderCore & {
	/** 给还在播的场次补一帧下播,时刻取「现在」。见 {@link StatsRecorderHandle.closeOpenSessions}。 */
	closeOpenSessions(): Promise<void>;
	/** 清掉全部在飞状态(dispose 时)。 */
	clear(): void;
} {
	const now = opts.now ?? (() => new Date());
	/** 每个键本场的最大累计观看。开播时清空,下播时取走 —— 天然不跨场、不跨订阅串味。 */
	const peaks = new Map<string, number>();
	/** 当前仍在播的键。关服时据此补下播帧;正常下播会把它摘掉。 */
	const openLive = new Set<string>();

	/**
	 * 落盘一律 fire-and-forget:bus handler 是同步签名,而这些写入都不在任何
	 * 关键路径上。统计写失败只该丢一条统计,绝不能把异常冒泡回推送链路。
	 */
	const swallow = (what: string) => (err: unknown) =>
		opts.logger.warn(`[stats-recorder] ${what} failed: ${String(err)}`);

	// 采集一开始就把水位线钉下来。**这里就是「采集开始」的定义** —— 记录器
	// 在位才有人往盘上写活动。
	//
	// 留给首次 overview 请求去惰性创建的话,盖下的是「第一次有人打开统计页」的
	// 时刻:升级后过几天才点开,这几天真采到的活动全部落在水位线之前,被判成
	// 「无记录」—— 数据在盘上,界面上却是空白,而且水位线一旦落下就恒定,这段
	// 永远显示不出来。
	opts.store.recordingSince().catch(swallow("recordingSince"));

	const forget = (key: string) => {
		peaks.delete(key);
		openLive.delete(key);
	};

	return {
		recordPost(key, post) {
			opts.store.appendDynamic(key, post).catch(swallow(`appendDynamic ${key}`));
		},

		openSession(key, startedAtIso) {
			peaks.delete(key);
			openLive.add(key);
			opts.store.openLiveSession(key, startedAtIso).catch(swallow(`openLiveSession ${key}`));
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
			opts.store.closeLiveSession(key, endedAtIso, final).catch(swallow(`closeLiveSession ${key}`));
		},

		forget,

		drop(key) {
			// 在飞的状态也要摘掉。留着 `openLive` 的话,关服时 closeOpenSessions 会给这个
			// 已删的键再 append 一帧 end,把 drop 刚 unlink 掉的 jsonl 整个重新创建出来 ——
			// 从此是一份没人会读、也没人会再清的孤儿。
			forget(key);
			opts.store.drop(key).catch(swallow(`drop ${key}`));
		},

		async closeOpenSessions() {
			const ts = now().toISOString();
			// 这里**要 await**:关服写盘不是 fire-and-forget,进程随后就退出了。
			// serviceCtx.dispose() 会逐个 await onDispose 钩子,所以等得到。
			await Promise.all(
				[...openLive].map((key) =>
					opts.store
						.closeLiveSession(key, ts, peaks.get(key))
						.catch(swallow(`closeLiveSession(shutdown) ${key}`)),
				),
			);
			openLive.clear();
			peaks.clear();
		},

		clear() {
			peaks.clear();
			openLive.clear();
		},
	};
}

export interface StatsRecorderOptions {
	bus: MessageBus;
	store: StatsStore;
	logger: Logger;
	/** 当前全部订阅。B 站事件只带 uid,各来源适配按它找到订阅 id 再记。 */
	subscriptions: () => readonly KeyedSubscription[];
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
	 */
	closeOpenSessions(): Promise<void>;
}

/**
 * 起采集:一个记录器,挂上各来源的适配。bootstrap 只认这一个入口。
 *
 * 之所以整个采集都长在 apps/server 而非 packages/live、packages/dynamic 里:B 站需要的
 * 三条事件本来就已经在总线上了,业务包不必为统计再开一个出口。
 */
export function createStatsRecorder(opts: StatsRecorderOptions): StatsRecorderHandle {
	const now = opts.now ?? (() => new Date());
	const recorder = createStatsRecorderCore({ store: opts.store, logger: opts.logger, now });
	const sources: Disposable[] = [
		attachBiliStatsSource({ bus: opts.bus, recorder, now, subscriptions: opts.subscriptions }),
	];
	// ADR-0020 S3:拓展适配挂在这里(按订阅 id 记),与 B 站那份共用同一个记录器。

	return {
		closeOpenSessions: () => recorder.closeOpenSessions(),

		dispose() {
			for (const s of sources) s.dispose();
			sources.length = 0;
			recorder.clear();
		},
	};
}
