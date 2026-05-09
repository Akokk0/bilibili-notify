import { readFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { HTTPException } from "hono/http-exception";
import type { AuthSystem } from "./auth/index.js";
import { createAuthRoute } from "./routes/auth.js";
import { createCardsRoute } from "./routes/cards.js";
import { createGlobalsRoute } from "./routes/globals.js";
import { createHealthRoute } from "./routes/health.js";
import { createHistoryRoute } from "./routes/history.js";
import { createLiveRoute } from "./routes/live.js";
import { createPushRoute } from "./routes/push.js";
import { createSubsRoute } from "./routes/subs.js";
import { createTargetsRoute } from "./routes/targets.js";
import type { RouteDeps } from "./routes/types.js";
import type { AppRuntime } from "./runtime/bootstrap.js";
import type { StandalonePuppeteer } from "./runtime/puppeteer.js";

export interface BasicAuthCredentials {
	username: string;
	password: string;
}

export interface CreateAppOptions {
	/** Optional auth subsystem; when present /api/auth/* is mounted. */
	authSystem?: AuthSystem;
	/**
	 * Optional HTTP basic-auth credentials for the dashboard. When provided, every
	 * request under `/api/*` (including `/api/health`) requires the matching
	 * Authorization header. When omitted, the dashboard is exposed without auth
	 * and the bootstrap layer logs a warning so the operator notices. Mirrors
	 * plan §4.2 Fix 4a.
	 */
	basicAuthCredentials?: BasicAuthCredentials;
	/**
	 * Optional puppeteer-core adapter for /api/cards/preview. When null (no
	 * BN_CHROME_PATH configured) the cards route still mounts but reports 503
	 * with an actionable hint.
	 */
	puppeteer?: StandalonePuppeteer | null;
	/**
	 * Optional directory containing the built React dashboard (`web/dist`). When
	 * set, non-`/api/*` paths fall through to a static file server backed by
	 * this directory, with `index.html` as the SPA fallback for unknown routes.
	 * When omitted, the server is API-only (matches dev mode where vite serves
	 * the dashboard separately).
	 */
	staticDir?: string;
}

/**
 * Build the top-level Hono app. Stage 2.4 mounts:
 *   /api/health           — liveness (short)
 *   /api/health/details   — rich snapshot incl. config-scope meta
 *   /api/globals          — GET / PATCH
 *   /api/subs             — GET / POST / PATCH /:id / DELETE /:id
 *   /api/targets          — GET / POST / PATCH /:id / DELETE /:id
 *   /api/auth/*           — status / qr / cookies refresh|reset / logout (when authSystem present)
 *
 * Sink wiring follows in 2.5+.
 */
export function createApp(runtime: AppRuntime, options: CreateAppOptions = {}): Hono {
	const app = new Hono();
	const deps: RouteDeps = { runtime, store: runtime.configStore };

	app.onError((err, c) => {
		// Let hono's HTTPException-derived responses (e.g. basicAuth's 401) flow
		// through unchanged — wrapping them in 500 would mask auth challenges.
		if (err instanceof HTTPException) {
			return err.getResponse();
		}
		runtime.serviceCtx.logger.error("unhandled request error", err);
		return c.json({ error: "internal_error", message: String(err) }, 500);
	});

	// SPA fallback — when staticDir is configured, any non-`/api/*` GET that
	// reaches notFound is treated as a client-side route and served the
	// dashboard's index.html. The static middleware below picks up real assets
	// (js/css/png/etc.) before this runs. API routes always return JSON 404 so
	// that fetch errors stay machine-readable.
	const indexHtml = options.staticDir ? loadIndexHtml(options.staticDir) : null;
	app.notFound((c) => {
		if (indexHtml && c.req.method === "GET" && !c.req.path.startsWith("/api/")) {
			return c.html(indexHtml);
		}
		return c.json({ error: "not_found" }, 404);
	});

	// Basic-auth gate. Mounted BEFORE the route table so every /api/* request
	// (health probes included — this is a backend service, not anonymous-probe
	// territory) is challenged when credentials are configured. When omitted we
	// skip the middleware entirely; the warn log lives at the bootstrap layer.
	if (options.basicAuthCredentials) {
		const { username, password } = options.basicAuthCredentials;
		app.use("/api/*", basicAuth({ username, password }));
	}

	app.route("/api/health", createHealthRoute(deps));
	app.route("/api/globals", createGlobalsRoute(deps));
	app.route("/api/subs", createSubsRoute(deps));
	app.route("/api/targets", createTargetsRoute(deps));
	app.route("/api/live", createLiveRoute(deps));
	app.route("/api/history", createHistoryRoute(deps));
	app.route("/api/push", createPushRoute(deps));
	app.route("/api/cards", createCardsRoute({ deps, puppeteer: options.puppeteer ?? null }));
	if (options.authSystem) {
		app.route("/api/auth", createAuthRoute({ ...deps, authSystem: options.authSystem }));
	}

	// Static dashboard. Mounted last so /api/* always wins routing. Basic-auth
	// (when configured) applies only to /api/*; the dashboard shell is meant to
	// be reachable so the operator's browser can prompt for credentials when it
	// fetches /api/health on first load. Dashboard assets are non-secret.
	if (options.staticDir) {
		app.use("/*", serveStatic({ root: options.staticDir }));
	}

	return app;
}

function loadIndexHtml(staticDir: string): string | null {
	try {
		return readFileSync(joinPath(staticDir, "index.html"), "utf8");
	} catch {
		return null;
	}
}
