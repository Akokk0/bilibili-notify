import { fail } from "@bilibili-notify/internal";
import type { MiddlewareHandler } from "hono";
import { t as serverText } from "../i18n/index.js";
import { respondFailure } from "../routes/respond-failure.js";
import { readCookie } from "./cookie.js";
import { safeEqual } from "./safe-equal.js";

const DESKTOP_TOKEN_HEADER = "x-bn-desktop-token";
const DESKTOP_TOKEN_QUERY = "desktopToken";
const DESKTOP_TOKEN_COOKIE = "bn_desktop";

/**
 * 桌面壳的令牌闸:请求头或 cookie 带对令牌才放行。
 *
 * **为什么也认 cookie**(ADR-0036 决策 5 下 10-03 的 🔗):`<img>`、CSS `url()`、`@font-face` 带不了
 * 自定义头,只认头的话,桌面版里直连地址的图一律 401。所以带对令牌头的那一次顺手种一个 cookie,之后
 * 这些请求靠它过闸。门槛不变:它只住在桌面壳自己的 webview 里(`HttpOnly` 脚本读不到,`SameSite=Strict`
 * 别的站带不上,换主机名的 DNS 重绑定也带不上),令牌每次启动都换,上一次的 cookie 自然作废。
 */
export function createDesktopTokenAuth(expectedToken: string): MiddlewareHandler {
	return async (c, next) => {
		if (isDesktopTokenExempt(c.req.path)) return next();
		const header = c.req.header(DESKTOP_TOKEN_HEADER);
		const cookie = readCookie(c.req.header("cookie"), DESKTOP_TOKEN_COOKIE);
		const headerOk = !!header && safeEqual(header, expectedToken);
		const cookieOk = !!cookie && safeEqual(cookie, expectedToken);
		if (!headerOk && !cookieOk) {
			// 401 显式给:这是看板自己的门(桌面壳的令牌),面板见 401 就回登录框。
			return respondFailure(
				c,
				fail("unauthorized", serverText("service.auth.desktop-token.text.1")),
				401,
			);
		}
		if (!cookieOk) {
			// 不设 Max-Age:随 webview 会话走。不设 Secure:桌面壳走的是 http 回环。
			c.header(
				"Set-Cookie",
				`${DESKTOP_TOKEN_COOKIE}=${expectedToken}; Path=/api; HttpOnly; SameSite=Strict`,
				{ append: true },
			);
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
