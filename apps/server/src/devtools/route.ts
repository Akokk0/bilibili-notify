/**
 * devtools API(`/api/dev`)。**只在开发版载荷上挂载**(见 `devtools/index.ts` 那道门)。
 * 判断全在注册表 —— 这里只做 wire,把结果失败交给 `respondFailure`,状态码从码推:
 * 没这个场景 `not_found`(404)、参数不合法 `invalid`(400)、场景自己真抛了交给 app 级
 * `onError` 变 `unavailable`(503)。
 */

import type {
	DevActiveView,
	DevCapturesView,
	DevPurgeHistoryResponse,
	DevRunResponse,
	DevStatusView,
} from "@bilibili-notify/contract";
import { fail } from "@bilibili-notify/internal";
import { Hono } from "hono";
import { z } from "zod";
import { respondFailure } from "../routes/respond-failure.js";
import type { DevRegistry } from "./registry.js";

/** 请求体:`params` 是 key → 字符串或数;没 body 就全按默认值。 */
const RunBody = z.object({
	params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});

/** 截流那一组的口:列表 / 清空 / 清掉截流期间的历史行。 */
export interface DevCapturesApi {
	status(): DevCapturesView;
	clear(): void;
	purgeHistory(): Promise<number>;
}

export interface CreateDevRouteInput {
	registry: DevRegistry;
	/** 不给就不挂 `/captures`,404。 */
	captures?: DevCapturesApi;
}

export function createDevRoute({ registry, captures }: CreateDevRouteInput): Hono {
	const app = new Hono();

	app.get("/", (c) => {
		const body: DevStatusView = { scenarios: registry.list(), active: registry.active() };
		return c.json(body);
	});

	// 轮询打这里:生效表会在面板没按任何键的时候变(截流拦下的条数随真推送涨),而场景表不会。
	app.get("/active", (c) => {
		const body: DevActiveView = { active: registry.active() };
		return c.json(body);
	});

	app.post("/run/:id", async (c) => {
		const raw = await c.req.json().catch(() => ({}));
		const parsed = RunBody.safeParse(raw);
		if (!parsed.success) {
			return respondFailure(c, fail("invalid", "params 要是「参数名 → 字符串或数字」的对象"));
		}
		const result = await registry.run(c.req.param("id"), parsed.data.params ?? {});
		if (!result.ok) return respondFailure(c, result);
		const body: DevRunResponse = { active: result.active };
		if (result.summary !== undefined) body.summary = result.summary;
		return c.json(body);
	});

	if (captures) {
		app.get("/captures", (c) => c.json(captures.status()));
		app.post("/captures/clear", (c) => {
			captures.clear();
			return c.json(captures.status());
		});
		app.delete("/captures/history", async (c) => {
			const body: DevPurgeHistoryResponse = { deleted: await captures.purgeHistory() };
			return c.json(body);
		});
	}

	app.post("/reset", async (c) => {
		const result = await registry.reset();
		if (!result.ok) return respondFailure(c, result);
		return c.json({ active: result.active });
	});
	app.post("/reset/:id", async (c) => {
		const result = await registry.reset(c.req.param("id"));
		if (!result.ok) return respondFailure(c, result);
		return c.json({ active: result.active });
	});

	return app;
}
