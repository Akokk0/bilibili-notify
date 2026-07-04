import { createReadStream, statSync } from "node:fs";
import { join } from "node:path";
import type { HistorySource } from "@bilibili-notify/internal";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import type { RouteDeps } from "./types.js";

/**
 * `GET /api/history`             — recent push events (most-recent-first)
 * `GET /api/history/daily`       — per-day counts over a trailing window
 * `GET /api/history/img/:name`   — static fileserver for entry-attached images
 *
 * Query parameters for the listing endpoint:
 *   - limit:  int        (default 100, capped 500)
 *   - since:  ISO ts     (only entries strictly after this)
 *   - source: history kind ('dynamic' | 'live' | …)
 *   - uid:    bilibili UID
 *
 * Query parameters for the daily endpoint:
 *   - days:     int (default 7, clamped [1,90]) — trailing window incl. today
 *   - tzOffset: int minutes, JS getTimezoneOffset() convention (UTC+8 → -480),
 *               clamped [-840,840] — day boundaries follow the CLIENT's zone
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
	/** 写入时 snapshot 的 UP 主名称 / 头像;老 entry 无此字段。 */
	unameSnapshot?: string;
	uavatarSnapshot?: string;
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
		let limit = 100;
		if (limitRaw !== undefined) {
			const n = Number(limitRaw);
			if (!Number.isFinite(n)) {
				// 此前 Number("abc")=NaN 经 Math.min/max 透传成 limit=NaN 静默喂给
				// query() → 行为未定义。显式 400 而非静默 no-op。
				return c.json({ error: "invalid_query", message: `invalid limit: ${limitRaw}` }, 400);
			}
			limit = Math.max(1, Math.min(500, Math.trunc(n)));
		}
		const since = c.req.query("since");
		if (since !== undefined && Number.isNaN(Date.parse(since))) {
			return c.json(
				{ error: "invalid_query", message: `invalid since (expect ISO timestamp): ${since}` },
				400,
			);
		}
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
			unameSnapshot: e.unameSnapshot,
			uavatarSnapshot: e.uavatarSnapshot,
		}));
		return c.json<HistoryResponse>({ entries: view });
	});

	// 按日聚合 —— 本周推送趋势 / 今日 KPI 的数据源。listing 端点的 limit 上限
	// (500)会把高推送量实例的 7 天窗口截断,趋势图左侧空柱;这里在服务端全量
	// 数完再回,payload 恒定为 days 个桶,与推送量无关。
	app.get("/daily", async (c) => {
		const daysRaw = c.req.query("days");
		let days = 7;
		if (daysRaw !== undefined) {
			const n = Number(daysRaw);
			if (!Number.isFinite(n)) {
				return c.json({ error: "invalid_query", message: `invalid days: ${daysRaw}` }, 400);
			}
			days = Math.max(1, Math.min(90, Math.trunc(n)));
		}
		const tzRaw = c.req.query("tzOffset");
		let tzOffsetMin = 0;
		if (tzRaw !== undefined) {
			const n = Number(tzRaw);
			if (!Number.isFinite(n)) {
				return c.json({ error: "invalid_query", message: `invalid tzOffset: ${tzRaw}` }, 400);
			}
			tzOffsetMin = Math.max(-840, Math.min(840, Math.trunc(n)));
		}
		const dailyCounts = await deps.runtime.historyStore.aggregateDaily({ days, tzOffsetMin });
		return c.json({ days: dailyCounts });
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
