import { fail } from "@bilibili-notify/internal";
import type { MiddlewareHandler } from "hono";
import { respondFailure } from "../routes/respond-failure.js";
import { safeEqual } from "./safe-equal.js";

const DESKTOP_TOKEN_HEADER = "x-bn-desktop-token";
const DESKTOP_TOKEN_QUERY = "desktopToken";

export function createDesktopTokenAuth(expectedToken: string): MiddlewareHandler {
	return async (c, next) => {
		if (isDesktopTokenExempt(c.req.path)) return next();
		const token = c.req.header(DESKTOP_TOKEN_HEADER);
		if (!token || !safeEqual(token, expectedToken)) {
			// 401 显式给:这是看板自己的门(桌面壳的令牌),面板见 401 就回登录框。
			return respondFailure(c, fail("unauthorized", "缺少桌面壳的访问令牌"), 401);
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
