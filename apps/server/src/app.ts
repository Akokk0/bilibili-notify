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
import type { BackupService } from "./backup/service.js";
import type { ChromeSource } from "./config/persist.js";
import type { QQSessionRegistry } from "./platforms/qq-official.js";
import { createAdaptersRoute } from "./routes/adapters.js";
import { createAiRoute } from "./routes/ai.js";
import { createAuthRoute } from "./routes/auth.js";
import { createBackupRoute } from "./routes/backup.js";
import { createCardsRoute } from "./routes/cards.js";
import { createCommandsRoute } from "./routes/commands.js";
import { createFansRoute } from "./routes/fans.js";
import { createGlobalsRoute } from "./routes/globals.js";
import { createHealthRoute } from "./routes/health.js";
import { createHistoryRoute } from "./routes/history.js";
import { createLiveRoute } from "./routes/live.js";
import { createLogsRoute } from "./routes/logs.js";
import { createPushRoute } from "./routes/push.js";
import { createQQRoute } from "./routes/qq.js";
import { createSessionRoute } from "./routes/session.js";
import { createSkinsRoute } from "./routes/skins.js";
import { createStatsRoute } from "./routes/stats.js";
import { createSubsRoute } from "./routes/subs.js";
import { createTargetsRoute } from "./routes/targets.js";
import type { RouteDeps } from "./routes/types.js";
import type { AppRuntime } from "./runtime/bootstrap.js";
import type { StandalonePuppeteer } from "./runtime/puppeteer.js";
import type { RoastRunOutcome } from "./runtime/roast-scheduler.js";
import { SkinStore } from "./skins/store.js";

interface BasicAuthCredentials {
	username: string;
	password: string;
}

export interface CreateAppOptions {
	/** Optional auth subsystem; when present /api/auth/* is mounted. */
	authSystem?: AuthSystem;
	/** Optional backup/restore service; when present /api/backup/* is mounted. */
	backupService?: BackupService;
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
	 * 把 stats 子路由实例递出去。
	 *
	 * 定时锐评的调度器要取统计数据,而取数是「内部代理一次 `/overview`」——
	 * 手动锐评在 handler 里做的就是这件事(`fetchOverview(app, …)`,传的正是这个
	 * 子实例)。子实例上没有鉴权中间件,鉴权挂在父 app 的 `/api/*`;调度器与
	 * handler 同属鉴权边界之内的进程内代码,所以这里递出去的是**同一条已有路径**
	 * 的引用,不是新开的信任面。走父 app 反而会被自己的鉴权 401 掉(它没有 cookie)。
	 */
	onStatsRoute?: (route: Hono) => void;
	/**
	 * 立刻跑一轮 —— 面板上的「试一次」。带 uid 跑单人,不带跑榜单。
	 * 由 `index.ts` 交给调度器;不传就是「还没就绪」,端点回 503。
	 */
	runRoastNow?: (uid?: string) => Promise<RoastRunOutcome>;
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
	 * Persist the runtime-selected browser source (chromePath / chromeEndpoint)
	 * back to the bootstrap yaml so card rendering stays enabled across
	 * restarts. Wired by index.ts (bound to the config path); omitted in
	 * deployments without a writable config file.
	 */
	persistChromeSource?: (source: ChromeSource) => Promise<void>;
	/**
	 * Notified after /api/cards/enable-rendering hot-enables rendering, so
	 * index.ts can update its global puppeteer reference for graceful dispose.
	 */
	onPuppeteerEnabled?: (puppeteer: StandalonePuppeteer) => void;
	/**
	 * Idle auto-close budget (ms) for adapters built by the hot-enable path,
	 * mirroring bootstrap.chromeIdleSeconds. Unset = adapter default.
	 */
	chromeIdleTimeoutMs?: number;
	/**
	 * Browser source that was actually used to build `puppeteer` at boot
	 * (endpoint wins over path). Feeds GET /api/cards/render-source.
	 */
	chromeSource?: ChromeSource;
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
	/**
	 * QQ 官方机器人网关发现表(群/C2C openid)。由 index.ts 与 QQ adapter 共享同一实例;
	 * `/api/qq/sessions/:id` 读它。省略 → 路由仍挂载但返回空列表。
	 */
	qqSessionRegistry?: QQSessionRegistry | null;
	/**
	 * 私聊指令注册表。globals PATCH 用它查别名冲突,`GET /api/commands` 用它
	 * 把「你可以在私聊里敲这些」列给面板 —— 注册表是可序列化的声明,这两件事都是
	 * 白拿的,不必再手写一份指令清单(手写的那份必然与实现脱节)。
	 */
	commands?: RouteDeps["commands"];
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
		qqSessionRegistry: options.qqSessionRegistry ?? null,
		commands: options.commands,
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
	app.route("/api/commands", createCommandsRoute(deps));
	app.route("/api/subs", createSubsRoute(deps));
	app.route("/api/adapters", createAdaptersRoute(deps));
	app.route("/api/targets", createTargetsRoute(deps));
	app.route("/api/live", createLiveRoute(deps));
	app.route("/api/history", createHistoryRoute(deps));
	app.route("/api/logs", createLogsRoute(deps));
	app.route("/api/push", createPushRoute(deps));
	app.route("/api/ai", createAiRoute(deps));
	app.route("/api/fans", createFansRoute(deps));
	const statsRoute = createStatsRoute(deps, {
		...(options.runRoastNow ? { runRoastNow: options.runRoastNow } : {}),
	});
	app.route("/api/stats", statsRoute);
	options.onStatsRoute?.(statsRoute);
	app.route("/api/qq", createQQRoute(deps));
	app.route(
		"/api/skins",
		createSkinsRoute({
			skinStore: new SkinStore({ skinsDir: joinPath(runtime.bootstrap.dataDir, "skins") }),
			// 热读:engines 是后挂的,ai-edit 每次现取,不做快照。
			commentary: () => runtime.engines?.commentary ?? null,
		}),
	);
	app.route(
		"/api/cards",
		createCardsRoute({
			deps,
			puppeteer: options.puppeteer ?? null,
			api: options.authSystem?.api ?? null,
			persistChromeSource: options.persistChromeSource,
			onPuppeteerEnabled: options.onPuppeteerEnabled,
			chromeIdleTimeoutMs: options.chromeIdleTimeoutMs,
			initialChromeSource: options.chromeSource,
		}),
	);
	if (options.authSystem) {
		app.route("/api/auth", createAuthRoute({ ...deps, authSystem: options.authSystem }));
	}

	// Backup/restore. Built in index.ts (needs the cookie store + a live re-login
	// hook from the auth system) and injected, so app.ts stays decoupled from
	// auth internals and the route only mounts when a service is provided.
	if (options.backupService) {
		app.route("/api/backup", createBackupRoute({ service: options.backupService }));
	}

	// Static dashboard. Mounted last so /api/* always wins routing. The cookie
	// gate (when configured) applies only to /api/*; the dashboard shell stays
	// reachable so the SPA can boot, probe `GET /api/session`, and render its
	// own login dialog. Dashboard assets are non-secret.
	if (options.staticDir) {
		// 缓存策略:serveStatic 默认只发 Last-Modified,浏览器按启发式缓存旧
		// index.html/JS —— 镜像更新后 API 已是新版而面板仍从缓存跑旧 bundle。
		// Vite 的 /assets/* 文件名含内容 hash → immutable 永久缓存;其余入口
		// (index.html / public 文件 / SPA fallback)no-cache 每次回源确认。
		// /api/* 命中路由后早已终结,只有落到 notFound 的才在这里排除。
		app.use("/*", async (c, next) => {
			await next();
			if (c.req.path.startsWith("/api/")) return;
			c.res.headers.set(
				"Cache-Control",
				c.req.path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
			);
		});
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
