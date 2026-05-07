import { Hono } from "hono";
import type { RouteDeps } from "./types.js";

/**
 * Currently-watched live rooms. Per plan §三, dashboard "正在直播" panel reads
 * this. Until LiveEngine lands in apps/standalone/server (stage 4 backend
 * wiring), the route returns an empty list so the front-end renders its
 * design's empty state without erroring.
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

export function createLiveRoute(_deps: RouteDeps): Hono {
	const app = new Hono();
	app.get("/listening", (c) => c.json<LiveListenerSnapshot[]>([]));
	return app;
}
