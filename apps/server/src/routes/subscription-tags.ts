import type { SubscriptionTag } from "@bilibili-notify/internal";
import { Hono } from "hono";
import { ConfigValidationError } from "../config/store.js";
import { readJsonBody } from "./request-body.js";
import { respondFailure } from "./respond-failure.js";
import type { RouteDeps } from "./types.js";

/**
 * 订阅标签表 `/api/subscriptions/tags`(ADR-0034,挂在 `routes/subscriptions.ts` 底下):`GET` 读整张,`PUT` 整张换 —— 新建、改名、
 * 排序、删除都走它(新标签的 id 由面板生成,和新建订阅一样)。名字的规矩与「删标签时订阅上的 id 一起去掉」都在
 * 配置仓的 `replaceSubscriptionTags`。
 */
export function createSubscriptionTagsRoute(deps: RouteDeps): Hono {
	const app = new Hono();

	app.get("/", (c) => c.json(deps.store.getSubscriptionTags()));

	app.put("/", async (c) => {
		const read = await readJsonBody(c);
		if (!read.ok) return respondFailure(c, read);
		try {
			// 形状(是不是数组、每格对不对)由配置仓按 schema 核,不对回 invalid。
			return c.json(await deps.store.replaceSubscriptionTags(read.body as SubscriptionTag[]));
		} catch (err) {
			if (err instanceof ConfigValidationError) return respondFailure(c, err.toFailure());
			throw err;
		}
	});

	return app;
}
