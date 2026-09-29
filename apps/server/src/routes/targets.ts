import { fail } from "@bilibili-notify/internal";
import { Hono } from "hono";
import { ConfigValidationError } from "../config/store.js";
import { readJsonBody, readJsonObject } from "./request-body.js";
import { respondFailure } from "./respond-failure.js";
import type { RouteDeps } from "./types.js";

/**
 * `/api/targets` — CRUD on the PushTarget[] list.
 *
 * Stage 2.2 does NOT mount `/api/targets/test` — test ping requires a working
 * platform adapter (OneBot client) which lands in 2.4+.
 *
 * 失败一律经 `respondFailure`(ADR-0026):store 拒收时抛的 `ConfigValidationError` 自带标准码
 * (不合规 `invalid` 400、没这一条 `not_found` 404、托管的不许动 `conflict` 409),路由按码回、不嗅文案。
 */
export function createTargetsRoute(deps: RouteDeps): Hono {
	const app = new Hono();
	const log = deps.runtime.serviceCtx.logger;

	app.get("/", (c) => c.json(deps.store.getTargets()));

	app.post("/", async (c) => {
		const read = await readJsonBody(c);
		if (!read.ok) return respondFailure(c, read);
		try {
			await deps.store.upsertTarget(read.body as never);
			return c.json(deps.store.getTargets(), 200);
		} catch (err) {
			if (err instanceof ConfigValidationError) return respondFailure(c, err.toFailure());
			log.error("POST /api/targets failed", err);
			throw err;
		}
	});

	app.patch("/:id", async (c) => {
		const id = c.req.param("id");
		const read = await readJsonObject(c);
		if (!read.ok) return respondFailure(c, read);
		try {
			const next = await deps.store.patchTarget(id, read.body);
			return c.json(next);
		} catch (err) {
			if (err instanceof ConfigValidationError) return respondFailure(c, err.toFailure());
			log.error("PATCH /api/targets/:id failed", err);
			throw err;
		}
	});

	app.delete("/:id", async (c) => {
		const id = c.req.param("id");
		try {
			const removed = await deps.store.deleteTarget(id);
			if (!removed) return respondFailure(c, fail("not_found", "没有这个推送目标"));
			return c.body(null, 204);
		} catch (err) {
			if (err instanceof ConfigValidationError) return respondFailure(c, err.toFailure());
			log.error("DELETE /api/targets/:id failed", err);
			throw err;
		}
	});

	return app;
}
