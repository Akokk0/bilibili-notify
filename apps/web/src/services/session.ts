/**
 * Dashboard session HTTP calls. Kept separate from `services/api.ts` so the
 * generic 401 interceptor there never recurses through these endpoints (login
 * 401 = wrong password, handled by the dialog — not a session-expiry signal).
 */

import { withDesktopTokenHeader } from "./desktop-token";

export interface SessionStatus {
	authRequired: boolean;
	authed: boolean;
}

export type LoginResult =
	| { ok: true }
	| { ok: false; kind: "invalid"; message: string }
	| { ok: false; kind: "rate_limited"; retryAfterSec: number; message: string }
	/**
	 * 后端权威告知「未启用鉴权」(`POST /api/session/login` → 400)。AuthGate 的
	 * `fetchSessionStatus` 在初始探测失败(503/瞬时网络错)时会兜底成 authRequired:true
	 * 弹 dialog —— 用户随后真去提交登录就会撞到这条。此时 LoginDialog 应据此把 store
	 * 同步回 authRequired:false 让壳关闭,而不是只显示一条用户无法处理的报错。
	 */
	| { ok: false; kind: "auth_disabled" }
	| { ok: false; kind: "error"; message: string };

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

/** Map a `POST /api/session/login` response into a typed result. Pure-ish (no DOM). */
export async function classifyLoginResponse(res: Response): Promise<LoginResult> {
	if (res.ok) return { ok: true };
	if (res.status === 429) {
		const hdr = Number(res.headers.get("Retry-After"));
		const retryAfterSec = Number.isFinite(hdr) && hdr > 0 ? hdr : 60;
		return {
			ok: false,
			kind: "rate_limited",
			retryAfterSec,
			message: `登录尝试过多,请 ${retryAfterSec} 秒后再试`,
		};
	}
	if (res.status === 401) {
		return { ok: false, kind: "invalid", message: "账号或密码错误" };
	}
	if (res.status === 400) {
		return { ok: false, kind: "auth_disabled" };
	}
	return { ok: false, kind: "error", message: `登录失败 (HTTP ${res.status})` };
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
		return { ok: false, kind: "error", message: "无法连接服务器" };
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
