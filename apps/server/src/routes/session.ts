import { fail, ok, type Result } from "@bilibili-notify/internal";
import { type Context, Hono } from "hono";
import { isSecureRequest } from "../auth/dashboard-auth.js";
import type { IpRateLimiter } from "../auth/ip-rate-limit.js";
import { isOriginAllowed, normalizeAllowedOrigins } from "../auth/origin.js";
import type { SessionCodec, SessionCreds } from "../auth/session.js";
import { t as serverText, t } from "../i18n/index.js";
import { respondFailure } from "./respond-failure.js";

/** 新密码至少几位(面板改账号密码)。 */
export const PASSWORD_MIN_CHARS = 8;
/** 账号与密码最长几个字符。 */
export const CREDENTIAL_MAX_CHARS = 256;

/** 登录与改账号密码共用的两句。 */
const rateLimited = () => serverText("service.routes.session.text.1");
const notJson = () => serverText("service.routes.session.text.2");

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
	/** Session codec(连着此刻配的面板凭据)—— 面板没开登录时是 undefined。 */
	codec: SessionCodec | undefined;
	/**
	 * 面板改账号密码的写口:把新凭据写回配置文件,写不了回失败(旧式部署的环境变量、没有配置文件……)。
	 * 不给 = 这个部署改不了(`PUT /credentials` 回 `unsupported`)。
	 */
	changeCredentials?: (creds: SessionCreds) => Promise<Result>;
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
	const authRequired = !!deps.codec;
	const allowedOrigins = normalizeAllowedOrigins(deps.allowedOrigins);

	/** 403 unless the request's Origin clears the (optional) allow-list. */
	const originRejected = (c: Context): Response | null =>
		isOriginAllowed(c.req.header("origin"), allowedOrigins)
			? null
			: respondFailure(c, fail("invalid", serverText("service.routes.session.text.3")), 403);

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

		if (!deps.codec) {
			return respondFailure(c, fail("unsupported", serverText("service.routes.session.text.4")));
		}

		const ip = deps.rateLimiter.ip(c);
		const blockedMs = deps.rateLimiter.blocked(ip);
		if (blockedMs !== null) {
			c.header("Retry-After", String(Math.ceil(blockedMs / 1000)));
			return respondFailure(c, fail("rate_limited", rateLimited()));
		}

		let body: LoginBody;
		try {
			body = (await c.req.json()) as LoginBody;
		} catch {
			return respondFailure(c, fail("invalid", notJson()));
		}
		const username = typeof body?.username === "string" ? body.username : "";
		const password = typeof body?.password === "string" ? body.password : "";

		// 账号密码一起按指纹比(常量时间):不会因为账号错了就跳过比密码、漏出「账号对不对」的时差。
		if (!deps.codec.matches(username, password)) {
			deps.rateLimiter.fail(ip);
			return respondFailure(
				c,
				fail("unauthorized", serverText("service.routes.session.text.5")),
				401,
			);
		}

		deps.rateLimiter.succeed(ip);
		c.header(
			"Set-Cookie",
			deps.codec.buildSetCookie(deps.codec.sign(), { secure: isSecureRequest(c) }),
		);
		return c.json(ok());
	});

	/**
	 * 面板改账号密码:要登录着、再报一遍当前密码(会话被人借走也改不了);新凭据经写口写回配置文件,
	 * 写成了才换 —— 换了以后此前的会话(连这一个)全部失效,回话清掉 cookie,面板回登录框。
	 */
	app.put("/credentials", async (c) => {
		const denied = originRejected(c);
		if (denied) return denied;
		const codec = deps.codec;
		if (!codec || !deps.changeCredentials) {
			return respondFailure(c, fail("unsupported", t("session.credentials.unsupported")));
		}
		if (!codec.verify(codec.readCookie(c.req.header("cookie")))) {
			return respondFailure(c, fail("unauthorized", t("session.credentials.loginFirst")), 401);
		}

		const ip = deps.rateLimiter.ip(c);
		const blockedMs = deps.rateLimiter.blocked(ip);
		if (blockedMs !== null) {
			c.header("Retry-After", String(Math.ceil(blockedMs / 1000)));
			return respondFailure(c, fail("rate_limited", rateLimited()));
		}

		let body: Record<string, unknown>;
		try {
			body = (await c.req.json()) as Record<string, unknown>;
		} catch {
			return respondFailure(c, fail("invalid", notJson()));
		}
		const current = typeof body?.currentPassword === "string" ? body.currentPassword : "";
		if (!codec.matches(codec.username(), current)) {
			deps.rateLimiter.fail(ip);
			return respondFailure(c, fail("unauthorized", t("session.credentials.wrongPassword")), 401);
		}
		deps.rateLimiter.succeed(ip);

		const username = typeof body.username === "string" ? body.username.trim() : "";
		const password = typeof body.password === "string" ? body.password : "";
		if (username === "" || username.length > CREDENTIAL_MAX_CHARS) {
			return respondFailure(c, fail("invalid", t("session.credentials.badUsername")));
		}
		if (password.length < PASSWORD_MIN_CHARS || password.length > CREDENTIAL_MAX_CHARS) {
			return respondFailure(c, fail("invalid", t("session.credentials.badPassword")));
		}

		const next = { username, password };
		const written = await deps.changeCredentials(next);
		if (!written.ok) return respondFailure(c, written);
		codec.rotate(next);
		c.header("Set-Cookie", codec.buildClearCookie({ secure: isSecureRequest(c) }));
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
