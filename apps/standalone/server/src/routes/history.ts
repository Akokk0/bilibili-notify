import { Hono } from "hono";
import type { RouteDeps } from "./types.js";

/**
 * `GET /api/history` — recent push events.
 *
 * Until BilibiliPush + history store land in apps/standalone/server (plan
 * stage 4 backend wiring), this returns an empty list so the dashboard's
 * timeline + StatsBar can render their design's empty state without erroring.
 *
 * Query parameters (forward-compatible — silently ignored for now):
 *   - limit: int     — max entries (default 100, capped 500)
 *   - since: ISO ts  — only entries strictly after this timestamp
 */

export interface HistoryEntryView {
	id: string;
	ts: string;
	source:
		| "dynamic"
		| "live"
		| "sc"
		| "guard"
		| "special-danmaku"
		| "special-enter"
		| "live-summary";
	uid: string;
	subscriptionId: string;
	targetIds: string[];
	ok: boolean;
	text?: string;
}

export interface HistoryResponse {
	entries: HistoryEntryView[];
	cursor?: string;
}

export function createHistoryRoute(_deps: RouteDeps): Hono {
	const app = new Hono();
	app.get("/", (c) => c.json<HistoryResponse>({ entries: [] }));
	return app;
}
