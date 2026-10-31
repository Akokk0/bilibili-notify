import {
	type CreatorProfileReport,
	createSerialQueue,
	type Disposable,
	type FollowersRefreshEntry,
	type Identity,
	type Logger,
	type MessageBus,
	type Result,
	type ServiceContext,
	type Subscription,
	subscriptionIdentityOf,
} from "@bilibili-notify/internal";
import type { SubscriptionStore } from "@bilibili-notify/subscription";
import { CronJob } from "cron";
import type { ConfigStore } from "../config/store.js";
import { HOUR_MS } from "../followers/cutoff.js";
import type { FollowersStore } from "../followers/store.js";
import { t } from "../i18n/index.js";
import type { ProblemTable } from "../problems/problem-table.js";
import { statsFileKey } from "../stats/file-key.js";
import type { StatsRecorderCore } from "../stats/recorder.js";
import type { SourceRegistry } from "../subscriptions/registry.js";
import { errorMessageOf } from "../util/error-message.js";
import type { ProfileCacheWriter } from "./profile-cache.js";
import {
	pruneOrphanSubscriptionState,
	type SubscriptionStateStore,
} from "./subscription-state-store.js";

const START_DELAY_MS = 3_000;
const TWENTY_FOUR_HOURS_MS = 24 * HOUR_MS;
const SEVEN_DAYS_MS = 7 * 24 * HOUR_MS;
/** 一个「远未来」时间戳:拿它去 `findNearestBefore` 就退化成「取最近一条」。 */
const FUTURE_ISO = "9999-12-31T00:00:00.000Z";

export interface ProfileRefreshOptions {
	bus: MessageBus;
	logger: Logger;
	configStore: Pick<ConfigStore, "getGlobals" | "getSubscriptionIds">;
	subscriptionStore: SubscriptionStore;
	subscriptionStateStore: SubscriptionStateStore;
	fansStore: Pick<FollowersStore, "findEarliest" | "findNearestBefore">;
	recorder: Pick<StatsRecorderCore, "recordActive" | "recordFollowers" | "drop">;
	profileCache: ProfileCacheWriter;
	problems: Pick<ProblemTable, "report" | "resolve">;
	sources: Pick<SourceRegistry, "get" | "list">;
	/**
	 * 与女仆回落共用同一个来源闸的 `fetchProfile`:超时、抛错收口、同一来源串行都在这里。
	 */
	fetchProfile(identity: Identity, signal: AbortSignal): Promise<Result<CreatorProfileReport>>;
	serviceCtx: ServiceContext;
	isStatsEnabled(): boolean;
}

export interface ProfileRefreshHandle extends Disposable {
	getLastEntries(): FollowersRefreshEntry[];
	pollNow(): Promise<boolean>;
	refreshSubscription(id: string): Promise<void>;
	/**
	 * 来源经 `ctx.reportProfile` 报的资料写完之后,当场重算面板上这几行并叫一次面板(没变就不叫)。
	 * 与 `refreshSubscription` 的差别:不拉取,资料缓存已经由收口写好了。
	 */
	refreshReportedEntries(ids: readonly string[]): Promise<void>;
	reset(): Promise<void>;
}

export function startProfileRefresh(opts: ProfileRefreshOptions): ProfileRefreshHandle {
	const { bus, logger, configStore, subscriptionStore, subscriptionStateStore, fansStore } = opts;
	let currentCron = configStore.getGlobals().profileRefreshCron;
	let currentTimezone = configStore.getGlobals().timezone;
	let job: CronJob | undefined;
	let running = false;
	let disposed = false;
	let generation = 0;
	/** 订阅 id → 首页粉丝面板的一行。启用中的两种来源都在这里,停用或删掉的立即撤下。 */
	const lastBySub = new Map<string, FollowersRefreshEntry>();
	/**
	 * 重算面板快照只有一条队:整轮、只重算几行、以及 `reset()` 的整轮都排在这里,一次只让一轮算完并提交。
	 * 否则两轮交错时,后提交的那轮会拿自己算的旧结果盖掉前一轮刚撤掉的行。
	 */
	const recompute = createSerialQueue();
	/** 重算只有这一种任务,所以队列只有这一个键。 */
	const SNAPSHOT_KEY = "profile-snapshot";

	const enabledSubscriptions = (): Subscription[] =>
		subscriptionStore.list().filter((sub) => sub.enabled);
	const subscriptionNow = (id: string): Subscription | undefined => subscriptionStore.findById(id);

	/**
	 * 一条订阅在面板上的行:当前数与时刻取资料缓存,起点与窗口涨跌取粉丝时序。两种来源走同一份算法。
	 **/
	async function entryOf(
		sub: Subscription,
		nowMs: number,
		allowReportedWithoutSample = false,
		includeWindows = true,
	): Promise<FollowersRefreshEntry | undefined> {
		const key = statsFileKey(sub);
		const statsOn = opts.isStatsEnabled();
		const reportedBefore = subscriptionStateStore.get(sub.id)?.cachedProfile?.followers;
		const needsLatest = reportedBefore === undefined || statsOn;
		const [latest, first, near24h, near7d] = await Promise.all([
			needsLatest ? fansStore.findNearestBefore(key, FUTURE_ISO) : undefined,
			fansStore.findEarliest(key),
			statsOn && includeWindows
				? fansStore.findNearestBefore(key, new Date(nowMs - TWENTY_FOUR_HOURS_MS).toISOString())
				: undefined,
			statsOn && includeWindows
				? fansStore.findNearestBefore(key, new Date(nowMs - SEVEN_DAYS_MS).toISOString())
				: undefined,
		]);
		const profile = subscriptionStateStore.get(sub.id)?.cachedProfile;
		const reported = profile?.followers;
		if (!latest && reported === undefined) return undefined;
		if (!latest && statsOn && !allowReportedWithoutSample) return undefined;
		const current = reported ?? latest?.followers;
		if (current === undefined) return undefined;
		return {
			subscriptionId: sub.id,
			identity: subscriptionIdentityOf(sub),
			current,
			refreshedAt:
				reported !== undefined && profile
					? profile.refreshedAt
					: (latest?.sampledAt ?? new Date(nowMs).toISOString()),
			deltaSubscribed: first ? current - first.followers : null,
			delta24h: near24h ? current - near24h.followers : null,
			delta7d: near7d ? current - near7d.followers : null,
		};
	}

	/**
	 * 重算整份快照,或只重算指定订阅。分两步:
	 *
	 * - **计算阶段**只把这次算出来的行攒进局部 Map,不碰 `lastBySub` —— 算的途中删订阅,监听器撤行不受影响。
	 * - **提交阶段**从第一行起不跨 `await`:逐行现查订阅还在不在、还启不启用,在的才并进 `lastBySub`,
	 *   不在的当场撤下;整轮再把此刻不在启用列表里的行扫掉(现查,不用开头那份列表)。
	 *
	 * 算到一半发现代数变了就不提交。整轮、只算几行与 `reset()` 都排在 {@link recompute} 上,一次只算一轮。
	 */
	async function refreshEntries(
		startedGeneration: number,
		only?: ReadonlySet<string>,
		allowReportedWithoutSample = false,
		includeRegisteredWindows = true,
	): Promise<boolean> {
		return recompute.run(SNAPSHOT_KEY, async () => {
			if (disposed || generation !== startedGeneration) return false;
			const nowMs = Date.now();
			/** 这一轮算出来的行;`undefined` = 这条订阅这一轮没有可显示的行。 */
			const computed = new Map<string, FollowersRefreshEntry | undefined>();
			for (const sub of enabledSubscriptions()) {
				if (only && !only.has(sub.id)) continue;
				const sourceKey = subscriptionIdentityOf(sub).sourceKey;
				const includeWindows = includeRegisteredWindows || !opts.sources.get(sourceKey);
				const entry = await entryOf(
					sub,
					nowMs,
					allowReportedWithoutSample && opts.sources.get(sourceKey) !== undefined,
					includeWindows,
				);
				if (disposed || generation !== startedGeneration) return false;
				computed.set(sub.id, entry);
			}

			// 提交阶段:从这一行往下不跨 await,中途删掉的订阅不会在这里又长回来。
			let changed = only === undefined;
			for (const [id, entry] of computed) {
				const keep = subscriptionNow(id)?.enabled === true;
				if (keep && entry) {
					lastBySub.set(id, entry);
					changed = true;
				} else if (lastBySub.delete(id)) {
					changed = true;
				}
			}
			if (only === undefined) {
				// 整轮还要扫掉此刻不在启用列表里的行:算的途中停用 / 删掉的,以及别的路留下、现在已经不该在的。
				const enabledNow = new Set(enabledSubscriptions().map((sub) => sub.id));
				for (const id of [...lastBySub.keys()]) {
					if (enabledNow.has(id)) continue;
					lastBySub.delete(id);
					changed = true;
				}
			}
			return changed;
		});
	}

	function emitSnapshot(): void {
		bus.emit("followers-refreshed", { entries: Array.from(lastBySub.values()) });
	}

	/** 拉一条在册来源的订阅;失败只跳过这一条,资料缓存保持上一次的数。 */
	async function refreshOne(sub: Subscription): Promise<void> {
		const identity = subscriptionIdentityOf(sub);
		let result: Result<CreatorProfileReport>;
		try {
			result = await opts.fetchProfile(identity, opts.serviceCtx.signal);
		} catch (err) {
			logger.debug(
				`[profile-refresh] ${identity.sourceKey}/${identity.externalId} 拉资料抛了: ${String(err)}`,
			);
			return;
		}
		if (!result.ok) {
			if (result.code === "not_found" && subscriptionNow(sub.id)?.enabled) {
				opts.problems.report({
					reporter: identity.sourceKey,
					about: { subscriptionId: sub.id },
					code: "creator_not_found",
					message: () =>
						t("problem.creatorNotFound", {
							externalId: identity.externalId,
							reason: result.message,
						}),
					notify: false,
				});
			}
			logger.debug(
				`[profile-refresh] ${identity.sourceKey}/${identity.externalId} 没拉到资料 ` +
					`code=${result.code} upstreamCode=${String(result.upstreamCode)} msg=${result.message}`,
			);
			return;
		}
		if (disposed || subscriptionNow(sub.id) === undefined) return;
		opts.problems.resolve({
			reporter: identity.sourceKey,
			about: { subscriptionId: sub.id },
			code: "creator_not_found",
		});
		const profile = result;
		const key = statsFileKey(sub);
		if (profile.followers !== undefined && subscriptionNow(sub.id)?.enabled === true) {
			opts.recorder.recordActive(key, "followers");
		}
		let changed = false;
		try {
			changed = await opts.profileCache.write(sub.id, {
				name: profile.name,
				...(profile.avatar === undefined ? {} : { avatar: profile.avatar }),
				...(profile.bio === undefined ? {} : { bio: profile.bio }),
				...(profile.followers === undefined ? {} : { followers: profile.followers }),
				...(profile.fanClubName === undefined ? {} : { fanClubName: profile.fanClubName }),
			});
		} catch (err) {
			logger.warn(
				`[profile-refresh] ${identity.sourceKey}/${identity.externalId} 资料缓存没写进去: ${String(err)}`,
			);
			return;
		}
		if (changed) opts.profileCache.announce([sub.id]);
		// 写完再看一眼:拉取途中删掉的订阅不能因为资料晚到而多记一条样本。
		const current = subscriptionNow(sub.id);
		if (profile.followers !== undefined && !disposed && current?.enabled === true) {
			await opts.recorder.recordFollowers(key, profile.followers);
		}
	}

	/** 新建订阅后当场刷这一条:拉取与整轮共用,落定后只重算这一行并叫一次面板。 */
	async function refreshSubscription(id: string): Promise<void> {
		if (disposed) return;
		const sub = subscriptionNow(id);
		if (!sub?.enabled || !opts.sources.get(subscriptionIdentityOf(sub).sourceKey)) return;
		const startedGeneration = generation;
		await refreshOne(sub);
		if (disposed || generation !== startedGeneration) return;
		await refreshEntries(startedGeneration, new Set([sub.id]));
		if (disposed || generation !== startedGeneration) return;
		emitSnapshot();
	}

	/** 收口写完一份报来的资料后调:只重算这几行(仍启用着的),变了才叫面板。 */
	async function refreshReportedEntries(ids: readonly string[]): Promise<void> {
		if (disposed) return;
		const startedGeneration = generation;
		// 第三个参数 `true`:刚报来的粉丝数样本是排队异步记的,这一刻未必已落盘;统计开着时不能因此把这一行撤掉。
		const changed = await refreshEntries(startedGeneration, new Set(ids), true);
		if (changed && !disposed && generation === startedGeneration) emitSnapshot();
	}

	/**
	 * 一轮:同一来源按订阅列表顺序一条接一条,不同来源并行。来源不在登记表里的(今天的拓展订阅)
	 * 不调,但它们的资料缓存与时序仍进同一份面板快照。
	 */
	async function runTick(): Promise<void> {
		const startedGeneration = generation;
		const bySource = new Map<string, Subscription[]>();
		for (const sub of enabledSubscriptions()) {
			const sourceKey = subscriptionIdentityOf(sub).sourceKey;
			if (!opts.sources.get(sourceKey)) continue;
			const group = bySource.get(sourceKey) ?? [];
			group.push(sub);
			bySource.set(sourceKey, group);
		}
		await Promise.all(
			Array.from(bySource.values(), async (group) => {
				for (const sub of group) {
					if (disposed || generation !== startedGeneration) return;
					await refreshOne(sub);
				}
			}),
		);
		if (disposed || generation !== startedGeneration) return;
		await refreshEntries(startedGeneration);
		if (disposed || generation !== startedGeneration) return;
		emitSnapshot();
	}

	/** 上一轮没完就跳过这一拍;返回到这一轮真正结束时才落定。 */
	function tickOnce(): Promise<boolean> {
		if (disposed) return Promise.resolve(false);
		if (running) {
			logger.debug("[profile-refresh] previous tick still running, skipping");
			return Promise.resolve(false);
		}
		running = true;
		return runTick()
			.then(() => true)
			.catch((err) => {
				logger.warn(`[profile-refresh] tick failed: ${String(err)}`);
				return true;
			})
			.finally(() => {
				running = false;
			});
	}

	// profileRefreshCron 是面板上的自由文本框:读不懂时只让这次轮询不启动,不能把整个进程带崩。
	function startJob(): void {
		try {
			job = new CronJob(
				currentCron,
				() => {
					opts.serviceCtx.track(tickOnce());
				},
				null,
				false,
				currentTimezone,
			);
		} catch (err) {
			logger.error(
				`[profile-refresh] cron='${currentCron}' 无法解析,资料刷新未启动: ${errorMessageOf(err)}`,
			);
			job = undefined;
			return;
		}
		job.start();
		logger.info(`[profile-refresh] scheduled with cron='${currentCron}'`);
	}

	function reconcileCron(): void {
		const globals = configStore.getGlobals();
		const next = globals.profileRefreshCron;
		if (next === currentCron && globals.timezone === currentTimezone) return;
		logger.info(
			`[profile-refresh] schedule changed: cron='${currentCron}' timezone='${currentTimezone}' -> cron='${next}' timezone='${globals.timezone}'`,
		);
		job?.stop();
		currentCron = next;
		currentTimezone = globals.timezone;
		startJob();
	}

	/**
	 * 等 3 秒让登录流程起来再发首轮。关停时会叫醒等待,避免一个被清掉的定时器让首轮任务永远不落定。
	 */
	function sleepUnlessShutdown(ms: number): Promise<void> {
		return new Promise<void>((resolve) => {
			if (opts.serviceCtx.signal.aborted) {
				resolve();
				return;
			}
			let timer: Disposable | undefined;
			const onShutdown = (): void => {
				timer?.dispose();
				resolve();
			};
			opts.serviceCtx.signal.addEventListener("abort", onShutdown, { once: true });
			timer = opts.serviceCtx.setTimeout(() => {
				opts.serviceCtx.signal.removeEventListener("abort", onShutdown);
				resolve();
			}, ms);
		});
	}

	startJob();
	// 先从盘上恢复首页首屏,再等认证窗口过去;3 秒常量照旧轮询器搬来。
	opts.serviceCtx.track(
		(async () => {
			await refreshEntries(generation, undefined, false, false);
			if (disposed) return;
			if (lastBySub.size > 0) {
				emitSnapshot();
				logger.info(`[profile-refresh] restored ${lastBySub.size} entries from disk`);
			}
			await sleepUnlessShutdown(START_DELAY_MS);
			if (disposed || opts.serviceCtx.signal.aborted) return;
			await tickOnce();
		})().catch((err) => {
			logger.warn(`[profile-refresh] 首轮启动失败: ${String(err)}`);
		}),
	);

	const offConfig = bus.on("config-changed", ({ scope }) => {
		if (scope === "globals") reconcileCron();
	});

	/** 删订阅:立即撤行、清孤儿资料;粉丝文件由统计记录器排在写队后面删,不会再长回来。 */
	const offSubs = bus.on("subscription-changed", ({ ops }) => {
		let removedAny = false;
		let removed = false;
		for (const op of ops) {
			if (op.kind === "update" && !op.sub.enabled) {
				opts.problems.resolve(
					{
						reporter: subscriptionIdentityOf(op.sub).sourceKey,
						about: { subscriptionId: op.sub.id },
						code: "creator_not_found",
					},
					{ notify: false },
				);
			}
			if (op.kind !== "remove") continue;
			if (lastBySub.delete(op.sub.id)) removedAny = true;
			opts.recorder.drop(statsFileKey(op.sub));
			removed = true;
		}
		if (removed) {
			opts.serviceCtx.track(
				pruneOrphanSubscriptionState(subscriptionStateStore, configStore).catch((err) => {
					logger.warn(`[profile-refresh] 清理已删订阅的资料缓存失败: ${String(err)}`);
				}),
			);
		}
		if (removedAny) emitSnapshot();
	});

	return {
		getLastEntries: () => Array.from(lastBySub.values()),
		pollNow: tickOnce,
		refreshSubscription,
		refreshReportedEntries,
		async reset() {
			if (disposed) return;
			generation += 1;
			await refreshEntries(generation, undefined, true);
			if (!disposed) emitSnapshot();
		},
		dispose() {
			disposed = true;
			job?.stop();
			offConfig.dispose();
			offSubs.dispose();
		},
	};
}
