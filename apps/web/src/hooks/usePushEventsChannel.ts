import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import {
	type DailyHistoryCountView,
	type FansEntry,
	type FansResponse,
	HISTORY_DAILY_QUERY_KEY,
	HISTORY_QUERY_LIMITS,
	type HistoryDailyResponse,
	type HistoryResponse,
	historyQueryKey,
	type LiveListenerSnapshot,
	localDayKey,
} from "../services/dashboard";
import type { WsEnvelope } from "../services/ws";
import { onWsEvent, subscribeChannels } from "../services/wsSingleton";
import { type PushEventView, useToastStore } from "../store/notifications";
import { countsAsDelivery, countsAsFailure } from "../types/domain";

/**
 * Subscribes to the WS `push-events` channel and forks each `history-recorded`
 * envelope two ways:
 *   1. push into the toast queue ({@link useToastStore}) for the right-bottom
 *      pop-up,
 *   2. prepend into the react-query `['history']` cache so any page
 *      (Dashboard / History) consuming that key sees the new entry within ~1s
 *      without waiting for the next poll.
 *
 * `history-updated`(同一行追加了消息)按 id 把缓存里那一行换掉、小卡同 id 换字 ——
 * 不新增、不重弹;行数不变,只有成败翻了面时把今日失败数 ±1。
 *
 * Capped at {@link HISTORY_CACHE_CAP} entries — matches the History page's
 * fetch limit so we don't unboundedly grow the in-memory list during long-
 * running dashboards.
 *
 * Server contract (apps/server/src/ws/channels.ts): envelope.data is a
 * {@link PushEventView} — the history row view, image refs as filenames.
 */
export const HISTORY_CACHE_CAP = 200;

/** toast 队列这边要用的两把:建行时弹卡,追加时换字。 */
export interface PushToastSink {
	push(view: PushEventView): void;
	replace(view: PushEventView): void;
}

/**
 * 处理 `push-events` 频道的单条 envelope。逻辑大表盘:
 *   - `live-state-changed`        → invalidate ["live","listening"]
 *   - `live-viewers-changed`      → setQueryData patch 该房间的 viewers(不存在则 silent)
 *   - `fans-refreshed`            → setQueryData 整体覆盖 ["fans"]
 *   - `history-recorded`          → push 进 toast + prepend 到 ["history"] 并 dedup 截尾
 *                                    + ["history-daily"] 今日桶就地 +1(跨零点则 invalidate;
 *                                    无目标行不计)
 *   - `history-updated`           → 按 id 换 ["history"] 里那一行 + toast 同 id 换字
 *                                    + 成败翻面时 ["history-daily"] 今日失败 ±1(行数不变)
 *
 * 提取成 export 纯函数,测试注入 `qc = new QueryClient()` + spy toast 即可覆盖。
 */
export function handlePushEnvelope(env: WsEnvelope, qc: QueryClient, toast: PushToastSink): void {
	if (env.type !== "push-events") return;

	// 直播状态翻转 → 让 ["live","listening"] 失效,Dashboard 立即重 fetch。
	// 后端只在真实 transition 时 emit("live-state-changed"),所以这里不会刷屏。
	if (env.event === "live-state-changed") {
		qc.invalidateQueries({ queryKey: ["live", "listening"] });
		return;
	}

	// 累计观看人数变化 —— 后端 per-UID 2s 节流过的稀疏事件,直接 setQueryData
	// 局部 patch 该房间的 viewers 字段。0 额外 HTTP,Dashboard 数字即时跳。
	// 房间不在快照里(可能刚下播 / 列表还没拉)就静默跳过,下一次 invalidate
	// 会顺带刷上。
	if (env.event === "live-viewers-changed") {
		const tuple = env.data as [string, string] | undefined;
		if (tuple?.length !== 2) return;
		const [uid, viewers] = tuple;
		qc.setQueryData<LiveListenerSnapshot[]>(["live", "listening"], (old) => {
			if (!old) return old;
			let touched = false;
			const next = old.map((r) => {
				if (r.uid !== uid) return r;
				touched = true;
				return { ...r, viewers };
			});
			return touched ? next : old;
		});
		return;
	}

	// FansPoller 每轮 cron tick / 订阅删除时推「本轮 enabled subs 的完整快照」。
	// 直接覆盖 ["fans"] 缓存 —— 被删除订阅的 uid 不在 payload 里,自然从面板撤掉。
	// 后端已保证"本轮失败保留旧值"语义在快照里完成,前端不需要 upsert。
	if (env.event === "fans-refreshed") {
		const incoming = env.data as FansEntry[] | undefined;
		if (!Array.isArray(incoming)) return;
		qc.setQueryData<FansResponse>(["fans"], { entries: incoming });
		return;
	}

	if (env.event === "history-updated") {
		const data = env.data as PushEventView | undefined;
		if (!data || typeof data.id !== "string") return;
		// 只换不插:不在缓存里说明它比缓存里最老的还老,塞进来会乱序。
		let prev: PushEventView | undefined;
		for (const limit of HISTORY_QUERY_LIMITS) {
			qc.setQueryData<HistoryResponse>(historyQueryKey(limit), (old) => {
				const found = old?.entries.find((e) => e.id === data.id);
				if (!old || !found) return old;
				prev ??= found;
				return { entries: old.entries.map((e) => (e.id === data.id ? data : e)) };
			});
		}
		toast.replace(data);
		// 建行之后才翻的状态(@全体 落地失败把「已送达」翻成「部分失败」)也要进今日 KPI ——
		// 服务端的按日聚合是照整行的最终状态数的,这边只加不改就会一直少一条。翻的只有
		// 失败与否,行数不变;缓存里没有旧的那一行就不知道翻没翻,宁可不动等下次重拉。
		if (prev) patchDailyFailureFlip(qc, prev, data);
		return;
	}

	if (env.event !== "history-recorded") return;
	const data = env.data as PushEventView | undefined;
	if (!data || typeof data.id !== "string") return;
	toast.push(data);
	// HI1:history 缓存现按 limit 分键 —— Dashboard ["history",{limit:100}]、
	// History 页 ["history",{limit:200}]。显式 patch 两者(setQueryData 在键
	// 不存在时也会 prime,setQueriesData 不会 → WS 早于页面挂载时会丢更新)。
	const patchHistory = (old: HistoryResponse | undefined): HistoryResponse => {
		const prev = old?.entries ?? [];
		// Dedup by id in case the same envelope arrives twice (WS reconnect
		// resubscribe race) — keeps the most recent copy on top.
		const without = prev.filter((e) => e.id !== data.id);
		return { entries: [data, ...without].slice(0, HISTORY_CACHE_CAP) };
	};
	for (const limit of HISTORY_QUERY_LIMITS) {
		qc.setQueryData<HistoryResponse>(historyQueryKey(limit), patchHistory);
	}

	// 按日聚合缓存(本周推送趋势 + 今日 KPI):今天的桶就地 +1,零额外 HTTP。
	// 「今日推送」数的是推到了多少个地方:无目标行没推到任何地方,不进计数(口径与服务端
	// 的按日聚合同吃 internal 的那一份)。
	if (!countsAsDelivery(data.status)) return;
	patchDailyBucket(qc, data.ts, (day) => ({
		...day,
		counts: { ...day.counts, [data.kind]: (day.counts[data.kind] ?? 0) + 1 },
		total: day.total + 1,
		failures: day.failures + (countsAsFailure(data.status) ? 1 : 0),
	}));
}

/**
 * 日桶就地改:找到 ts 所属的本地日那一格,交给 mut 改。所属日不在缓存窗口(客户端跨零点
 * 后窗口未前滚)→ invalidate 整键重拉,窗口顺带翻篇。缓存不存在(Dashboard 从未拉过)则
 * 不 prime —— 挂载时的首次 fetch 天然包含本条,凭空造一个窗口反而是假数据。
 */
function patchDailyBucket(
	qc: QueryClient,
	ts: string,
	mut: (day: DailyHistoryCountView) => DailyHistoryCountView,
): void {
	let dayMissed = false;
	qc.setQueryData<HistoryDailyResponse>(HISTORY_DAILY_QUERY_KEY, (old) => {
		if (!old) return old;
		const key = localDayKey(new Date(ts));
		const idx = old.days.findIndex((x) => x.d === key);
		if (idx < 0) {
			dayMissed = true;
			return old;
		}
		const day = old.days[idx] as DailyHistoryCountView;
		return { days: old.days.map((x, i) => (i === idx ? mut(day) : x)) };
	});
	if (dayMissed) qc.invalidateQueries({ queryKey: HISTORY_DAILY_QUERY_KEY });
}

/** 追加消息把一行的成败翻了面 → 今日失败数跟着 ±1。行数不变,别动 total 与分类计数。 */
function patchDailyFailureFlip(qc: QueryClient, prev: PushEventView, next: PushEventView): void {
	// 无目标行压根不在日桶里(两头都不数),而且 target 一旦为空就不会再变。
	if (!countsAsDelivery(prev.status) || !countsAsDelivery(next.status)) return;
	const before = countsAsFailure(prev.status);
	const after = countsAsFailure(next.status);
	if (before === after) return;
	patchDailyBucket(qc, next.ts, (day) => ({
		...day,
		failures: Math.max(0, day.failures + (after ? 1 : -1)),
	}));
}

export function usePushEventsChannel(): void {
	const push = useToastStore((s) => s.push);
	const replace = useToastStore((s) => s.replace);
	const toast = useMemo<PushToastSink>(() => ({ push, replace }), [push, replace]);
	const qc = useQueryClient();
	useEffect(() => {
		subscribeChannels(["push-events"]);
		return onWsEvent((env) => handlePushEnvelope(env, qc, toast));
	}, [toast, qc]);
}
