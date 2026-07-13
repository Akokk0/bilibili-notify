import type { LiveListenerSnapshot } from "@bilibili-notify/contract";
import { Hono } from "hono";
import type { RouteDeps } from "./types.js";

/**
 * `GET /api/live/listening` — currently-broadcasting rooms among the
 * subscribed UPs. Powers the dashboard's "正在直播" panel.
 *
 * Backed by the LiveEngine's per-session liveStatus snapshot (set by the WS
 * dispatcher on `onLiveStart` / `handleLiveEnd`). When the engine layer is not
 * attached yet (early boot, before authSystem is up) the route returns `[]`
 * so the panel renders empty state cleanly.
 */

export function createLiveRoute(deps: RouteDeps): Hono {
	const app = new Hono();
	app.get("/listening", (c) => {
		const engines = deps.runtime.engines;
		if (!engines) return c.json<LiveListenerSnapshot[]>([]);
		return c.json<LiveListenerSnapshot[]>(engines.listLiveRooms());
	});
	return app;
}
