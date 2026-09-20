import { createReadStream, statSync } from "node:fs";
import { join } from "node:path";
import type {
	HistoryDailyResponse,
	HistoryRepushResponse,
	HistoryResponse,
} from "@bilibili-notify/contract";
import { type PushKind, PushKindSchema } from "@bilibili-notify/internal";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { z } from "zod";
import { toHistoryView } from "../history/view.js";
import type { RouteDeps } from "./types.js";

/**
 * `GET  /api/history`             — recent push events (most-recent-first)
 * `GET  /api/history/daily`       — per-day counts over a trailing window
 * `GET  /api/history/img/:name`   — static fileserver for entry-attached images
 * `POST /api/history/:id/repush`  — 人工把一行没送到的推送补一遍(ADR-0017)
 *
 * Query parameters for the listing endpoint:
 *   - limit:  int        (default 100, capped 500)
 *   - since:  ISO ts     (only entries strictly after this)
 *   - kind:   push kind ('dynamic' | 'live' | 'live-end' | …);不认识的当没传
 *   - uid:    bilibili UID
 *
 * Query parameters for the daily endpoint:
 *   - days:     int (default 7, clamped [1,90]) — trailing window incl. today
 *   - tzOffset: int minutes, JS getTimezoneOffset() convention (UTC+8 → -480),
 *               clamped [-840,840] — day boundaries follow the CLIENT's zone
 */

const VALID_KINDS: ReadonlySet<string> = new Set(PushKindSchema.options);

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
		const kindParam = c.req.query("kind");
		const kind = kindParam && VALID_KINDS.has(kindParam) ? (kindParam as PushKind) : undefined;
		const uid = c.req.query("uid");

		const entries = await deps.runtime.historyStore.query({
			limit,
			since,
			kind,
			uid,
		});
		return c.json<HistoryResponse>({ entries: entries.map(toHistoryView) });
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
		return c.json<HistoryDailyResponse>({ days: dailyCounts });
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

	/**
	 * 人工重推(ADR-0017)。判断全在 `RepushRunner` 里,这一层只把结果翻成状态码:
	 *
	 * - **202** 收下了,女仆去补。**不是 200** —— 回来的时候消息一条都还没发出去
	 *   (发送层光退避就可能走满 190s,一行补几条就是几倍),真正的结果随后经 WS 的
	 *   `history-updated` 一条条回来。
	 * - **404** 没这一行。
	 * - **409** 有这一行但现在不能补(全送到了 / 路由里去掉了 / 目标停用 / 正在补 /
	 *   原件没了)。理由**原样**交给面板 —— 自编一句「重推失败」等于让主人对着黑盒猜。
	 */
	app.post("/:id/repush", async (c) => {
		const parsed = RepushSchema.safeParse(await c.req.json().catch(() => null));
		if (!parsed.success) {
			return c.json<HistoryRepushResponse>({ ok: false, err: "请求格式不正确" }, 400);
		}
		const { ts, mode } = parsed.data;
		const res = await deps.runtime.repushRunner.start(c.req.param("id"), ts, mode);
		if (res.ok) return c.json<HistoryRepushResponse>({ ok: true, count: res.count }, 202);
		return c.json<HistoryRepushResponse>({ ok: false, err: res.reason }, res.notFound ? 404 : 409);
	});

	return app;
}

const RepushSchema = z.object({
	/** 这一行的 `ts`,服务端拿它定位日文件。 */
	ts: z.string().refine((v) => !Number.isNaN(Date.parse(v)), "ts 必须是 ISO 时间戳"),
	mode: z.enum(["all", "missing"]),
});

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
