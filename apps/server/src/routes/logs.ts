import { createReadStream, statSync } from "node:fs";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import type { LogArchiveEntry } from "../logs/store.js";
import type { RouteDeps } from "./types.js";

/**
 * `GET /api/logs`            — recent archived log lines, most-recent-first
 * `GET /api/logs/raw`        — download one day's raw jsonl (attachment)
 *
 * Server-side params are intentionally minimal — only `limit` (+ optional
 * `day`) — mirroring `/api/history`: the Logs tab does level / source / text
 * filtering CLIENT-side over a stable query key so the WS `log` tail can
 * `setQueryData`-append without the key shifting under it.
 *
 *   - limit: int   (default 200, capped 500)
 *   - day:   YYYY-MM-DD  (restrict to that day file; omit = recent days)
 */

export interface LogsResponse {
	entries: LogArchiveEntry[];
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function createLogsRoute(deps: RouteDeps): Hono {
	const app = new Hono();

	app.get("/", async (c) => {
		const limitRaw = c.req.query("limit");
		let limit = 200;
		if (limitRaw !== undefined) {
			const n = Number(limitRaw);
			if (!Number.isFinite(n)) {
				return c.json({ error: "invalid_query", message: `invalid limit: ${limitRaw}` }, 400);
			}
			limit = Math.max(1, Math.min(500, Math.trunc(n)));
		}
		const day = c.req.query("day");
		if (day !== undefined && !DAY_RE.test(day)) {
			return c.json(
				{ error: "invalid_query", message: `invalid day (expect YYYY-MM-DD): ${day}` },
				400,
			);
		}

		const entries = await deps.runtime.logStore.query({ limit, day });
		return c.json<LogsResponse>({ entries });
	});

	app.get("/raw", async (c) => {
		const day = c.req.query("day");
		if (!day || !DAY_RE.test(day)) {
			return c.json(
				{ error: "invalid_query", message: `day required (YYYY-MM-DD): ${day ?? ""}` },
				400,
			);
		}
		const path = deps.runtime.logStore.dayFilePath(day);
		try {
			const stat = statSync(path);
			if (!stat.isFile()) return c.text("not found", 404);
			c.header("Content-Type", "application/x-ndjson; charset=utf-8");
			c.header("Content-Length", String(stat.size));
			c.header("Content-Disposition", `attachment; filename="bilibili-notify-${day}.jsonl"`);
			return stream(c, async (s) => {
				const file = createReadStream(path);
				for await (const chunk of file) s.write(chunk as Buffer);
			});
		} catch {
			return c.text("not found", 404);
		}
	});

	return app;
}
