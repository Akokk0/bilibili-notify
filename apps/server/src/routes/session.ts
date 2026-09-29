import { fail, ok } from "@bilibili-notify/internal";
import { type Context, Hono } from "hono";
import { isSecureRequest } from "../auth/dashboard-auth.js";
import type { IpRateLimiter } from "../auth/ip-rate-limit.js";
import { isOriginAllowed, normalizeAllowedOrigins } from "../auth/origin.js";
import { safeEqual } from "../auth/safe-equal.js";
import type { SessionCodec, SessionCreds } from "../auth/session.js";
import { respondFailure } from "./respond-failure.js";

/**
 * `/api/session/*` — dashboard session control plane. Mounted **outside** the
 * `createDashboardAuth` gate (login can't require being logged in; the status
 * probe is what decides whether to show the login dialog; logout must work
 * even with a stale cookie).
 *
 * - `GET  /api/session`        → `{ authRequired, authed }` — always 200, no
 *   version/topology leak, no rate-limit. The SPA boot gate reads this.
 * - `POST /api/session/login`  → `{username,password}` constant-time check vs
 *   the configured dashboard creds; success sets the `bn_session` cookie. This
 *   is the relocated brute-force surface → IP token-bucket guards it.
 * - `POST /api/session/logout` → clears the cookie. Idempotent.
 *
 * When dashboard auth is not configured (`creds` undefined) the whole feature
 * is inert: status reports `authRequired:false`, login is 400 (`unsupported`), logout
 * is a no-op 200.
 *
 * Failures go through `respondFailure` (ADR-0026): the SPA tells them apart by `code`
 * — wrong credentials `unauthorized` (an explicit 401: `/api/session/*` is exempt from
 * the SPA's session-expiry hook), throttled `rate_limited` (+ `Retry-After`), auth
 * switched off `unsupported`, a foreign Origin `invalid` (an explicit 403).
 */
export interface SessionRouteDeps {
	/** Configured dashboard credentials, or undefined when auth is disabled. */
	creds: SessionCreds | undefined;
	/** Session codec — undefined exactly when `creds` is undefined. */
	codec: SessionCodec | undefined;
	/** Shared IP limiter guarding the login endpoint. */
	rateLimiter: IpRateLimiter;
	/**
	 * WS-shared Origin allow-list. When configured (non-empty) the state-changing
	 * POST routes (`/login`, `/logout`) require a whitelisted `Origin` —
	 * defence-in-depth against cross-site abuse of these unguarded endpoints
	 * (e.g. forced-logout CSRF) on top of the SameSite=Strict cookie. Empty /
	 * unset → no Origin enforcement (same opt-in posture as the WS gate).
	 */
	allowedOrigins?: readonly string[];
}

interface LoginBody {
	username: unknown;
	password: unknown;
}

export function createSessionRoute(deps: SessionRouteDeps): Hono {
	const app = new Hono();
	const authRequired = !!deps.creds && !!deps.codec;
	const allowedOrigins = normalizeAllowedOrigins(deps.allowedOrigins);

	/** 403 unless the request's Origin clears the (optional) allow-list. */
	const originRejected = (c: Context): Response | null =>
		isOriginAllowed(c.req.header("origin"), allowedOrigins)
			? null
			: respondFailure(c, fail("invalid", "请求来源不被允许"), 403);

	app.get("/", (c) => {
		const authed =
			!authRequired ||
			(!!deps.codec && deps.codec.verify(deps.codec.readCookie(c.req.header("cookie"))));
		return c.json({ authRequired, authed });
	});

	app.post("/login", async (c) => {
		// Origin gate first: a disallowed cross-site caller gets 403 without
		// touching the rate-limit bucket or revealing auth state.
		const denied = originRejected(c);
		if (denied) return denied;

		if (!authRequired || !deps.creds || !deps.codec) {
			return respondFailure(c, fail("unsupported", "面板没有开登录，用不着登录"));
		}

		const ip = deps.rateLimiter.ip(c);
		const blockedMs = deps.rateLimiter.blocked(ip);
		if (blockedMs !== null) {
			c.header("Retry-After", String(Math.ceil(blockedMs / 1000)));
			return respondFailure(c, fail("rate_limited", "登录失败次数过多，请稍后再试。"));
		}

		let body: LoginBody;
		try {
			body = (await c.req.json()) as LoginBody;
		} catch {
			return respondFailure(c, fail("invalid", "请求体要是 JSON"));
		}
		const username = typeof body?.username === "string" ? body.username : "";
		const password = typeof body?.password === "string" ? body.password : "";

		// Evaluate BOTH sides before combining — `&&` would short-circuit and
		// skip the password compare on a wrong username, leaking a
		// username-enumeration timing signal.
		const userOk = safeEqual(username, deps.creds.username);
		const passOk = safeEqual(password, deps.creds.password);
		if (!(userOk && passOk)) {
			deps.rateLimiter.fail(ip);
			return respondFailure(c, fail("unauthorized", "账号或密码错误"), 401);
		}

		deps.rateLimiter.succeed(ip);
		c.header(
			"Set-Cookie",
			deps.codec.buildSetCookie(deps.codec.sign(), { secure: isSecureRequest(c) }),
		);
		return c.json(ok());
	});

	app.post("/logout", (c) => {
		// Origin gate: stops a cross-site page from force-clearing the cookie
		// (the endpoint otherwise needs no auth and always clears).
		const denied = originRejected(c);
		if (denied) return denied;

		// Idempotent: clear the cookie regardless of whether one was valid. When
		// auth is disabled there is no codec — nothing to clear, still 200.
		if (deps.codec) {
			c.header("Set-Cookie", deps.codec.buildClearCookie({ secure: isSecureRequest(c) }));
		}
		return c.json(ok());
	});

	return app;
}
