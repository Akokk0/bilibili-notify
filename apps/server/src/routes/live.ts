import type { LiveListeningEntry } from "@bilibili-notify/contract";
import { Hono } from "hono";
import { extensionLiveSnapshot } from "../runtime/extension-live.js";
import type { RouteDeps } from "./types.js";

/**
 * `GET /api/live/listening` — currently-broadcasting rooms among the
 * subscribed UPs. Powers the dashboard's "正在直播" panel.
 *
 * Backed by the LiveEngine's per-session liveStatus snapshot (set by the WS
 * dispatcher on `onLiveStart` / `handleLiveEnd`). When the engine layer is not
 * attached yet (early boot, before authSystem is up) the B 站 half is `[]`
 * so the panel renders empty state cleanly.
 *
 * 拓展订阅的在播(ADR-0019 决策 12 / 57)从在播表来,并在 B 站那几行后面 —— 它不靠直播引擎,
 * 引擎还没挂上时照样有。B 站那几行原样,一格不动。
 */

export function createLiveRoute(deps: RouteDeps): Hono {
	const app = new Hono();
	app.get("/listening", (c) => {
		const bili = deps.runtime.engines?.listLiveRooms() ?? [];
		const extension = deps.runtime.extensionLive.list().map(extensionLiveSnapshot);
		return c.json<LiveListeningEntry[]>([...bili, ...extension]);
	});
	return app;
}
