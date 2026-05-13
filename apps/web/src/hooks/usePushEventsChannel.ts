import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type {
	FansEntry,
	FansResponse,
	HistoryResponse,
	LiveListenerSnapshot,
} from "../services/dashboard";
import { onWsEvent, subscribeChannels } from "../services/wsSingleton";
import { type PushEventView, useToastStore } from "../store/notifications";

/**
 * Subscribes to the WS `push-events` channel and forks each `history-recorded`
 * envelope two ways:
 *   1. push into the toast queue ({@link useToastStore}) for the right-bottom
 *      pop-up,
 *   2. prepend into the react-query `['history']` cache so any page
 *      (Dashboard / History) consuming that key sees the new entry within ~1s
 *      without waiting for the next poll.
 *
 * Capped at {@link HISTORY_CACHE_CAP} entries — matches the History page's
 * fetch limit so we don't unboundedly grow the in-memory list during long-
 * running dashboards.
 *
 * Server contract (apps/server/src/ws/channels.ts): envelope.data is a
 * {@link PushEventView} — a flattened HistoryEntry view, image refs as filenames.
 */
const HISTORY_CACHE_CAP = 200;

export function usePushEventsChannel(): void {
	const push = useToastStore((s) => s.push);
	const qc = useQueryClient();
	useEffect(() => {
		subscribeChannels(["push-events"]);
		return onWsEvent((env) => {
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
				if (!tuple || tuple.length !== 2) return;
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

			if (env.event !== "history-recorded") return;
			const data = env.data as PushEventView | undefined;
			if (!data || typeof data.id !== "string") return;
			push(data);
			qc.setQueryData<HistoryResponse>(["history"], (old) => {
				const prev = old?.entries ?? [];
				// Dedup by id in case the same envelope arrives twice (WS reconnect
				// resubscribe race) — keeps the most recent copy on top.
				const without = prev.filter((e) => e.id !== data.id);
				const merged = [data, ...without].slice(0, HISTORY_CACHE_CAP);
				return { entries: merged };
			});
		});
	}, [push, qc]);
}
