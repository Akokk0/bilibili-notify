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

export const api = {
	get: <T>(path: string) => request<T>("GET", path),
	post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
	patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
	delete: <T>(path: string) => request<T>("DELETE", path),
};
