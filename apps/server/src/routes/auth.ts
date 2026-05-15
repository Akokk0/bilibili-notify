import { BiliLoginStatus } from "@bilibili-notify/api";
import { Hono } from "hono";
import type { AuthSystem } from "../auth/index.js";
import type { RouteDeps } from "./types.js";

export interface AuthRouteDeps extends RouteDeps {
	authSystem: AuthSystem;
}

/**
 * `/api/auth/*` — auth-flow control plane for the dashboard.
 *
 * - GET    /status              → current LoginSnapshot
 * - POST   /qr                  → kicks off LoginFlow.beginLogin; QR url flows via WS auth channel
 * - POST   /cookies/refresh     → forces a cookie refresh check
 * - POST   /cookies/reset       → wipes secrets (master.key + cookies.json)
 * - POST   /logout              → clears cookies, transitions to NOT_LOGIN
 *
 * Note: the QR PNG itself is NOT returned over HTTP — it is published as a
 * `login-status-report` event over the WS `auth` channel by `LoginFlow.beginLogin`.
 */
export function createAuthRoute(deps: AuthRouteDeps): Hono {
	const app = new Hono();
	const log = deps.runtime.serviceCtx.logger;

	app.get("/status", (c) => c.json(deps.authSystem.status()));

	// 浏览器 WebSocket 无法附带 Authorization 头;basicAuth 通过的 REST 请求换
	// 一个一次性短时 ticket,WS upgrade 用 `?ticket=<xxx>` 完成鉴权,避免把真实
	// 凭证拼进 WS URL(会被反代日志记录)。
	app.post("/ws-ticket", (c) => {
		if (!deps.wsTicketStore) {
			// basicAuth 未启用时 WS 同样不需鉴权,前端无须 ticket。
			return c.json({ ticket: null, expiresInMs: 0 });
		}
		return c.json(deps.wsTicketStore.issue());
	});

	app.post("/qr", async (c) => {
		// 409 conflict guard: a QR session is already pending.
		const current = deps.authSystem.status();
		if (
			current.status === BiliLoginStatus.LOGIN_QR ||
			current.status === BiliLoginStatus.LOGGING_QR
		) {
			return c.json(
				{
					error: "qr_already_active",
					message: "A QR-login session is already in progress. Reset before starting a new one.",
				},
				409,
			);
		}
		try {
			await deps.authSystem.beginLogin();
			return c.json({ ok: true });
		} catch (err) {
			log.error("POST /api/auth/qr failed", err);
			return c.json({ error: "auth_failed", message: "failed to start QR login" }, 500);
		}
	});

	app.post("/cookies/refresh", async (c) => {
		try {
			await deps.authSystem.refreshCookies();
			return c.json({ ok: true });
		} catch (err) {
			log.error("POST /api/auth/cookies/refresh failed", err);
			return c.json({ error: "auth_failed", message: "failed to refresh cookies" }, 500);
		}
	});

	app.post("/cookies/reset", async (c) => {
		try {
			await deps.authSystem.resetCookies();
			return c.json({ ok: true });
		} catch (err) {
			log.error("POST /api/auth/cookies/reset failed", err);
			return c.json({ error: "auth_failed", message: "failed to reset cookies" }, 500);
		}
	});

	app.post("/logout", async (c) => {
		try {
			await deps.authSystem.logout();
			return c.json({ ok: true });
		} catch (err) {
			log.error("POST /api/auth/logout failed", err);
			return c.json({ error: "auth_failed", message: "failed to log out" }, 500);
		}
	});

	return app;
}
