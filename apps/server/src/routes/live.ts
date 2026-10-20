import type { LiveListeningEntry } from "@bilibili-notify/contract";
import { Hono } from "hono";
import { extensionLiveSnapshot } from "../live/live-table.js";
import type { RouteDeps } from "./types.js";

/**
 * `GET /api/live/listening` — currently-broadcasting rooms among the
 * subscribed UPs. Powers the dashboard's "正在直播" panel.
 *
 * Backed by the neutral live table's per-session snapshot. When the engine layer is not
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
		// R1 过渡输出(3b-22,3b-23 整段删):在册来源的行已由 `listLiveRooms()` 投影成上面那一半的形状,
		// 这里再列就是同一场两行。
		const extension = deps.runtime.liveTable
			.list()
			.filter((entry) => deps.runtime.sourceRegistry.get(entry.sourceKey) === undefined)
			.map(extensionLiveSnapshot);
		return c.json<LiveListeningEntry[]>([...bili, ...extension]);
	});
	return app;
}
