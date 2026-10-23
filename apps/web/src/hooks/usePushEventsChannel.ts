import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import {
	type DailyHistoryCountView,
	FOLLOWERS_QUERY_KEY,
	type FollowersResponse,
	HISTORY_DAILY_QUERY_KEY,
	HISTORY_QUERY_LIMITS,
	type HistoryDailyResponse,
	type HistoryResponse,
	historyQueryKey,
	type LiveListeningEntry,
	localDayKey,
} from "../services/dashboard";
import { isWsEvent, type WsEnvelope } from "../services/ws";
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
 * Server contract (apps/server/src/ws/channels.ts): `history-*` 帧的 `data` 是一份
 * {@link PushEventView} —— 历史行的 view,图片留文件名。各事件 `data` 的形状以 contract 的
 * `WsEvents` 为准。
 */
export const HISTORY_CACHE_CAP = 200;

/** toast 队列这边要用的两把:建行时弹卡,追加时换字。 */
export interface PushToastSink {
	push(view: PushEventView): void;
	replace(view: PushEventView): void;
}

/**
 * 把一份直播详情里面板画的几格就地补到在播快照里 `subscriptionId` 对得上的那一行:只补有的格,
 * `totalViewers` 只收有限数。快照还没拉、或没有这一行就原样不动(下一次失效重取会带上)。
 */
function patchLiveRow(
	qc: QueryClient,
	subscriptionId: string,
	details: { title?: string; category?: string; totalViewers?: number } | undefined,
): void {
	if (!details) return;
	const patch: Partial<LiveListeningEntry> = {};
	if (typeof details.title === "string") patch.title = details.title;
	if (typeof details.category === "string") patch.category = details.category;
	if (typeof details.totalViewers === "number" && Number.isFinite(details.totalViewers)) {
		patch.totalViewers = details.totalViewers;
	}
	if (Object.keys(patch).length === 0) return;
	qc.setQueryData<LiveListeningEntry[]>(["live", "listening"], (old) => {
		if (!old) return old;
		let touched = false;
		const next = old.map((r) => {
			if (r.subscriptionId !== subscriptionId) return r;
			touched = true;
			return { ...r, ...patch };
		});
		return touched ? next : old;
	});
}

/**
 * 处理 `push-events` 频道的单条 envelope。逻辑大表盘:
 *   - `live-session-changed`      → start / resume / end / unmatched-end / status(下播) → invalidate
 *                                    ["live","listening"];status(在播) 与 tick → 就地补那一行
 *                                    (title / category / totalViewers);ending 不动
 *   - `live-viewers-changed`      → setQueryData 按订阅 id 补那一行的 totalViewers(不存在则 silent);
 *                                    data 是 `{ subscriptionId, currentViewers?, totalViewers? }`
 *   - `followers-refreshed`            → setQueryData 整体覆盖 ["stats", "followers"];data 是 `{ entries }`
 *   - `history-recorded`          → push 进 toast + prepend 到 ["history"] 并 dedup 截尾
 *                                    + ["history-daily"] 今日桶就地 +1(跨零点则 invalidate;
 *                                    无目标行不计)
 *   - `history-updated`           → 按 id 换 ["history"] 里那一行 + toast 同 id 换字
 *                                    + 成败翻面时 ["history-daily"] 今日失败 ±1(行数不变)
 *
 * 提取成 export 纯函数,测试注入 `qc = new QueryClient()` + spy toast 即可覆盖。
 */
export function handlePushEnvelope(env: WsEnvelope, qc: QueryClient, toast: PushToastSink): void {
	// 场次的每一次变化(ADR-0019 决策 50:帧按订阅 id 认)。进表 / 出表的那几种让在播快照失效重取;
	// 在播状态与周期核对(tick)只是把这一场最新的几格带来,就地补那一行 —— 不整份重取。
	// 断流等待(`ending`)期间那一行还在表里,不动。
	if (isWsEvent(env, "push-events", "live-session-changed")) {
		const change = env.data;
		switch (change?.kind) {
			case "start":
			case "resume":
			case "end":
			case "unmatched-end":
				qc.invalidateQueries({ queryKey: ["live", "listening"] });
				return;
			case "status":
				if (!change.isLive) {
					qc.invalidateQueries({ queryKey: ["live", "listening"] });
					return;
				}
				patchLiveRow(qc, change.subscriptionId, change.session?.lastDetails);
				return;
			case "tick":
				patchLiveRow(qc, change.subscriptionId, change.session?.lastDetails);
				return;
			default:
				return;
		}
	}

	// 一条订阅的累计观看变了 —— 就地补那一行的 `totalViewers`。此刻在线(`currentViewers`)面板不画,
	// 不补、也不让面板重取(ADR-0019 决策 75)。订阅不在快照里(刚下播 / 列表还没拉)就静默跳过,
	// 下一次 invalidate 会顺带刷上。
	if (isWsEvent(env, "push-events", "live-viewers-changed")) {
		const subscriptionId = env.data?.subscriptionId;
		const totalViewers = env.data?.totalViewers;
		// 精确数(㉒d);不是有限的数(帧坏了)当没收到 —— 别把面板那一列写成「NaN」。
		if (
			typeof subscriptionId !== "string" ||
			typeof totalViewers !== "number" ||
			!Number.isFinite(totalViewers)
		)
			return;
		patchLiveRow(qc, subscriptionId, { totalViewers });
		return;
	}

	// FansPoller 每轮 cron tick / 订阅删除时推「本轮 enabled subs 的完整快照」。
	// 直接覆盖 ["stats", "followers"] 缓存 —— 被删除订阅的 uid 不在 payload 里,自然从面板撤掉。
	// 后端已保证"本轮失败保留旧值"语义在快照里完成,前端不需要 upsert。
	if (isWsEvent(env, "push-events", "followers-refreshed")) {
		const incoming = env.data?.entries;
		if (!Array.isArray(incoming)) return;
		qc.setQueryData<FollowersResponse>(FOLLOWERS_QUERY_KEY, { entries: incoming });
		return;
	}

	if (isWsEvent(env, "push-events", "history-updated")) {
		const data = env.data;
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
		// 建行之后才翻的状态也要进今日 KPI —— 服务端的按日聚合是照整行的最终状态数的,这边只加
		// 不改就会一直对不上。两种翻法:成败翻了面(@全体 落地失败把「已送达」翻成「部分失败」,
		// 行数不变);原先不算推送的行开始算了(被静音 / 免扰挡下的行补发成功,行数 +1)。
		// 缓存里没有旧的那一行就不知道翻没翻,宁可不动等下次重拉。
		if (prev) patchDailyStatusChange(qc, prev, data);
		return;
	}

	if (!isWsEvent(env, "push-events", "history-recorded")) return;
	const data = env.data;
	if (!data || typeof data.id !== "string") return;
	// 被静音 / 免扰挡下的行不弹小卡:那是主人自己要的安静,行在历史页里看得到。被过滤的作品留的那一行
	// 同理不弹(它的目标那一格也空着,但不是无目标行 —— 那张带「去配置」的小卡对它是错话)。
	if (data.status !== "silenced" && data.status !== "filtered") toast.push(data);
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
	patchDailyBucket(qc, data.createdAt, (day) => ({
		...day,
		counts: { ...day.counts, [data.feature]: (day.counts[data.feature] ?? 0) + 1 },
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

/**
 * 追加消息把一行的状态翻了 → 今日 KPI 跟着改,口径与服务端按日聚合(照整行最终状态数)一致:
 * - 原先不算推送、现在算了(被静音 / 免扰挡下的行补发出去了)→ 这一行进它**建行那天**的桶:
 *   行数与分类计数 +1,补发没成的话失败数也 +1;
 * - 一直算推送、成败翻了面 → 只动失败数,行数不变。
 */
function patchDailyStatusChange(qc: QueryClient, prev: PushEventView, next: PushEventView): void {
	// 无目标行压根不在日桶里(两头都不数),而且 target 一旦为空就不会再变;还是被挡着的行同理不动。
	if (!countsAsDelivery(next.status)) return;
	if (!countsAsDelivery(prev.status)) {
		patchDailyBucket(qc, next.createdAt, (day) => ({
			...day,
			counts: { ...day.counts, [next.feature]: (day.counts[next.feature] ?? 0) + 1 },
			total: day.total + 1,
			failures: day.failures + (countsAsFailure(next.status) ? 1 : 0),
		}));
		return;
	}
	const before = countsAsFailure(prev.status);
	const after = countsAsFailure(next.status);
	if (before === after) return;
	patchDailyBucket(qc, next.createdAt, (day) => ({
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
