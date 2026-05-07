import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { HTTPException } from "hono/http-exception";
import type { AuthSystem } from "./auth/index.js";
import { createAuthRoute } from "./routes/auth.js";
import { createGlobalsRoute } from "./routes/globals.js";
import { createHealthRoute } from "./routes/health.js";
import { createHistoryRoute } from "./routes/history.js";
import { createLiveRoute } from "./routes/live.js";
import { createSubsRoute } from "./routes/subs.js";
import { createTargetsRoute } from "./routes/targets.js";
import type { RouteDeps } from "./routes/types.js";
import type { AppRuntime } from "./runtime/bootstrap.js";

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

	app.notFound((c) => c.json({ error: "not_found" }, 404));

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
	if (options.authSystem) {
		app.route("/api/auth", createAuthRoute({ ...deps, authSystem: options.authSystem }));
	}

	return app;
}
