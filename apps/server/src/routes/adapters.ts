import type { AdapterCapabilities } from "@bilibili-notify/internal";
import { Hono } from "hono";
import { z } from "zod";
import { ConfigValidationError } from "../config/store.js";
import type { RouteDeps } from "./types.js";

/**
 * `/api/adapters` — CRUD on the PushAdapter[] list.
 *
 * An adapter represents a connection instance (an OneBot HTTP endpoint, a
 * webhook URL, the dashboard WS bridge). PushTargets reference adapters via
 * `adapterId`. Deleting an adapter referenced by any target is rejected with
 * 409 so the caller can detach first.
 */
export function createAdaptersRoute(deps: RouteDeps): Hono {
	const app = new Hono();
	const log = deps.runtime.serviceCtx.logger;

	app.get("/", (c) => c.json(deps.store.getAdapters()));

	/**
	 * 各适配器的平台能力快照(今天只有「能不能签小程序卡」),按 adapter id 索引。只列有
	 * 能力概念的平台;官机 / webhook 不在里面,面板据此写「这个平台不支持」。引擎还没起来
	 * 时是空表 —— 面板显示成「未探测」,不算错。
	 */
	app.get("/capabilities", (c) => {
		const engines = deps.runtime.engines;
		const out: Record<string, AdapterCapabilities> = {};
		if (engines) {
			for (const adapter of deps.store.getAdapters()) {
				const caps = engines.adapterCapabilities(adapter.id);
				if (caps) out[adapter.id] = caps;
			}
		}
		return c.json(out);
	});

	app.post("/", async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch (_err) {
			return c.json({ error: "invalid_json", message: "request body must be valid JSON" }, 400);
		}
		try {
			await deps.store.upsertAdapter(body as never);
			return c.json(deps.store.getAdapters(), 200);
		} catch (err) {
			if (err instanceof ConfigValidationError) {
				return c.json({ error: "validation_failed", scope: err.scope, issues: err.issues }, 400);
			}
			log.error("POST /api/adapters failed", err);
			throw err;
		}
	});

	app.patch("/:id", async (c) => {
		const id = c.req.param("id");
		let body: unknown;
		try {
			body = await c.req.json();
		} catch (_err) {
			return c.json({ error: "invalid_json", message: "request body must be valid JSON" }, 400);
		}
		const shapeCheck = z.record(z.string(), z.unknown()).safeParse(body);
		if (!shapeCheck.success) {
			return c.json(
				{
					error: "invalid_payload",
					message: "PATCH body must be a JSON object",
					issues: shapeCheck.error.issues,
				},
				400,
			);
		}
		try {
			const next = await deps.store.patchAdapter(id, shapeCheck.data);
			return c.json(next);
		} catch (err) {
			if (err instanceof ConfigValidationError) {
				const status = isNotFound(err) ? 404 : 400;
				return c.json({ error: "validation_failed", scope: err.scope, issues: err.issues }, status);
			}
			log.error("PATCH /api/adapters/:id failed", err);
			throw err;
		}
	});

	app.post("/:id/test", async (c) => {
		const id = c.req.param("id");
		const adapter = deps.store.getAdapters().find((a) => a.id === id);
		if (!adapter) return c.json({ ok: false, latencyMs: 0, err: "adapter not found" }, 404);
		const engines = deps.runtime.engines;
		if (!engines) {
			return c.json({ ok: false, latencyMs: 0, err: "engines not yet attached" }, 503);
		}
		const result = await engines.probeAdapter(id);
		// Persist the probe outcome to adapter.testStatus so the dashboard's
		// status dot reflects this click without waiting for the 5-min poller.
		// `ok: null` (probe unsupported) deliberately doesn't write back — we
		// want the UI to remain "pending / unsupported" rather than green.
		if (result.ok !== null) {
			try {
				await deps.store.patchAdapter(id, {
					testStatus: {
						ok: result.ok,
						lastCheckedAt: new Date().toISOString(),
						latencyMs: result.latencyMs,
						err: result.err,
					},
				});
			} catch (err) {
				log.warn(`POST /api/adapters/${id}/test patchAdapter failed: ${String(err)}`);
			}
		}
		return c.json(result);
	});

	app.delete("/:id", async (c) => {
		const id = c.req.param("id");
		try {
			const removed = await deps.store.deleteAdapter(id);
			if (!removed) return c.json({ error: "not_found", id }, 404);
			return c.body(null, 204);
		} catch (err) {
			if (err instanceof ConfigValidationError) {
				return c.json({ error: "validation_failed", scope: err.scope, issues: err.issues }, 409);
			}
			log.error("DELETE /api/adapters/:id failed", err);
			throw err;
		}
	});

	return app;
}

function isNotFound(err: ConfigValidationError): boolean {
	const issues = err.issues as { message?: string } | undefined;
	return issues?.message === "adapter not found";
}
