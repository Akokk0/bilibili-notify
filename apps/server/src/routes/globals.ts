import { Hono } from "hono";
import { z } from "zod";
import { ConfigValidationError } from "../config/store.js";
import type { RouteDeps } from "./types.js";

/**
 * `/api/globals` — read + patch the runtime GlobalConfig.
 *
 * - GET: returns a snapshot
 * - PATCH: accepts a deep-partial JSON body, merges, validates, persists
 *
 * No PUT (full set) — keep the API surface deliberately small until a UI demands it.
 */
export function createGlobalsRoute(deps: RouteDeps): Hono {
	const app = new Hono();
	const log = deps.runtime.serviceCtx.logger;

	app.get("/", (c) => c.json(deps.store.getGlobals()));

	app.patch("/", async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch (_err) {
			return c.json({ error: "invalid_json", message: "request body must be valid JSON" }, 400);
		}
		// We accept any shape here; the merged result is re-validated by Zod inside the store.
		// Cheap upfront guard: must be an object (not array / scalar).
		const shapeCheck = z.record(z.string(), z.unknown()).safeParse(body);
		if (!shapeCheck.success) {
			return c.json(
				{
					error: "invalid_payload",
					message: "PATCH /api/globals body must be a JSON object",
					issues: shapeCheck.error.issues,
				},
				400,
			);
		}
		try {
			const next = await deps.store.patchGlobals(shapeCheck.data);
			return c.json(next);
		} catch (err) {
			if (err instanceof ConfigValidationError) {
				return c.json({ error: "validation_failed", scope: err.scope, issues: err.issues }, 400);
			}
			log.error("PATCH /api/globals failed", err);
			throw err;
		}
	});

	return app;
}
