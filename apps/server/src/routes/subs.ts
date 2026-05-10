import { Hono } from "hono";
import { z } from "zod";
import { ConfigValidationError } from "../config/store.js";
import type { RouteDeps } from "./types.js";

/**
 * `/api/subs` — CRUD on the Subscription[] list.
 *
 * Body shapes:
 * - POST /api/subs  → full Subscription (validated by SubscriptionSchema in store)
 * - PATCH /api/subs/:id → DeepPartial<Subscription>; merged onto current then validated
 *
 * We deliberately require the full Subscription on POST rather than letting the
 * server fill in defaults — `makeEmptySubscription({id, uid})` exists in
 * `@bilibili-notify/internal` and clients (the dashboard) call that locally.
 * Keeps the server stateless about defaults.
 */
export function createSubsRoute(deps: RouteDeps): Hono {
	const app = new Hono();
	const log = deps.runtime.serviceCtx.logger;

	app.get("/", (c) => c.json(deps.store.getSubscriptions()));

	/**
	 * Pre-flight UID resolution for the "add UP" dialog. Hits B-station's user
	 * card endpoint via BilibiliAPI; on success returns the four fields the
	 * client wants to show in confirmation (and writes back into
	 * Subscription.cachedProfile when the user clicks add).
	 *
	 * Errors are mapped to client-friendly statuses so the dialog can render
	 * a helpful message instead of a generic 500: 404 means B-station said
	 * the UID doesn't exist; 503 means we couldn't reach B-station / the
	 * API client wasn't ready yet.
	 */
	app.get("/lookup", async (c) => {
		const uid = c.req.query("uid")?.trim();
		if (!uid || !/^\d+$/.test(uid)) {
			return c.json({ error: "invalid_uid", message: "uid 必须是纯数字 UID" }, 400);
		}
		const engines = deps.runtime.engines;
		if (!engines) {
			return c.json({ error: "api_not_ready", message: "B 站 API 尚未就绪" }, 503);
		}
		try {
			const res = await engines.api.getUserCardInfo(uid);
			if (res.code !== 0 || !res.data?.card) {
				const message = (res as { message?: string }).message ?? "未找到该 UP 主";
				return c.json({ error: "not_found", code: res.code, message }, 404);
			}
			const card = res.data.card;
			return c.json({
				uid: card.mid,
				name: card.name,
				avatar: card.face,
				sign: card.sign,
				fans: card.fans,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log.warn(`/api/subs/lookup uid=${uid} failed: ${message}`);
			return c.json({ error: "upstream_failed", message }, 502);
		}
	});

	app.post("/", async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch (_err) {
			return c.json({ error: "invalid_json", message: "request body must be valid JSON" }, 400);
		}
		try {
			// upsertSubscription validates via Zod internally
			await deps.store.upsertSubscription(body as never);
			return c.json(deps.store.getSubscriptions(), 200);
		} catch (err) {
			if (err instanceof ConfigValidationError) {
				return c.json({ error: "validation_failed", scope: err.scope, issues: err.issues }, 400);
			}
			log.error("POST /api/subs failed", err);
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
			const next = await deps.store.patchSubscription(id, shapeCheck.data);
			return c.json(next);
		} catch (err) {
			if (err instanceof ConfigValidationError) {
				const status = isNotFound(err) ? 404 : 400;
				return c.json({ error: "validation_failed", scope: err.scope, issues: err.issues }, status);
			}
			log.error("PATCH /api/subs/:id failed", err);
			throw err;
		}
	});

	app.delete("/:id", async (c) => {
		const id = c.req.param("id");
		const removed = await deps.store.deleteSubscription(id);
		if (!removed) return c.json({ error: "not_found", id }, 404);
		return c.body(null, 204);
	});

	return app;
}

function isNotFound(err: ConfigValidationError): boolean {
	const issues = err.issues as { message?: string } | undefined;
	return issues?.message === "subscription not found" || issues?.message === "target not found";
}
