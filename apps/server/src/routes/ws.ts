import { Hono } from "hono";
import type { RouteDeps } from "./types.js";

/**
 * `/api/ws/*` — 面板 WebSocket 的前置口(ADR-0036 决策 3)。
 *
 * - `POST /ticket` → 换一张一次性短时 ticket。
 *
 * 浏览器 WebSocket 无法附带 Authorization 头;cookie 闸放行过的 REST 请求换一个一次性短时 ticket,
 * WS upgrade 用 `?ticket=<xxx>` 完成鉴权,避免把真实凭证拼进 WS URL(会被反代日志记录)。
 *
 * 🔴 **要登录才给的东西不许放进 `/api/session` 底下**:那个前缀免 cookie 闸(登录口要免闸)。
 * 这里在 `/api/ws` 下、吃同一道 cookie 闸 —— 没带 cookie 拿不到票,接线守卫
 * (`__tests__/routes-by-resource-mount.test.ts`)钉着。
 */
export function createWsRoute(deps: Pick<RouteDeps, "wsTicketStore">): Hono {
	const app = new Hono();

	app.post("/ticket", (c) => {
		if (!deps.wsTicketStore) {
			// basicAuth 未启用时 WS 同样不需鉴权,前端无须 ticket。
			return c.json({ ticket: null, expiresInMs: 0 });
		}
		return c.json(deps.wsTicketStore.issue());
	});

	return app;
}
