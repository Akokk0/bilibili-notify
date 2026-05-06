import { Hono } from "hono";
import type { AuthSystem } from "./auth/index.js";
import { createAuthRoute } from "./routes/auth.js";
import { createGlobalsRoute } from "./routes/globals.js";
import { createHealthRoute } from "./routes/health.js";
import { createSubsRoute } from "./routes/subs.js";
import { createTargetsRoute } from "./routes/targets.js";
import type { RouteDeps } from "./routes/types.js";
import type { AppRuntime } from "./runtime/bootstrap.js";

export interface CreateAppOptions {
	/** Optional auth subsystem; when present /api/auth/* is mounted. */
	authSystem?: AuthSystem;
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
		runtime.serviceCtx.logger.error("unhandled request error", err);
		return c.json({ error: "internal_error", message: String(err) }, 500);
	});

	app.notFound((c) => c.json({ error: "not_found" }, 404));

	app.route("/api/health", createHealthRoute(deps));
	app.route("/api/globals", createGlobalsRoute(deps));
	app.route("/api/subs", createSubsRoute(deps));
	app.route("/api/targets", createTargetsRoute(deps));
	if (options.authSystem) {
		app.route("/api/auth", createAuthRoute({ ...deps, authSystem: options.authSystem }));
	}

	return app;
}
