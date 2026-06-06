import { Hono } from "hono";
import { z } from "zod";
import { ConfigValidationError } from "../config/store.js";
import type { RouteDeps } from "./types.js";

/**
 * `/api/targets` — CRUD on the PushTarget[] list.
 *
 * Stage 2.2 does NOT mount `/api/targets/test` — test ping requires a working
 * platform adapter (OneBot client) which lands in 2.4+.
 */
export function createTargetsRoute(deps: RouteDeps): Hono {
	const app = new Hono();
	const log = deps.runtime.serviceCtx.logger;

	app.get("/", (c) => c.json(deps.store.getTargets()));

	app.post("/", async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch (_err) {
			return c.json({ error: "invalid_json", message: "request body must be valid JSON" }, 400);
		}
		try {
			await deps.store.upsertTarget(body as never);
			return c.json(deps.store.getTargets(), 200);
		} catch (err) {
			if (err instanceof ConfigValidationError) {
				return c.json({ error: "validation_failed", scope: err.scope, issues: err.issues }, 400);
			}
			log.error("POST /api/targets failed", err);
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
			const next = await deps.store.patchTarget(id, shapeCheck.data);
			return c.json(next);
		} catch (err) {
			if (err instanceof ConfigValidationError) {
				const status = isNotFound(err) ? 404 : 400;
				return c.json({ error: "validation_failed", scope: err.scope, issues: err.issues }, status);
			}
			log.error("PATCH /api/targets/:id failed", err);
			throw err;
		}
	});

	app.delete("/:id", async (c) => {
		const id = c.req.param("id");
		try {
			const removed = await deps.store.deleteTarget(id);
			if (!removed) return c.json({ error: "not_found", id }, 404);
			return c.body(null, 204);
		} catch (err) {
			if (err instanceof ConfigValidationError) {
				const status = isNotFound(err) ? 404 : isManagedTarget(err) ? 409 : 400;
				return c.json({ error: "validation_failed", scope: err.scope, issues: err.issues }, status);
			}
			log.error("DELETE /api/targets/:id failed", err);
			throw err;
		}
	});

	return app;
}

function isNotFound(err: ConfigValidationError): boolean {
	const issues = err.issues as { message?: string } | undefined;
	return issues?.message === "target not found";
}

function isManagedTarget(err: ConfigValidationError): boolean {
	const issues = err.issues as { message?: string } | undefined;
	return issues?.message === "managed target cannot be deleted directly";
}
