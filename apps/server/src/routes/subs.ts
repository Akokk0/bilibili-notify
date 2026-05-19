import type { CachedProfile, Subscription } from "@bilibili-notify/internal";
import { Hono } from "hono";
import { z } from "zod";
import { ConfigValidationError } from "../config/store.js";
import type { RouteDeps } from "./types.js";

/**
 * DTO shape the dashboard expects: persisted config (Subscription) + the
 * externalized runtime fields joined back in. `cachedProfile` comes from
 * SubRuntimeStore (FansPoller-owned); `state` is a constant — its only live
 * field (fansBaseline) is FansPoller-private and never shipped, and the rest
 * (lastDynamicId/lastPushedAt/liveStatus) has no writer anywhere, so a fixed
 * default satisfies apps/web's non-optional `state` type + the always-"unknown"
 * Rules.tsx read without inventing data.
 */
type SubscriptionDTO = Subscription & {
	cachedProfile?: CachedProfile;
	state: { lastPushedAt: Record<string, never>; liveStatus: "unknown" };
};

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

	/** Join the externalized runtime fields back onto a config Subscription. */
	function toDTO(sub: Subscription): SubscriptionDTO {
		const rt = deps.runtime.subRuntimeStore.get(sub.id);
		return {
			...sub,
			cachedProfile: rt?.cachedProfile,
			state: { lastPushedAt: {}, liveStatus: "unknown" },
		};
	}

	/**
	 * Server-owned cachedProfile seed on create. cachedProfile is a B-station
	 * mirror owned by the server (FansPoller), not client-supplied display data
	 * — so on a brand-new sub we fetch it once ourselves instead of trusting /
	 * peeling whatever the frontend POSTed (Zod strips it anyway). Best-effort:
	 * any failure just leaves it for the first FansPoller tick (~2min). Skipped
	 * when a cachedProfile already exists (re-POST / edit) to bound the call.
	 */
	async function seedCachedProfile(sub: Subscription): Promise<void> {
		if (deps.runtime.subRuntimeStore.get(sub.id)?.cachedProfile) return;
		const engines = deps.runtime.engines;
		if (!engines) return;
		try {
			const res = await engines.api.getUserCardInfo(sub.uid);
			if (res.code !== 0 || !res.data?.card) return;
			const card = res.data.card;
			const cachedProfile: CachedProfile = {
				name: card.name ?? sub.uid,
				avatar: card.face ?? "",
				sign: card.sign ?? "",
				fans: typeof card.fans === "number" && card.fans >= 0 ? card.fans : 0,
				lastRefreshedAt: new Date().toISOString(),
			};
			await deps.runtime.subRuntimeStore.patch(sub.id, { cachedProfile });
		} catch (err) {
			log.warn(`/api/subs seed cachedProfile uid=${sub.uid} failed: ${String(err)}`);
		}
	}

	app.get("/", (c) => c.json(deps.store.getSubscriptions().map(toDTO)));

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
	/**
	 * Name-search counterpart to /lookup. Hits B-station's wbi/search/type
	 * endpoint with `search_type=bili_user`, slices to 5 entries per page so the
	 * dashboard's "添加 UP" dialog can paginate without overwhelming the UI.
	 * The response shape mirrors /lookup's per-row payload so the frontend can
	 * pass either through to onSubmit without translation.
	 */
	app.get("/search", async (c) => {
		const q = c.req.query("q")?.trim();
		const pageParam = Number(c.req.query("page") ?? 1);
		const page =
			Number.isFinite(pageParam) && pageParam >= 1 ? Math.min(Math.floor(pageParam), 200) : 1;
		if (!q) {
			return c.json({ error: "invalid_query", message: "搜索关键词不能为空" }, 400);
		}
		const engines = deps.runtime.engines;
		if (!engines) {
			return c.json({ error: "api_not_ready", message: "B 站 API 尚未就绪" }, 503);
		}
		try {
			// biome-ignore lint/suspicious/noExplicitAny: B-station response shape varies by search_type
			const res = (await engines.api.searchByType("bili_user", q, {
				page,
				pageSize: 5,
			})) as any;
			if (!res || res.code !== 0) {
				const message = res?.message ?? "搜索失败";
				return c.json({ error: "upstream_failed", code: res?.code, message }, 502);
			}
			// biome-ignore lint/suspicious/noExplicitAny: raw search result row
			const raw: any[] = Array.isArray(res.data?.result) ? res.data.result : [];
			const results = raw.slice(0, 5).map((r) => ({
				uid: String(r.mid),
				name: stripHtmlTags(String(r.uname ?? "")),
				avatar: normaliseAvatarUrl(r.upic),
				sign: typeof r.usign === "string" ? r.usign : "",
				fans: typeof r.fans === "number" ? r.fans : 0,
			}));
			return c.json({
				results,
				page,
				pageSize: 5,
				total: typeof res.data?.numResults === "number" ? res.data.numResults : results.length,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log.warn(`/api/subs/search q=${q} failed: ${message}`);
			return c.json({ error: "upstream_failed", message }, 502);
		}
	});

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
			const id = (body as { id?: unknown }).id;
			const created =
				typeof id === "string" ? deps.store.getSubscriptions().find((s) => s.id === id) : undefined;
			if (created) await seedCachedProfile(created);
			return c.json(deps.store.getSubscriptions().map(toDTO), 200);
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
			return c.json(toDTO(next));
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

/** B-station search wraps matched keywords with `<em class="keyword">…</em>`. */
function stripHtmlTags(s: string): string {
	return s.replace(/<[^>]+>/g, "");
}

/** B-station avatar urls come back protocol-relative (`//…`); coerce to https. */
function normaliseAvatarUrl(raw: unknown): string {
	if (typeof raw !== "string" || !raw) return "";
	if (raw.startsWith("//")) return `https:${raw}`;
	return raw;
}
