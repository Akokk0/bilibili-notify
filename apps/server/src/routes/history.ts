import type {
	HistoryDailyResponse,
	HistoryRepushResponse,
	HistoryResponse,
} from "@bilibili-notify/contract";
import { type FeatureKey, FeatureKeySchema, fail, ok } from "@bilibili-notify/internal";
import { Hono } from "hono";
import { z } from "zod";
import { originalCount, unsentIndices } from "../history/repush.js";
import { readClearedThrough } from "../history/retention.js";
import { toHistoryView } from "../history/view.js";
import { respondFailure } from "./respond-failure.js";
import type { RouteDeps } from "./types.js";

/**
 * `GET  /api/history`             — recent push events (most-recent-first)
 * `GET  /api/history/daily`       — per-day counts over a trailing window
 * `POST /api/history/:id/repush`  — 人工把一行没送到的推送补一遍(ADR-0017)
 *
 * 历史行里的图在图库,面板读 `GET /api/images/<引用>`(`routes/images.ts`);从前的 `/api/history/img/:name` 已退役。
 *
 * Query parameters for the listing endpoint:
 *   - limit:  int        (default 100, capped 500)
 *   - since:  ISO ts     (only entries strictly after this)
 *   - feature: 特性键('post' | 'liveStart' | 'liveEnd' | …);不是特性键回 400。老参数 `kind` 已经不认,也回 400
 *
 * Query parameters for the daily endpoint:
 *   - days:     int (default 7, clamped [1,90]) — trailing window incl. today
 *   - tzOffset: int minutes, JS getTimezoneOffset() convention (UTC+8 → -480),
 *               clamped [-840,840] — day boundaries follow the CLIENT's zone
 */

const VALID_FEATURES: ReadonlySet<string> = new Set(FeatureKeySchema.options);

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
				return respondFailure(c, fail("invalid", `limit 要是数字：${limitRaw}`));
			}
			limit = Math.max(1, Math.min(500, Math.trunc(n)));
		}
		const since = c.req.query("since");
		if (since !== undefined && Number.isNaN(Date.parse(since))) {
			return respondFailure(c, fail("invalid", `since 要是 ISO 时间戳：${since}`));
		}
		// 老参数名(⑬f 之前的 `kind`,值是 0.x 的推送种类名)不再认。静默当成「没筛」会让书签里的旧链接
		// 悄悄返回全部行 —— 这里回错误,把新名字告诉对方。
		const staleKind = c.req.query("kind");
		if (staleKind !== undefined) {
			return respondFailure(
				c,
				fail(
					"invalid",
					`kind 已经改叫 feature,值是特性键(post / liveStart / liveEnd …)：kind=${staleKind}`,
				),
			);
		}
		// 不是特性键的值同样回错误(和 limit / since 一个做法):当成没传会悄悄回全部行,对方以为筛过了。
		const featureParam = c.req.query("feature");
		if (featureParam !== undefined && !VALID_FEATURES.has(featureParam)) {
			return respondFailure(
				c,
				fail(
					"invalid",
					`feature 要是特性键(post / liveStart / liveEnd …)：feature=${featureParam}`,
				),
			);
		}
		const feature = featureParam as FeatureKey | undefined;

		const entries = await deps.runtime.historyStore.query({
			limit,
			since,
			feature,
		});
		// 只为**失败 / 部分失败**的行问一句「按钮该不该灰」(决策 9)。一页两百行里
		// 失败的通常是个位数,而每问一次是一次 stat;别的行本来就没有按钮,不问也不带。
		// 图与重推原件清到哪一天:行的日子在它及以前,面板在原来画图的位置写「图已清理」。
		const clearedThrough = await readClearedThrough(deps.runtime.dataRoot);
		const views = await Promise.all(
			entries.map(async (e) => {
				if (e.status !== "failed" && e.status !== "partial") {
					return toHistoryView(e, { clearedThrough });
				}
				const denial = await deps.runtime.repushRunner.canRepush(e);
				// 条数在这儿算完交出去 —— 面板自己再算一遍就是第二份实现,而身份号那套
				// 判定(`repushOf ?? 下标`,每号取最后一次)一改两边就漂。
				return toHistoryView(e, {
					clearedThrough,
					repush: denial
						? { can: false, code: denial.code, message: denial.message }
						: {
								can: true,
								total: originalCount(e.messages),
								missing: unsentIndices(e.messages).length,
							},
				});
			}),
		);
		return c.json<HistoryResponse>({ entries: views });
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
				return respondFailure(c, fail("invalid", `days 要是数字：${daysRaw}`));
			}
			days = Math.max(1, Math.min(90, Math.trunc(n)));
		}
		const tzRaw = c.req.query("tzOffset");
		let tzOffsetMin = 0;
		if (tzRaw !== undefined) {
			const n = Number(tzRaw);
			if (!Number.isFinite(n)) {
				return respondFailure(c, fail("invalid", `tzOffset 要是数字（分钟）：${tzRaw}`));
			}
			tzOffsetMin = Math.max(-840, Math.min(840, Math.trunc(n)));
		}
		const dailyCounts = await deps.runtime.historyStore.aggregateDaily({ days, tzOffsetMin });
		return c.json<HistoryDailyResponse>({ days: dailyCounts });
	});

	/**
	 * 人工重推(ADR-0017)。判断全在 `RepushRunner` 里,这一层只把结果翻成状态码:
	 *
	 * - **202** 收下了,女仆去补。**不是 200** —— 回来的时候消息一条都还没发出去
	 *   (发送层光退避就可能走满 190s,一行补几条就是几倍),真正的结果随后经 WS 的
	 *   `history-updated` 一条条回来。
	 * - **404** 没这一行(`not_found`)。
	 * - **409** 有这一行但现在不能补(`conflict`:全送到了 / 路由里去掉了 / 目标停用 / 正在补 /
	 *   原件没了)。理由**原样**放进 `message` 交给面板 —— 自编一句「重推失败」等于让主人对着黑盒猜。
	 */
	app.post("/:id/repush", async (c) => {
		const parsed = RepushSchema.safeParse(await c.req.json().catch(() => null));
		if (!parsed.success) {
			return respondFailure(
				c,
				fail("invalid", "重推请求要带 createdAt（这一行的 ISO 时间戳）和 mode（all 或 missing）"),
			);
		}
		const { createdAt, mode } = parsed.data;
		const res = await deps.runtime.repushRunner.start(c.req.param("id"), createdAt, mode);
		if (res.ok) return c.json<HistoryRepushResponse>(ok({ count: res.count }), 202);
		return respondFailure(c, res);
	});

	return app;
}

const RepushSchema = z.object({
	/** 这一行的 `createdAt`,服务端拿它定位日文件。 */
	createdAt: z.string().refine((v) => !Number.isNaN(Date.parse(v)), "createdAt 必须是 ISO 时间戳"),
	mode: z.enum(["all", "missing"]),
});
