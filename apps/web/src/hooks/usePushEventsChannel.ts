import { useEffect } from "react";
import { onWsEvent, subscribeChannels } from "../services/wsSingleton";
import { type PushEventView, useToastStore } from "../store/notifications";

/**
 * Subscribes to the WS `push-events` channel and pushes incoming `history-recorded`
 * envelopes into the toast queue (`useToastStore`). Mounted once at the app
 * root; each toast auto-dismisses on its own timer driven by {@link ToastShell}.
 *
 * Server contract (apps/server/src/ws/channels.ts): envelope.data is a
 * {@link PushEventView} — a flattened HistoryEntry view, image refs as filenames.
 */
export function usePushEventsChannel(): void {
	const push = useToastStore((s) => s.push);
	useEffect(() => {
		subscribeChannels(["push-events"]);
		return onWsEvent((env) => {
			if (env.type !== "push-events") return;
			if (env.event !== "history-recorded") return;
			const data = env.data as PushEventView | undefined;
			if (!data || typeof data.id !== "string") return;
			push(data);
		});
	}, [push]);
}
