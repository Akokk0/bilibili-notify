import type { MiddlewareHandler } from "hono";
import { safeEqual } from "./safe-equal.js";

export const DESKTOP_TOKEN_HEADER = "x-bn-desktop-token";
export const DESKTOP_TOKEN_QUERY = "desktopToken";

export function createDesktopTokenAuth(expectedToken: string): MiddlewareHandler {
	return async (c, next) => {
		if (isDesktopTokenExempt(c.req.path)) return next();
		const token = c.req.header(DESKTOP_TOKEN_HEADER);
		if (!token || !safeEqual(token, expectedToken)) {
			return c.json({ error: "desktop_token_required", message: "desktop token required" }, 401);
		}
		return next();
	};
}

export function isDesktopWsTokenAllowed(url: string | undefined, expectedToken: string): boolean {
	if (!url) return false;
	const queryStart = url.indexOf("?");
	if (queryStart < 0) return false;
	const token = new URLSearchParams(url.slice(queryStart + 1)).get(DESKTOP_TOKEN_QUERY);
	return !!token && safeEqual(token, expectedToken);
}

function isDesktopTokenExempt(path: string): boolean {
	return path === "/api/health";
}
