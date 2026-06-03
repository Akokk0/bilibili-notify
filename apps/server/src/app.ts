import { readFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createDashboardAuth } from "./auth/dashboard-auth.js";
import { createDesktopTokenAuth } from "./auth/desktop-token.js";
import type { AuthSystem } from "./auth/index.js";
import { createIpRateLimiter } from "./auth/ip-rate-limit.js";
import type { SessionCodec } from "./auth/session.js";
import type { WsTicketStore } from "./auth/ws-ticket.js";
import { createAdaptersRoute } from "./routes/adapters.js";
import { createAuthRoute } from "./routes/auth.js";
import { createCardsRoute } from "./routes/cards.js";
import { createFansRoute } from "./routes/fans.js";
import { createGlobalsRoute } from "./routes/globals.js";
import { createHealthRoute } from "./routes/health.js";
import { createHistoryRoute } from "./routes/history.js";
import { createLiveRoute } from "./routes/live.js";
import { createLogsRoute } from "./routes/logs.js";
import { createPushRoute } from "./routes/push.js";
import { createSessionRoute } from "./routes/session.js";
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
	 * Configured dashboard credentials. When provided, every request under
	 * `/api/*` (including `/api/health`, excluding `/api/session/*`) requires a
	 * valid `bn_session` cookie; the SPA obtains one via `POST
	 * /api/session/login`. When omitted, the dashboard is exposed without auth
	 * and the bootstrap layer logs a warning so the operator notices.
	 *
	 * Cookie-only (Q4): `Authorization: Basic` is NOT accepted — external API
	 * automation is explicitly unsupported when auth is enabled.
	 */
	basicAuthCredentials?: BasicAuthCredentials;
	/**
	 * Session codec used to sign/verify the `bn_session` cookie. Must be
	 * provided exactly when `basicAuthCredentials` is — `index.ts` builds it
	 * from the runtime key provider (HKDF) + the same credentials.
	 */
	sessionCodec?: SessionCodec;
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
	/**
	 * WS ticket store. Mounted on `POST /api/auth/ws-ticket` so the dashboard can
	 * exchange basic-auth for a one-shot ticket before opening the WebSocket.
	 * Pass null when basicAuthCredentials is omitted (no ticket needed).
	 */
	wsTicketStore?: WsTicketStore | null;
	/**
	 * Origin allow-list (same `auth.allowedOrigins` the WS upgrade gate uses).
	 * When non-empty, the unguarded `POST /api/session/{login,logout}` routes
	 * additionally require a whitelisted `Origin` (defence-in-depth vs.
	 * cross-site abuse). Empty/unset → no Origin enforcement.
	 */
	allowedOrigins?: readonly string[];
	/** Desktop launcher local token gate. When set, /api/* requires x-bn-desktop-token. */
	desktopToken?: string;
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
	const deps: RouteDeps = {
		runtime,
		store: runtime.configStore,
		puppeteer: options.puppeteer ?? null,
		wsTicketStore: options.wsTicketStore ?? null,
	};

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

	if (options.desktopToken) {
		app.use("/api/*", createDesktopTokenAuth(options.desktopToken));
	}

	// Session control plane — mounted outside the cookie gate. Login can't require
	// being logged in; `GET /api/session` is the SPA boot probe; logout must
	// work with a stale cookie. The desktop-token gate, when enabled, still
	// wraps these local-launcher routes. The IP token-bucket guards login.
	const loginRateLimiter = createIpRateLimiter({
		onEvent: (event) => {
			if (event.type === "blocked") {
				runtime.serviceCtx.logger.warn(
					`session-login ip=${event.ip} blocked retryAfterMs=${event.retryAfterMs}`,
				);
			} else if (event.type === "failure" && event.failures >= 3) {
				runtime.serviceCtx.logger.warn(`session-login ip=${event.ip} failures=${event.failures}`);
			}
		},
	});
	app.route(
		"/api/session",
		createSessionRoute({
			creds: options.basicAuthCredentials,
			codec: options.sessionCodec,
			rateLimiter: loginRateLimiter,
			allowedOrigins: options.allowedOrigins,
		}),
	);

	// Fail-closed invariant: creds ⟺ codec. Having exactly one set would
	// silently skip the gate below and expose /api/* — refuse to build instead.
	if (!!options.basicAuthCredentials !== !!options.sessionCodec) {
		throw new Error("createApp: basicAuthCredentials and sessionCodec must be provided together");
	}

	// Cookie-session gate over the rest of /api/* (Q4: cookie-only, no Basic,
	// no WWW-Authenticate). Skipped entirely when auth is unconfigured —
	// bootstrap already did the fail-closed / loopback check. The middleware
	// internally exempts /api/session/*.
	if (options.basicAuthCredentials && options.sessionCodec) {
		app.use("/api/*", createDashboardAuth(options.sessionCodec));
	}

	app.route("/api/health", createHealthRoute(deps));
	app.route("/api/globals", createGlobalsRoute(deps));
	app.route("/api/subs", createSubsRoute(deps));
	app.route("/api/adapters", createAdaptersRoute(deps));
	app.route("/api/targets", createTargetsRoute(deps));
	app.route("/api/live", createLiveRoute(deps));
	app.route("/api/history", createHistoryRoute(deps));
	app.route("/api/logs", createLogsRoute(deps));
	app.route("/api/push", createPushRoute(deps));
	app.route("/api/fans", createFansRoute(deps));
	app.route(
		"/api/cards",
		createCardsRoute({
			deps,
			puppeteer: options.puppeteer ?? null,
			api: options.authSystem?.api ?? null,
		}),
	);
	if (options.authSystem) {
		app.route("/api/auth", createAuthRoute({ ...deps, authSystem: options.authSystem }));
	}

	// Static dashboard. Mounted last so /api/* always wins routing. The cookie
	// gate (when configured) applies only to /api/*; the dashboard shell stays
	// reachable so the SPA can boot, probe `GET /api/session`, and render its
	// own login dialog. Dashboard assets are non-secret.
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
