import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { onWsEvent, subscribeChannels } from "../services/wsSingleton";

/**
 * Subscribes to the WS `state` channel and invalidates relevant queries when
 * the server reports a config change. Mounted once at the app root so the
 * cache stays fresh across pages without each page re-subscribing.
 *
 * Server scopes (`config-changed.scope`):
 *   - "subscriptions" → invalidate ["subscriptions"]
 *   - "targets"       → invalidate ["targets"]
 *   - "globals"       → invalidate ["globals"]
 *   - "secrets"       → no client cache, ignored
 */
export function useStateChannel(): void {
	const qc = useQueryClient();
	useEffect(() => {
		subscribeChannels(["state"]);
		return onWsEvent((env) => {
			if (env.type !== "state") return;
			if (env.event !== "config-changed") return;
			const scope = (env.data as { scope?: string } | undefined)?.scope;
			if (scope === "subscriptions") qc.invalidateQueries({ queryKey: ["subscriptions"] });
			else if (scope === "targets") qc.invalidateQueries({ queryKey: ["targets"] });
			else if (scope === "globals") qc.invalidateQueries({ queryKey: ["globals"] });
		});
	}, [qc]);
}
