import type { LiveListeningEntry } from "@bilibili-notify/contract";
import { Hono } from "hono";
import { liveListeningEntryOf } from "../live/live-table.js";
import type { RouteDeps } from "./types.js";

/**
 * `GET /api/live/listening` — 首页「正在直播」里的那些订阅,形状只有一种。
 * 在播表不靠直播引擎,开机早期也有;身份从订阅仓补,订阅不在的行不列。
 */

export function createLiveRoute(deps: RouteDeps): Hono {
	const app = new Hono();
	app.get("/listening", (c) => {
		const subscriptions = new Map(deps.store.getSubscriptions().map((sub) => [sub.id, sub]));
		const listening = deps.runtime.liveTable.list().flatMap((entry) => {
			const sub = subscriptions.get(entry.subscriptionId);
			return sub === undefined ? [] : [liveListeningEntryOf(entry, sub.identity)];
		});
		return c.json<LiveListeningEntry[]>(listening);
	});
	return app;
}
