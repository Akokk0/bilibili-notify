import { fail, ok, type Result } from "@bilibili-notify/internal/result";
import { i18n } from "../i18n";
/**
 * Dashboard session HTTP calls. Kept separate from `services/api.ts` so the
 * generic 401 interceptor there never recurses through these endpoints (login
 * 401 = wrong password, handled by the dialog — not a session-expiry signal).
 * It borrows only the pure error-body parser (`apiErrorOf`), never the fetch wrapper.
 */

import { apiErrorOf } from "./api";
import { withDesktopTokenHeader } from "./desktop-token";

export interface SessionStatus {
	authRequired: boolean;
	authed: boolean;
}

/** Retry-After 由响应头取得，仅供登录框倒计时。 */
export type LoginResult = Result & { retryAfterSec?: number };

/** `GET /api/session` — always 200 in practice; treats failure as "unknown → not authed". */
export async function fetchSessionStatus(): Promise<SessionStatus> {
	const res = await fetch("/api/session", {
		headers: withDesktopTokenHeader(),
		credentials: "include",
	});
	if (!res.ok) return { authRequired: true, authed: false };
	const body = (await res.json().catch(() => null)) as Partial<SessionStatus> | null;
	return {
		authRequired: body?.authRequired === true,
		authed: body?.authed === true,
	};
}

/**
 * Map a `POST /api/session/login` response into a typed result. Pure-ish (no DOM).
 *
 * 按错误体的 `code` 分(ADR-0026),不按状态码:`rate_limited`(读 `Retry-After`)/ `unauthorized`
 * (账号密码错)/ `unsupported`(没开登录)。同为 400 的「请求体不是 JSON」是 `invalid`,落到
 * 通用错误而不会被当成「没开登录」把登录框关掉。
 */
export async function classifyLoginResponse(res: Response): Promise<LoginResult> {
	if (res.ok) return ok();
	const err = apiErrorOf(
		res.status,
		await res.json().catch(() => undefined),
		i18n.t("panelUi.services.session.1", { value0: res.status }),
	);
	switch (err.code) {
		case "rate_limited": {
			const hdr = Number(res.headers.get("Retry-After"));
			const retryAfterSec = Number.isFinite(hdr) && hdr > 0 ? hdr : 60;
			return {
				...fail("rate_limited", i18n.t("panelUi.services.session.2", { value0: retryAfterSec })),
				retryAfterSec,
			};
		}
		case "unauthorized":
			return fail("unauthorized", err.message);
		// 只有服务端明确告知未启用鉴权时，登录框才关闭；不可从裸 HTTP 状态推断。
		case "unsupported":
			return fail("unsupported", err.message);
		default:
			return fail(err.code ?? "unavailable", err.message);
	}
}

export async function submitLogin(username: string, password: string): Promise<LoginResult> {
	let res: Response;
	try {
		res = await fetch("/api/session/login", {
			method: "POST",
			headers: withDesktopTokenHeader({ "content-type": "application/json" }),
			credentials: "include",
			body: JSON.stringify({ username, password }),
		});
	} catch {
		return fail("unavailable", i18n.t("panelUi.services.session.3"));
	}
	return classifyLoginResponse(res);
}

export async function submitLogout(): Promise<void> {
	try {
		await fetch("/api/session/logout", {
			method: "POST",
			headers: withDesktopTokenHeader(),
			credentials: "include",
		});
	} catch {
		// Logout is best-effort client-side; the cookie is httpOnly so we rely
		// on the server's clearing Set-Cookie. A network failure here still
		// flips local state via the caller.
	}
}
