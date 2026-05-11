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
