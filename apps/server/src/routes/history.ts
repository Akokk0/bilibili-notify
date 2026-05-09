import { createReadStream, statSync } from "node:fs";
import { join } from "node:path";
import type { HistorySource } from "@bilibili-notify/internal";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import type { RouteDeps } from "./types.js";

/**
 * `GET /api/history`             — recent push events (most-recent-first)
 * `GET /api/history/img/:name`   — static fileserver for entry-attached images
 *
 * Query parameters for the listing endpoint:
 *   - limit:  int        (default 100, capped 500)
 *   - since:  ISO ts     (only entries strictly after this)
 *   - source: history kind ('dynamic' | 'live' | …)
 *   - uid:    bilibili UID
 */

export interface HistoryEntryView {
	id: string;
	ts: string;
	source: HistorySource;
	uid: string;
	subscriptionId: string;
	targetIds: string[];
	ok: boolean;
	text?: string;
	imageRef?: string;
}

export interface HistoryResponse {
	entries: HistoryEntryView[];
}

const VALID_SOURCES: ReadonlySet<HistorySource> = new Set([
	"dynamic",
	"live",
	"sc",
	"guard",
	"special-danmaku",
	"special-enter",
	"live-summary",
]);

export function createHistoryRoute(deps: RouteDeps): Hono {
	const app = new Hono();

	app.get("/", async (c) => {
		const limitRaw = c.req.query("limit");
		const limit = limitRaw ? Math.max(1, Math.min(500, Number(limitRaw))) : 100;
		const since = c.req.query("since");
		const sourceParam = c.req.query("source") as HistorySource | undefined;
		const source = sourceParam && VALID_SOURCES.has(sourceParam) ? sourceParam : undefined;
		const uid = c.req.query("uid");

		const entries = await deps.runtime.historyStore.query({
			limit,
			since,
			source,
			uid,
		});

		const view: HistoryEntryView[] = entries.map((e) => ({
			id: e.id,
			ts: e.ts,
			source: e.source,
			uid: e.uid,
			subscriptionId: e.subscriptionId,
			targetIds: e.targetIds,
			ok: e.result.ok,
			text: e.payload.text,
			imageRef: e.payload.imageRef,
		}));
		return c.json<HistoryResponse>({ entries: view });
	});

	// Image attachments. We resolve under the history image dir; reject any
	// path that escapes it (defence-in-depth — `..` segments would otherwise
	// reach the dataDir). Image bytes are written by the HistoryStore as
	// `<entryId>.<ext>` so the lookup is direct.
	app.get("/img/:name", async (c) => {
		const name = c.req.param("name");
		if (!/^[A-Za-z0-9_.-]+$/.test(name)) return c.text("bad request", 400);
		const dir = deps.runtime.historyStore.imageDir();
		const path = join(dir, name);
		try {
			const stat = statSync(path);
			if (!stat.isFile()) return c.text("not found", 404);
			const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
			const mime = extToMime(ext);
			c.header("Content-Type", mime);
			c.header("Content-Length", String(stat.size));
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

function extToMime(ext: string): string {
	switch (ext) {
		case "png":
			return "image/png";
		case "webp":
			return "image/webp";
		case "gif":
			return "image/gif";
		default:
			return "image/jpeg";
	}
}
