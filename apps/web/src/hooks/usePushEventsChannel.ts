import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { HistoryResponse } from "../services/dashboard";
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
