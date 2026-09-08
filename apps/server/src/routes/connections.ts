import type { ConnectionCapabilities } from "@bilibili-notify/internal";
import { Hono } from "hono";
import { z } from "zod";
import { ConfigValidationError } from "../config/store.js";
import type { RouteDeps } from "./types.js";

/**
 * `/api/connections` — CRUD on the Connection[] list.
 *
 * An adapter represents a connection instance (an OneBot HTTP endpoint, a
 * webhook URL, the dashboard WS bridge). PushTargets reference adapters via
 * `connectionId`. Deleting an adapter referenced by any target is rejected with
 * 409 so the caller can detach first.
 */
export function createConnectionsRoute(deps: RouteDeps): Hono {
	const app = new Hono();
	const log = deps.runtime.serviceCtx.logger;

	app.get("/", (c) => c.json(deps.store.getConnections()));

	/**
	 * 平台能力快照(今天只有「能不能签小程序卡」),连接 id → 平台名 → 能力。只列有能力
	 * 概念的平台;官机 / webhook 不在里面,面板据此写「这个平台不支持」。引擎还没起来时是
	 * 空表 —— 面板显示成「未探测」,不算错。
	 *
	 * **第二级这一层是在这儿套上的**:引擎按连接寻址,而直连一条连接就是一个平台,平台名
	 * 从连接自己身上读。接桥之后一条连接驮多个平台,那时这一层要由引擎自己给出,这里改成
	 * 原样透传。
	 */
	app.get("/capabilities", (c) => {
		const engines = deps.runtime.engines;
		const out: Record<string, Record<string, ConnectionCapabilities>> = {};
		if (engines) {
			for (const connection of deps.store.getConnections()) {
				const caps = engines.connectionCapabilities(connection.id);
				if (caps) out[connection.id] = { [connection.platform]: caps };
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
			await deps.store.upsertConnection(body as never);
			return c.json(deps.store.getConnections(), 200);
		} catch (err) {
			if (err instanceof ConfigValidationError) {
				return c.json({ error: "validation_failed", scope: err.scope, issues: err.issues }, 400);
			}
			log.error("POST /api/connections failed", err);
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
			const next = await deps.store.patchConnection(id, shapeCheck.data);
			return c.json(next);
		} catch (err) {
			if (err instanceof ConfigValidationError) {
				const status = isNotFound(err) ? 404 : 400;
				return c.json({ error: "validation_failed", scope: err.scope, issues: err.issues }, status);
			}
			log.error("PATCH /api/connections/:id failed", err);
			throw err;
		}
	});

	app.post("/:id/test", async (c) => {
		const id = c.req.param("id");
		const connection = deps.store.getConnections().find((a) => a.id === id);
		if (!connection) return c.json({ ok: false, latencyMs: 0, err: "adapter not found" }, 404);
		const engines = deps.runtime.engines;
		if (!engines) {
			return c.json({ ok: false, latencyMs: 0, err: "engines not yet attached" }, 503);
		}
		const result = await engines.probeConnection(id);
		// Persist the probe outcome to adapter.testStatus so the dashboard's
		// status dot reflects this click without waiting for the 5-min poller.
		// `ok: null` (probe unsupported) deliberately doesn't write back — we
		// want the UI to remain "pending / unsupported" rather than green.
		if (result.ok !== null) {
			try {
				await deps.store.patchConnection(id, {
					testStatus: {
						ok: result.ok,
						lastCheckedAt: new Date().toISOString(),
						latencyMs: result.latencyMs,
						err: result.err,
					},
				});
			} catch (err) {
				log.warn(`POST /api/connections/${id}/test patchConnection failed: ${String(err)}`);
			}
		}
		return c.json(result);
	});

	app.delete("/:id", async (c) => {
		const id = c.req.param("id");
		try {
			const removed = await deps.store.deleteConnection(id);
			if (!removed) return c.json({ error: "not_found", id }, 404);
			return c.body(null, 204);
		} catch (err) {
			if (err instanceof ConfigValidationError) {
				return c.json({ error: "validation_failed", scope: err.scope, issues: err.issues }, 409);
			}
			log.error("DELETE /api/connections/:id failed", err);
			throw err;
		}
	});

	return app;
}

function isNotFound(err: ConfigValidationError): boolean {
	const issues = err.issues as { message?: string } | undefined;
	return issues?.message === "adapter not found";
}
