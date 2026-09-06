/**
 * devtools API(`/api/dev`)。**只在开发版载荷上挂载**(见 `devtools/index.ts` 那道门)。
 * 判断全在注册表 —— 这里只做 wire,外加把三种失败翻成状态码:没这个场景 404、参数不合法
 * 400、场景自己抛了交给 app 级 `onError` 变 500。
 */

import type {
	DevActiveDTO,
	DevCapturesDTO,
	DevPurgeHistoryResponse,
	DevRunResponse,
	DevStatusDTO,
} from "@bilibili-notify/contract";
import { Hono } from "hono";
import { z } from "zod";
import { DevParamError, type DevRegistry, DevScenarioNotFound } from "./registry.js";

/** 请求体:`params` 是 key → 字符串或数;没 body 就全按默认值。 */
const RunBody = z.object({
	params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});

/** 截流那一组的口:列表 / 清空 / 清掉截流期间的历史行。 */
export interface DevCapturesApi {
	status(): DevCapturesDTO;
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
		const body: DevStatusDTO = { scenarios: registry.list(), active: registry.active() };
		return c.json(body);
	});

	// 轮询打这里:生效表会在面板没按任何键的时候变(截流拦下的条数随真推送涨),而场景表不会。
	app.get("/active", (c) => {
		const body: DevActiveDTO = { active: registry.active() };
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

	if (captures) {
		app.get("/captures", (c) => c.json(captures.status()));
		app.post("/captures/clear", (c) => {
			captures.clear();
			return c.json(captures.status());
		});
		app.post("/captures/purge-history", async (c) => {
			const body: DevPurgeHistoryResponse = { deleted: await captures.purgeHistory() };
			return c.json(body);
		});
	}

	app.post("/reset", async (c) => c.json({ active: await registry.reset() }));
	app.post("/reset/:id", async (c) => {
		try {
			return c.json({ active: await registry.reset(c.req.param("id")) });
		} catch (err) {
			if (err instanceof DevScenarioNotFound) return c.json({ err: err.message }, 404);
			throw err;
		}
	});

	return app;
}
