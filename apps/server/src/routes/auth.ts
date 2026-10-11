import { fail, ok } from "@bilibili-notify/internal";
import { Hono } from "hono";
import { BiliLoginStatus } from "../bilibili/api/index.js";
import type { AuthSystem } from "../bilibili/auth/index.js";
import { respondFailure } from "./respond-failure.js";
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
 * - POST   /logout              → clears the bilibili cookies (file + live jar), transitions to
 *                                  NOT_LOGIN; master.key untouched. Works when not logged in too —
 *                                  that is how a cookie file that no longer decrypts gets cleared.
 *
 * Note: the QR PNG itself is NOT returned over HTTP — it is published as a
 * `login-status-report` event over the WS `auth` channel by `LoginFlow.beginLogin`.
 *
 * 失败一律经 `respondFailure`(ADR-0026):已经有扫码在进行 `conflict` 409;流程抛错(bug 或没料到的故障)
 * 回 `unavailable` 503 与一句固定的话,原因只进日志 —— 抛出来的原话不外泄。登录流程改走
 * `SourceAuth` 后按结果形状回失败(construction-plan「施工中顺手修」,第 3a 期)。
 */
export function createAuthRoute(deps: AuthRouteDeps): Hono {
	const app = new Hono();
	const log = deps.runtime.serviceCtx.logger;

	app.get("/status", (c) => c.json(deps.authSystem.status()));

	app.post("/qr", async (c) => {
		// 409 conflict guard: a QR session is already pending.
		const current = deps.authSystem.status();
		if (
			current.status === BiliLoginStatus.LOGIN_QR ||
			current.status === BiliLoginStatus.LOGGING_QR
		) {
			return respondFailure(c, fail("conflict", "已经有一个扫码登录在进行了，先重置再重新开始"));
		}
		try {
			const begun = await deps.authSystem.auth.beginLogin();
			if (!begun.ok) return respondFailure(c, begun);
			return c.json(ok());
		} catch (err) {
			log.error("POST /api/auth/qr failed", err);
			return respondFailure(c, fail("unavailable", "发起扫码登录失败，详情在日志里"));
		}
	});

	app.post("/cookies/refresh", async (c) => {
		try {
			await deps.authSystem.refreshCookies();
			return c.json(ok());
		} catch (err) {
			log.error("POST /api/auth/cookies/refresh failed", err);
			return respondFailure(c, fail("unavailable", "刷新 Cookie 失败，详情在日志里"));
		}
	});

	app.post("/logout", async (c) => {
		try {
			const out = await deps.authSystem.auth.logout();
			if (!out.ok) return respondFailure(c, out);
			return c.json(ok());
		} catch (err) {
			log.error("POST /api/auth/logout failed", err);
			return respondFailure(c, fail("unavailable", "退出登录失败，详情在日志里"));
		}
	});

	return app;
}
