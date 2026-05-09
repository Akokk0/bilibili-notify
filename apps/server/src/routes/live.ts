import { Hono } from "hono";
import type { RouteDeps } from "./types.js";

/**
 * `GET /api/live/listening` — currently-watched live rooms.
 *
 * The dashboard's "正在直播" panel polls this. Backed by the LiveEngine's
 * listener manager. When the engine layer is not attached (early boot, before
 * authSystem is up) the route returns `[]` so the panel renders its empty
 * state cleanly.
 */
export interface LiveListenerSnapshot {
	uid: string;
	roomId?: string;
	title?: string;
	cover?: string;
	viewers?: number;
	startedAt?: string;
	areaName?: string;
}

export function createLiveRoute(deps: RouteDeps): Hono {
	const app = new Hono();
	app.get("/listening", (c) => {
		const engines = deps.runtime.engines;
		if (!engines) return c.json<LiveListenerSnapshot[]>([]);
		const uids = engines.listListeningUids();
		return c.json<LiveListenerSnapshot[]>(uids.map((uid) => ({ uid })));
	});
	return app;
}
