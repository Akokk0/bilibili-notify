import type { BilibiliAPI } from "@bilibili-notify/api";
import type {
	CachedProfile,
	ConfigScope,
	Disposable,
	FansRefreshEntry,
	Logger,
	MessageBus,
	ServiceContext,
} from "@bilibili-notify/internal";
import type { SubscriptionStore } from "@bilibili-notify/subscription";
import { CronJob } from "cron";
import type { ConfigStore } from "../config/store.js";
import type { FansStore } from "../fans/store.js";
import type { SubRuntime, SubRuntimeStore } from "./sub-runtime-store.js";

const ONE_HOUR_MS = 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * ONE_HOUR_MS;
const SEVEN_DAYS_MS = 7 * 24 * ONE_HOUR_MS;

export interface FansPollerOptions {
	bus: MessageBus;
	logger: Logger;
	/** Only read for `getGlobals().app.dynamicCron` (cron reconcile). NOT written. */
	configStore: ConfigStore;
	subscriptionStore: SubscriptionStore;
	/**
	 * Per-tick cachedProfile.fans / lastRefreshedAt (+ first-time fansBaseline)
	 * persist here — NOT via configStore.patchSubscription. That decoupling is
	 * the whole point: it stops the `config-changed:subscriptions` fan-out that
	 * re-triggered DynamicEngine every tick (the Logs-Tab `[ops]` flooding bug).
	 */
	subRuntimeStore: SubRuntimeStore;
	fansStore: FansStore;
	api: BilibiliAPI;
	/**
	 * 用于 dispose-safe 延时(首次 tick 等 auth 起来的 3s 窗口)。dispose() 时
	 * runtime 一并清掉 pending timer,避免 stop/restart 期间裸 setTimeout 留 3s
	 * 空跑句柄。同 packages/push / packages/api 的 P1-B 风格。
	 */
	serviceCtx: ServiceContext;
}

export interface FansPollerHandle extends Disposable {
	/**
	 * 最近一轮成功采样的 entries 快照。GET /api/fans 直接读这个,免去对 jsonl
	 * 的同步查询。Bootstrap 前为空数组;第一轮 tick(启动时立即触发)结束后即填充。
	 */
	getLastEntries(): FansRefreshEntry[];
}

/**
 * Per-tick:遍历所有 enabled subs,逐个拉 B 站 `getUserCardInfo` 取 fans;
 *
 *   1. 追加一行样本到 FansStore(<dataDir>/fans/<uid>.jsonl);
 *   2. 第一次见该 sub → 把当前值作为 fansBaseline(订阅起点)写进 SubRuntimeStore;
 *   3. 同步更新 SubRuntimeStore 里该 sub 的 cachedProfile.fans + lastRefreshedAt
 *      (不再走 configStore.patchSubscription —— 见 FansPollerOptions 注释);
 *   4. 计算 24h / 7d 窗口的 delta(从 jsonl 找近似时间点的最近样本);
 *   5. 单次轮询全部完成后 emit `fans-refreshed`(entries);
 *
 * 失败处理:per-uid try/catch,单 UP 失败不阻断剩余轮询。串行 + 200ms 间隔
 * 减小被 B 站风控的概率。cron 用 globals.app.dynamicCron(默认每 2min 一轮),
 * 用户改 cron 表达式会通过 config-changed 通道触发本 poller reconcile。
 *
 * auth-lost / auth-restored:auth 丢失期间任何调用都会失败,所以 poller 不
 * 自己暂停,而是依赖 BilibiliAPI 内部状态;失败的轮次产出全 null delta,前
 * 端面板会显示 "—"。这样 auth 恢复后无需重新初始化 poller。
 */
export function startFansPoller(opts: FansPollerOptions): FansPollerHandle {
	const {
		bus,
		logger,
		configStore,
		subscriptionStore,
		subRuntimeStore,
		fansStore,
		api,
		serviceCtx,
	} = opts;

	let currentCron = configStore.getGlobals().app.dynamicCron;
	let job: CronJob | undefined;
	let running = false;
	let disposed = false;
	// uid → 最近一次成功采样。replace,不累加。每轮跑完整体替换为新一批,但
	// 跳过本轮没采到的 uid(保留上一轮的值,避免间歇性失败导致 dashboard 数字闪烁)。
	const lastByUid = new Map<string, FansRefreshEntry>();

	function tick(): void {
		if (disposed) return;
		if (running) {
			logger.debug("[fans-poller] previous tick still running, skipping");
			return;
		}
		running = true;
		runTick()
			.catch((err) => logger.warn(`[fans-poller] tick failed: ${String(err)}`))
			.finally(() => {
				running = false;
			});
	}

	async function runTick(): Promise<void> {
		if (disposed) return;
		const subs = subscriptionStore.list().filter((s) => s.enabled);
		// Sweep:lastByUid 只保留当前 enabled subs;被删除 / 禁用的 uid 同步 dropUid
		// 清掉时序文件。这样下游 emit 出去的快照不会再含失效 uid,前端覆盖式 setQueryData
		// 自然把已删订阅的卡片从 dashboard 上撤掉。
		const currentUids = new Set(subs.map((s) => s.uid));
		for (const oldUid of Array.from(lastByUid.keys())) {
			if (!currentUids.has(oldUid)) {
				lastByUid.delete(oldUid);
				void fansStore.dropUid(oldUid);
			}
		}
		if (subs.length === 0) {
			// 全部被删除时仍要 emit 一次空快照让前端清屏。
			bus.emit("fans-refreshed", []);
			return;
		}
		logger.debug(`[fans-poller] tick start, ${subs.length} subs`);
		const now = new Date();
		const nowIso = now.toISOString();
		const target24hIso = new Date(now.getTime() - TWENTY_FOUR_HOURS_MS).toISOString();
		const target7dIso = new Date(now.getTime() - SEVEN_DAYS_MS).toISOString();

		for (const sub of subs) {
			// 每个 await 之后必须重新 check disposed,否则 await 期间 dispose 触发,
			// 返回后会继续 append/patch/emit 出残留副作用。
			if (disposed) return;
			try {
				const res = await api.getUserCardInfo(sub.uid);
				if (disposed) return;
				if (res.code !== 0 || !res.data?.card) {
					logger.warn(
						`[fans-poller] uid=${sub.uid} upstream code=${res.code} msg=${
							(res as { message?: string }).message ?? "?"
						}`,
					);
					continue;
				}
				const current = res.data.card.fans;
				if (typeof current !== "number" || current < 0) continue;

				await fansStore.append(sub.uid, { ts: nowIso, value: current });
				if (disposed) return;

				const [near24h, near7d] = await Promise.all([
					fansStore.findNearestBefore(sub.uid, target24hIso),
					fansStore.findNearestBefore(sub.uid, target7dIso),
				]);
				if (disposed) return;

				const prev = subRuntimeStore.get(sub.id);
				const baseline = prev?.fansBaseline;
				const nextBaseline = baseline ?? { value: current, ts: nowIso };
				const deltaSubscribed = current - nextBaseline.value;

				const delta24h = near24h ? current - near24h.value : null;
				const delta7d = near7d ? current - near7d.value : null;

				// 写进 SubRuntimeStore(独立文件 + 原子写,**不发** config-changed)——
				// fansBaseline 首次写、cachedProfile.fans/lastRefreshedAt 每次写。
				// name/avatar/sign 沿用既有(POST 自 seed / 上一次),缺失才从 card 兜底。
				const cachedProfile: CachedProfile = {
					...(prev?.cachedProfile ?? {
						name: res.data.card.name ?? sub.uid,
						avatar: res.data.card.face ?? "",
						sign: res.data.card.sign ?? "",
					}),
					fans: current,
					lastRefreshedAt: nowIso,
				};
				const runtimePatch: SubRuntime = { cachedProfile };
				if (!baseline) runtimePatch.fansBaseline = nextBaseline;
				try {
					await subRuntimeStore.patch(sub.id, runtimePatch);
				} catch (err) {
					logger.warn(`[fans-poller] persist ${sub.uid} failed: ${String(err)}`);
				}
				if (disposed) return;

				const entry: FansRefreshEntry = {
					uid: sub.uid,
					current,
					ts: nowIso,
					deltaSubscribed,
					delta24h,
					delta7d,
				};
				lastByUid.set(sub.uid, entry);
			} catch (err) {
				logger.warn(`[fans-poller] uid=${sub.uid} failed: ${String(err)}`);
			}
			// 200ms 间隔,串行 + 节流,避免 cookies 风控。
			await new Promise((r) => setTimeout(r, 200));
		}

		// 每轮固定 emit 一次「全部 enabled subs 的当前快照」,前端做覆盖式
		// setQueryData,从而正确反映"本轮失败保留旧值"+"删除订阅即时撤掉"两种语义。
		if (disposed) return;
		const snapshot = Array.from(lastByUid.values());
		bus.emit("fans-refreshed", snapshot);
		logger.debug(`[fans-poller] tick done, snapshot=${snapshot.length}`);
	}

	function startJob(): void {
		job = new CronJob(currentCron, tick);
		job.start();
		logger.info(`[fans-poller] scheduled with cron='${currentCron}'`);
	}

	function reconcileCron(): void {
		const next = configStore.getGlobals().app.dynamicCron;
		if (next === currentCron) return;
		logger.info(`[fans-poller] cron changed: '${currentCron}' → '${next}'`);
		job?.stop();
		currentCron = next;
		startJob();
	}

	/**
	 * 重启恢复:从每个 enabled sub 的 fans/<uid>.jsonl 末尾读最近一条样本,填进
	 * lastByUid 并立即 emit 一次。这样 Dashboard 首屏不会因为新一轮 tick 还没跑完
	 * 就空白。窗口 delta(24h/7d)留给第一次正式 tick 计算。
	 */
	async function restoreFromDisk(): Promise<void> {
		if (disposed) return;
		// 用一个"远未来"时间戳让 findNearestBefore 退化为"取最近一条"。
		const futureIso = "9999-12-31T00:00:00.000Z";
		const subs = subscriptionStore.list().filter((s) => s.enabled);
		for (const sub of subs) {
			if (disposed) return;
			try {
				const last = await fansStore.findNearestBefore(sub.uid, futureIso);
				if (!last) continue;
				const baseline = subRuntimeStore.get(sub.id)?.fansBaseline;
				const deltaSubscribed = baseline ? last.value - baseline.value : 0;
				lastByUid.set(sub.uid, {
					uid: sub.uid,
					current: last.value,
					ts: last.ts,
					deltaSubscribed,
					delta24h: null,
					delta7d: null,
				});
			} catch (err) {
				logger.debug(`[fans-poller] restore ${sub.uid} skipped: ${String(err)}`);
			}
		}
		if (lastByUid.size > 0 && !disposed) {
			bus.emit("fans-refreshed", Array.from(lastByUid.values()));
			logger.info(`[fans-poller] restored ${lastByUid.size} entries from disk`);
		}
	}

	startJob();
	// 先从磁盘恢复历史 entries 给首屏用,然后延后 3s 才发首轮 tick — 给 auth /
	// LoginFlow 起来的窗口期,降低"第一次 tick 撞 auth 未就绪 → 每个 sub 打一行
	// warn + 首屏全 —"的概率。
	void (async () => {
		await restoreFromDisk();
		if (disposed) return;
		await new Promise<void>((resolveFirstTick) => {
			serviceCtx.setTimeout(resolveFirstTick, 3000);
		});
		if (disposed) return;
		tick();
	})();

	const offConfig = bus.on("config-changed", (scope: ConfigScope) => {
		if (scope !== "globals") return;
		reconcileCron();
	});

	// 订阅被删除时立即清理 in-memory entry + jsonl 时序,并 emit 一次空 diff 让
	// dashboard 立刻把该 UP 从面板上撤掉(无需等下一 cron tick)。
	const offSubs = bus.on("subscription-changed", (ops) => {
		let removedAny = false;
		let hadRemove = false;
		for (const op of ops) {
			if (op.type !== "remove") continue;
			hadRemove = true;
			if (lastByUid.has(op.uid)) {
				lastByUid.delete(op.uid);
				removedAny = true;
			}
			void fansStore.dropUid(op.uid);
		}
		if (hadRemove) {
			// Drop the deleted sub's SubRuntimeStore entry. subscriptionStore
			// already reflects the post-delete set when this fires (config-changed
			// → bridge replaceAll → subscription-changed), so a keep-set prune is
			// precise + idempotent and avoids a dedicated delete(id) API.
			void subRuntimeStore.prune(subscriptionStore.list().map((s) => s.id));
		}
		if (removedAny) {
			bus.emit("fans-refreshed", Array.from(lastByUid.values()));
		}
	});

	return {
		dispose(): void {
			disposed = true;
			job?.stop();
			offConfig.dispose();
			offSubs.dispose();
			// 不主动 await in-flight tick(Disposable 接口为 void);runTick 内会在每个
			// await 后 check disposed,中途返回,新副作用不会出现。
		},
		getLastEntries(): FansRefreshEntry[] {
			return Array.from(lastByUid.values());
		},
	};
}
