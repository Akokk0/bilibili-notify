/**
 * devtools API(`/api/dev`)。**只在开发版载荷上挂载**(见 `devtools/index.ts` 那道门)。
 * 判断全在注册表 —— 这里只做 wire,外加把三种失败翻成状态码:没这个场景 404、参数不合法
 * 400、场景自己抛了交给 app 级 `onError` 变 500。
 */

import type { DevRunResponse, DevStatusDTO } from "@bilibili-notify/contract";
import { Hono } from "hono";
import { z } from "zod";
import { DevParamError, type DevRegistry, DevScenarioNotFound } from "../devtools/registry.js";

/** 请求体:`params` 是 key → 字符串或数;没 body 就全按默认值。 */
const RunBody = z.object({
	params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});

export interface CreateDevRouteInput {
	registry: DevRegistry;
}

export function createDevRoute({ registry }: CreateDevRouteInput): Hono {
	const app = new Hono();

	app.get("/", (c) => {
		const body: DevStatusDTO = { scenarios: registry.list(), active: registry.active() };
		return c.json(body);
	});

	app.post("/run/:id", async (c) => {
		const raw = await c.req.json().catch(() => ({}));
		const parsed = RunBody.safeParse(raw);
		if (!parsed.success) return c.json({ err: "params 不成形" }, 400);
		try {
			const body: DevRunResponse = await registry.run(c.req.param("id"), parsed.data.params ?? {});
			return c.json(body);
		} catch (err) {
			if (err instanceof DevScenarioNotFound) return c.json({ err: err.message }, 404);
			if (err instanceof DevParamError) return c.json({ err: err.message }, 400);
			throw err;
		}
	});

	app.post("/reset", (c) => c.json({ active: registry.reset() }));
	app.post("/reset/:id", (c) => {
		try {
			return c.json({ active: registry.reset(c.req.param("id")) });
		} catch (err) {
			if (err instanceof DevScenarioNotFound) return c.json({ err: err.message }, 404);
			throw err;
		}
	});

	return app;
}
