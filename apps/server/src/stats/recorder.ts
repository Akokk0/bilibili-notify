import type { Disposable, Logger, MessageBus } from "@bilibili-notify/internal";
import { HOUR_MS } from "../followers/cutoff.js";
import type { FollowersStore } from "../followers/store.js";
import { attachBiliStatsSource } from "./bili-source.js";
import type { RecordingCompactSummary } from "./compaction.js";
import { attachExtensionStatsSource } from "./extension-source.js";
import { type StatsSubscription, statsFileKey } from "./file-key.js";
import { attachLiveStatsSource } from "./live-source.js";
import { postEntryFromEvent } from "./post-entry-extras.js";
import type {
	LiveSessionClose,
	LiveSessionStart,
	PostEntry,
	RecordingKind,
	StatsStore,
} from "./store.js";

/**
 * 统计的采集层 = 一个**中立的记录器** + 每个来源一个**适配**(ADR-0020 决策 17)。
 *
 * - 记录器(本文件的 {@link createStatsRecorderCore})只收中立的调用:记一条作品、开一场、关一场;
 *   按**文件键**({@link statsFileKey})落进 {@link StatsStore}。
 *   它不认识任何平台,也不听总线。
 * - 适配把各来源的事件翻成这些调用,平台的规矩只写在适配里:
 *     · 作品(本文件的 `post-detected` 监听,**两支共用**):核心入口(`PostQueue`)对每条订阅发一份中立的
 *       `PostEvent`,统计照事件记一行(`postEntryFromEvent`),不认来源、不再自己看作品开关 ——
 *       该不该记的判据已经在入口里(订阅在、启用、作品开关开着、来源在跑)。
 *     · 直播(`live-source.ts`):所有来源共用一个监听,吃中立的 `live-session-changed`。
 *     · B 站(`bili-source.ts`):登录有效 = 来源在跑,登录失效时忘掉 B 站在飞的场次。
 *     · 拓展(`extension-source.ts`):听订阅上报,资料里的粉丝数按 B 站粉丝轮询的间隔稀释;
 *       收到上报 = 来源在跑,按开关记「在记」。
 *
 * **写盘按键排队**:同一个键的写入一条接一条落(开播帧不会被紧跟着的下播帧抢到前面,删文件不会被还在路上的
 * 追加重新写出来),{@link StatsRecorderHandle.flush} 等得到全部落地 —— 关机补帧靠它。
 */

/** 各来源适配看得到的那一面。所有写入都是 fire-and-forget,失败只丢这一条统计。 */
export interface StatsRecorderCore {
	/** 记一条作品行。同一个键下同 id 只留首条(去重在 store)。 */
	recordPost(key: string, post: PostEntry): void;
	/** 开一场。 */
	openSession(key: string, start: LiveSessionStart): void;
	/**
	 * 关一场。峰值与五格互动汇总只取场次引擎交来的那份;没有的格不动。
	 */
	closeSession(key: string, close: LiveSessionClose): void;
	/** 忘掉这个键在飞的场次(只动内存,不动盘)。来源那头不再观测它时调。 */
	forget(key: string): void;
	/** 忘掉 + 删掉这个键的全部文件(作品、直播、「在记」、粉丝;订阅被删时调)。 */
	drop(key: string): void;
	/**
	 * 记一条按 cron 从来源拉来的粉丝样本,时刻取「现在」。
	 *
	 * 拉取由核心按固定节奏发起,一轮就是一条:这里**不稀释**,相邻两轮即使挨得很近也各留一条。
	 * 拓展上报的资料不按本进程的节奏来,仍走 {@link recordFans},按来源间隔稀释。
	 *
	 * 写进这个键的同一条队,落盘后 Promise 才落定;总开关关着、值不是有限非负整数、或写失败时直接落定。
	 * 成功后更新 `recordFans` 的稀释时刻,避免紧跟着的报来样本贴着同一条拉取样本再写一遍。
	 */
	recordFollowers(key: string, value: number): Promise<void>;
	/**
	 * 记一个粉丝数,时刻取「现在」。离这个键上一条落盘的样本(重启之前落的也算)不足 `minGapMs` 就不记 ——
	 * 留先到的那条,不密过来源给的间隔。
	 */
	recordFans(key: string, value: number, minGapMs: number): void;
	/**
	 * 记「这个小时这一项在记」(ADR-0027 决策 2 / 13):`atMs` 所在的 UTC 整点小时,缺省取「现在」。
	 * 同一个小时同一项只落一行 —— 进程内用集合挡重复,重启后第一次写某个键之前读一次账、把这个小时已有的种进去。
	 */
	recordActive(key: string, kind: RecordingKind, atMs?: number): void;
}

export interface StatsRecorderCoreOptions {
	store: StatsStore;
	/** 粉丝时序 —— 拓展的粉丝数从这里落(B 站的由粉丝轮询自己写)。 */
	fans: FollowersStore;
	logger: Logger;
	/** 注入时钟,测试用;缺省取系统时间。 */
	now?: () => Date;
	/**
	 * 数据统计的总开关(`stats.enabled`,ADR-0027 决策 9、16),**现取**:读缓存布尔、不要每次读设置
	 * (观看人数约两秒一帧)。关着时作品、新开的场次、粉丝样本、「在记」的账都不记;开着时开的场次照常收尾。
	 * 压缩、关停补帧、删文件不看它。
	 */
	isEnabled: () => boolean;
}

export function createStatsRecorderCore(opts: StatsRecorderCoreOptions): StatsRecorderCore & {
	/** 给还在播的场次补一帧下播,时刻取「现在」,并等全部写入落地。见 {@link StatsRecorderHandle.closeOpenSessions}。 */
	closeOpenSessions(): Promise<void>;
	/** 等已经交出去的写入全部落地。见 {@link StatsRecorderHandle.flush}。 */
	flush(): Promise<void>;
	/**
	 * 压「在记」的账(ADR-0027 决策 13、15):对盘上每份账各排一次压缩进这个键的队 —— 与账的追加是同一条队,
	 * 压缩读整份、写回的这段时间里记的小时排在后面,不会被换名盖掉。回汇总;某个键压不动只记 warn、不算进汇总。
	 */
	compactRecording(now: Date): Promise<RecordingCompactSummary>;
	/**
	 * 整类清空数据统计(㉙d,「存储占用」):删掉作品、直播、「在记」小账、粉丝样本四个目录里的全部文件。
	 *
	 * 与 {@link reset} 的区别:**`clear` 删盘,`reset` 只清内存**(dispose 时用)。`clear` 也清内存里的在飞状态。
	 *
	 * - 删文件**必须经各键的写队**:直接删会被排在队里的在飞写入(作品、粉丝样本、「在记」)重新写出来。键取盘上列得出的
	 *   与此刻队里有的并集(队里还没落盘的第一条写入,文件还不存在);删完再清粉丝仓(它自己的按键队)。
	 * - **正在播的场次**:这一刻开着的场次的开播帧随文件一起没了,所以把它们当作没开过 —— 之后它们的下播帧不写
	 *   (否则盘上留一个只有 `end`、没有 `start` 的半场)。这之后新开的场次照常记。
	 *   局限:只认本进程内存里开着的场次。开播发生在本次启动之前的那一场,清完以后它的下播帧会写成一条没有开播帧的
	 *   `end`;读的一方(`StatsStore.listLiveSessions`)本来就丢弃孤立的 `end`,所以无害(`store.test.ts`「孤立的 end」钉着)。
	 * - 不看总开关(`isEnabled`):开着关着都能清。
	 * 全部落地才返回。
	 */
	clear(): Promise<void>;
	/** 清掉全部在飞状态(dispose 时)。只动内存里的在飞状态,不删盘(要删盘用 {@link clear})。 */
	reset(): void;
} {
	const now = opts.now ?? (() => new Date());
	/** 当前仍在播的键。关服时据此补下播帧;正常下播会把它摘掉。 */
	const openLive = new Set<string>();
	/** `clear` 时正开着的键:它们的开播帧已随文件删了,下一次下播不写孤立的 `end`(见 {@link StatsRecorderCore.clear})。 */
	const discardedOpen = new Set<string>();
	/** 每个键上一条落盘的粉丝样本的时刻(毫秒)。第一次用到时从盘上接上,见 {@link thinned}。 */
	const lastFans = new Map<string, number>();
	/**
	 * 「在记」账的内存挡板:每个(小时,键)一格,记着这一小时哪几项**已经交出去**(`handed`)、哪几项**已经在盘上**
	 * (`written`,含盘上本来就有的)。同一个小时同一项只落一行靠它。只留最新的两个小时 —— 粉丝轮询一轮可能跨过整点
	 * (上一个小时采的样本、下一个小时才发出事件),所以上一个小时还收;再早的不会再有人写。
	 * `seeded`:重启后第一次写某个键前读一次盘,把这个小时已有的种进 `written`。
	 */
	interface HourSlot {
		hour: number;
		key: string;
		seeded: boolean;
		handed: Set<RecordingKind>;
		written: Set<RecordingKind>;
	}
	const slots = new Map<string, HourSlot>();
	let activeHour = Number.NEGATIVE_INFINITY;

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
	function enqueue(key: string, what: string, task: () => Promise<unknown>): Promise<void> {
		const onError = swallow(`${what} ${key}`.trim());
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
		return tail;
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

	const forget = (key: string) => {
		openLive.delete(key);
	};

	return {
		recordPost(key, post) {
			if (!opts.isEnabled()) return;
			enqueue(key, "appendPost", () => opts.store.appendPost(key, post));
		},

		openSession(key, start) {
			// 关着时新来的开播不开场(之后的下播也就没有「这场开没开过」可收,见 closeSession)。
			if (!opts.isEnabled()) return;
			// 清空之后新开的一场是真的开场,不再算「被清掉的那场」。
			discardedOpen.delete(key);
			openLive.add(key);
			enqueue(key, "openLiveSession", () => opts.store.openLiveSession(key, start));
		},

		closeSession(key, close) {
			const { endedAt, peakTotalViewers, ...interactions } = close;
			const frame: LiveSessionClose = { endedAt, ...interactions };
			// NaN / Infinity 进 JSON 会变成 null,不交这种东西给落盘层。
			if (peakTotalViewers !== undefined && Number.isFinite(peakTotalViewers)) {
				frame.peakTotalViewers = peakTotalViewers;
			}
			// 「这场开没开过」要在 forget 之前读(forget 会把它摘掉),而 forget 无条件照跑。
			// 关着时:开着时开的场次照常收尾(一场的头尾不分家),没开过场的下播不写孤立的 end。
			const opened = openLive.has(key);
			const cleared = discardedOpen.delete(key);
			forget(key);
			// 清空时开着的场次:开播帧已经被清掉,收尾也不写(不留半场)。
			if (cleared) return;
			if (!opened && !opts.isEnabled()) return;
			enqueue(key, "closeLiveSession", () => opts.store.closeLiveSession(key, frame));
		},

		forget,

		drop(key) {
			// 在飞的状态也要摘掉。留着 `openLive` 的话,关服时 closeOpenSessions 会给这个
			// 已删的键再 append 一帧 end,把 drop 刚 unlink 掉的 jsonl 整个重新创建出来 ——
			// 从此是一份没人会读、也没人会再清的孤儿。
			forget(key);
			lastFans.delete(key);
			for (const [id, slot] of slots) if (slot.key === key) slots.delete(id);
			// 排在这个键还没落地的写入后面:先删的话,它们落地时会把文件重新写出来。
			enqueue(key, "drop", async () => {
				await opts.store.drop(key);
				await opts.fans.drop(key);
			});
		},

		async recordFollowers(key, value) {
			if (!opts.isEnabled() || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
				return;
			}
			const at = now().getTime();
			await enqueue(key, "appendFollowers", async () => {
				await opts.fans.append(key, { sampledAt: new Date(at).toISOString(), followers: value });
				lastFans.set(key, at);
			});
		},

		recordFans(key, value, minGapMs) {
			if (!Number.isFinite(value) || !opts.isEnabled()) return;
			thinned(
				key,
				"appendFans",
				minGapMs,
				lastFans,
				async (sinceIso) =>
					latestOf(
						(await opts.fans.listSamplesSince(key, sinceIso)).map((sample) => sample.sampledAt),
					),
				(sampledAt) => opts.fans.append(key, { sampledAt, followers: value }),
			);
		},

		recordActive(key, kind, atMs) {
			if (!opts.isEnabled()) return;
			const hourStart = Math.floor((atMs ?? now().getTime()) / HOUR_MS) * HOUR_MS;
			if (!Number.isFinite(hourStart)) return;
			// 只认最新的两个小时(见上面的挡板说明):更早的丢掉。
			if (hourStart > activeHour) {
				activeHour = hourStart;
				for (const [id, slot] of slots) if (slot.hour < hourStart - HOUR_MS) slots.delete(id);
			} else if (hourStart < activeHour - HOUR_MS) {
				return;
			}
			const slotId = `${hourStart}\0${key}`;
			let slot = slots.get(slotId);
			if (slot === undefined) {
				slot = { hour: hourStart, key, seeded: false, handed: new Set(), written: new Set() };
				slots.set(slotId, slot);
			}
			if (slot.handed.has(kind)) return;
			slot.handed.add(kind);
			const mine = slot;
			const startedAt = new Date(hourStart).toISOString();
			const endedAt = new Date(hourStart + HOUR_MS).toISOString();
			enqueue(key, "appendRecording", async () => {
				// 重启之后第一次写这个键:先把盘上这个小时已有的种进来,免得重启后同一小时再落一行。
				// 盘上盖着整个小时的行才算(迁移写的是长区间,压缩合出来的也是)。
				if (!mine.seeded) {
					mine.seeded = true;
					for (const row of await opts.store.listRecording(key, startedAt)) {
						if (
							Date.parse(row.startedAt) <= hourStart &&
							Date.parse(row.endedAt) >= hourStart + HOUR_MS
						) {
							mine.written.add(row.kind);
						}
					}
				}
				if (mine.written.has(kind)) return;
				mine.written.add(kind);
				await opts.store.appendRecording(key, { kind, startedAt, endedAt });
			});
		},

		async closeOpenSessions() {
			const ts = now().toISOString();
			for (const key of openLive) {
				enqueue(key, "closeLiveSession(shutdown)", () =>
					opts.store.closeLiveSession(key, { endedAt: ts }),
				);
			}
			openLive.clear();
			// 这里**要等**:关服写盘不能丢,进程随后就退出了。serviceCtx.dispose() 会逐个 await onDispose
			// 钩子,所以等得到。等的是**全部**写入,不只上面补的这几帧 —— 拓展直播的场次在更早的关机步骤里
			// 就结束了(拓展收摊、引擎拆),它们的下播帧交出去了还没落地。
			await flush();
		},

		flush,

		async compactRecording(at) {
			const summary: RecordingCompactSummary = { files: 0, squeezed: 0, badLines: 0 };
			const keys = await opts.store.recordingKeys();
			await Promise.all(
				keys.map((key) =>
					enqueue(key, "compactRecording", async () => {
						const report = await opts.store.compactRecording(key, at);
						summary.badLines += report.badLines;
						if (report.rewritten) {
							summary.files += 1;
							summary.squeezed += report.rowsBefore - report.rowsAfter;
						}
					}),
				),
			);
			return summary;
		},

		async clear() {
			for (const key of openLive) discardedOpen.add(key);
			openLive.clear();
			lastFans.clear();
			slots.clear();
			const keys = new Set(await opts.store.keys());
			for (const key of tails.keys()) keys.add(key);
			await Promise.all([...keys].map((key) => enqueue(key, "clear", () => opts.store.drop(key))));
			await opts.fans.clear();
		},

		reset() {
			openLive.clear();
		},
	};
}

export interface StatsRecorderOptions {
	bus: MessageBus;
	store: StatsStore;
	/** 粉丝时序 —— 拓展的粉丝数从资料上报里来,落在这里(B 站的由粉丝轮询写)。 */
	fans: FollowersStore;
	/**
	 * B 站粉丝轮询的 cron(`globals.profileRefreshCron`,现取)。拓展报的粉丝数不密过它(ADR-0020 决策 8),
	 * 两边的粉丝曲线一样疏密。
	 */
	fansCron: () => string;
	logger: Logger;
	/**
	 * 当前全部订阅。中立直播监听按它判订阅还在不在、要不要记直播;各来源适配按它分流。
	 */
	subscriptions: () => readonly StatsSubscription[];
	/** 注入时钟,测试用;缺省取系统时间。 */
	now?: () => Date;
	/** 数据统计的总开关,见 {@link StatsRecorderCoreOptions.isEnabled}。装配处给一个读缓存布尔的函数。 */
	isEnabled: () => boolean;
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
	/** 压「在记」的账,见 {@link StatsRecorderCore} 那头的同名口子。 */
	compactRecording(now: Date): Promise<RecordingCompactSummary>;
	/** 整类清空数据统计(删盘),见 {@link StatsRecorderCore} 那头的同名口子。 */
	clear(): Promise<void>;
	/**
	 * 回填「B 站登录有效」的读口(`index.ts` 建好登录系统之后调,同 `attachFansPoller` 的回填口)。
	 * 没绑之前当作 B 站没在跑(不记);绑上后 B 站适配立刻看一眼。读口每次现读,不靠事件记状态。
	 */
	bindLoginState(isLoggedIn: () => boolean): void;
}

/**
 * 起采集:一个记录器,挂上各来源的适配。bootstrap 只认这一个入口。
 *
 * 之所以整个采集都长在 `stats/` 而非 `bilibili/live`、`posts/` 里:需要的事件本来就已经在总线上了,
 * 业务包不必为统计再开一个出口。
 */
export function createStatsRecorder(opts: StatsRecorderOptions): StatsRecorderHandle {
	const now = opts.now ?? (() => new Date());
	const recorder = createStatsRecorderCore({
		store: opts.store,
		fans: opts.fans,
		logger: opts.logger,
		now,
		isEnabled: opts.isEnabled,
	});
	let isLoggedIn: (() => boolean) | undefined;
	const liveSource = attachLiveStatsSource({
		bus: opts.bus,
		recorder,
		now,
		subscriptions: opts.subscriptions,
	});
	const biliSource = attachBiliStatsSource({
		bus: opts.bus,
		recorder,
		now,
		subscriptions: opts.subscriptions,
		isLoggedIn: () => isLoggedIn?.() === true,
		forgetOpenSessions: liveSource.forgetOpenSessions,
	});
	const sources: Disposable[] = [
		biliSource,
		liveSource,
		// 作品行:B 站与拓展共用这一个监听,键是订阅 id。
		opts.bus.on("post-detected", (event) =>
			recorder.recordPost(statsFileKey({ id: event.subscriptionId }), postEntryFromEvent(event)),
		),
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
		compactRecording: (at) => recorder.compactRecording(at),
		clear: () => recorder.clear(),
		bindLoginState(next) {
			isLoggedIn = next;
			biliSource.tick();
		},

		dispose() {
			for (const s of sources) s.dispose();
			sources.length = 0;
			recorder.reset();
		},
	};
}
