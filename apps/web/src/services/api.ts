/**
 * Thin fetch wrapper for /api/* endpoints. Vite dev server proxies these to
 * the standalone Hono server (see vite.config.ts). In production the dashboard
 * is served from the same origin, so relative paths just work.
 */

import { withDesktopTokenHeader } from "./desktop-token";

export class ApiError extends Error {
	constructor(
		public readonly status: number,
		public readonly body: unknown,
		message: string,
	) {
		super(message);
		this.name = "ApiError";
	}
}

/**
 * Global 401 hook. `<AuthGate>` registers a handler that flips the dashboard
 * session to unauthed (→ login dialog). Kept as a registration callback so
 * this thin wrapper stays free of store/React knowledge. Session endpoints
 * (`/api/session/*`) are excluded — a login 401 means "wrong password",
 * handled by the dialog itself, not a session-expiry signal.
 */
type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler | null = null;
export function setUnauthorizedHandler(fn: UnauthorizedHandler | null): void {
	onUnauthorized = fn;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
	const res = await fetch(path, {
		method,
		headers: withDesktopTokenHeader(
			body !== undefined ? { "content-type": "application/json" } : undefined,
		),
		body: body !== undefined ? JSON.stringify(body) : undefined,
		credentials: "include",
	});
	let payload: unknown;
	if (res.headers.get("content-type")?.includes("application/json")) {
		payload = await res.json().catch(() => undefined);
	}
	if (!res.ok) {
		if (res.status === 401 && !path.startsWith("/api/session")) {
			onUnauthorized?.();
		}
		const msg =
			typeof payload === "object" && payload && "message" in payload
				? String((payload as { message: unknown }).message)
				: `${method} ${path} → ${res.status}`;
		throw new ApiError(res.status, payload, msg);
	}
	return payload as T;
}

/**
 * Multipart upload(背景图等)。不设 content-type —— 让浏览器自动带上 multipart
 * boundary;其余(desktop token / 凭据 / 错误处理)与 `request` 一致。
 */
async function upload<T>(path: string, form: FormData): Promise<T> {
	const res = await fetch(path, {
		method: "POST",
		headers: withDesktopTokenHeader(),
		body: form,
		credentials: "include",
	});
	let payload: unknown;
	if (res.headers.get("content-type")?.includes("application/json")) {
		payload = await res.json().catch(() => undefined);
	}
	if (!res.ok) {
		if (res.status === 401 && !path.startsWith("/api/session")) onUnauthorized?.();
		const msg =
			typeof payload === "object" && payload && "err" in payload
				? String((payload as { err: unknown }).err)
				: `POST ${path} → ${res.status}`;
		throw new ApiError(res.status, payload, msg);
	}
	return payload as T;
}

/**
 * 取二进制资源(背景图缩略图等)。复用同一套 desktop token / 凭据 —— `<img src>` 不会
 * 带自定义 header,桌面壳 token-header 鉴权下直接 401;故由此 fetch 拿 Blob,调用方再
 * `URL.createObjectURL` 喂给 `<img>`。token 留在 header、不进 URL。
 */
async function requestBlob(path: string): Promise<Blob> {
	const res = await fetch(path, {
		headers: withDesktopTokenHeader(),
		credentials: "include",
	});
	if (!res.ok) {
		if (res.status === 401 && !path.startsWith("/api/session")) onUnauthorized?.();
		throw new ApiError(res.status, undefined, `GET ${path} → ${res.status}`);
	}
	return res.blob();
}

export const api = {
	get: <T>(path: string) => request<T>("GET", path),
	post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
	patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
	delete: <T>(path: string) => request<T>("DELETE", path),
	upload: <T>(path: string, form: FormData) => upload<T>(path, form),
	blob: (path: string) => requestBlob(path),
};
