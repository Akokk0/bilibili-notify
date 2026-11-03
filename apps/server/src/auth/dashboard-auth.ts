import { fail } from "@bilibili-notify/internal";
import type { Context, MiddlewareHandler } from "hono";
import { t as serverText } from "../i18n/index.js";
import { respondFailure } from "../routes/respond-failure.js";
import type { SessionCodec } from "./session.js";

/**
 * Dashboard `/api/*` gate (cookie-session model). Replaces the old
 * `createRateLimitedBasicAuth`.
 *
 * - Validates the `bn_session` cookie via {@link SessionCodec}. Valid → slides
 *   the idle window (re-issues a fresh Set-Cookie past half-life) and proceeds.
 * - Invalid/absent → `401 { code: "unauthorized", message }` JSON (the 401 is explicit —
 *   `unauthorized` defaults to 403; the SPA kicks back to the login dialog on 401 only,
 *   so only the dashboard's own session expiry may answer it), deliberately **without**
 *   `WWW-Authenticate` (that header's only effect is to make browsers pop the
 *   native credential box — the very thing the SPA login dialog replaces).
 * - **No** `Authorization: Basic` acceptance (Q4: cookie-only, Basic dropped).
 * - `/api/session/*` (login / logout / status) is exempt — those must be
 *   reachable precisely when there is no valid cookie.
 *
 * No per-request rate-limit here: cookie verification is a constant-time HMAC
 * check with no brute-force surface. The IP token-bucket now guards
 * `POST /api/session/login` instead (see `ip-rate-limit.ts`).
 */

/** True iff the request arrived over https (direct or via a TLS-terminating proxy). */
export function isSecureRequest(c: Context): boolean {
	if (c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() === "https") return true;
	try {
		return new URL(c.req.url).protocol === "https:";
	} catch {
		return false;
	}
}

function isExempt(path: string): boolean {
	return path === "/api/session" || path.startsWith("/api/session/");
}

export function createDashboardAuth(codec: SessionCodec): MiddlewareHandler {
	return async (c, next) => {
		if (isExempt(c.req.path)) return next();

		const token = codec.readCookie(c.req.header("cookie"));
		if (!codec.verify(token)) {
			return respondFailure(
				c,
				fail("unauthorized", serverText("service.auth.dashboard-auth.text.1")),
				401,
			);
		}

		// Sliding renewal: a still-valid token past half-life gets a fresh
		// cookie so an actively-used dashboard never expires mid-session.
		if (token && codec.shouldReissue(token)) {
			c.header("Set-Cookie", codec.buildSetCookie(codec.sign(), { secure: isSecureRequest(c) }), {
				append: true,
			});
		}
		return next();
	};
}
