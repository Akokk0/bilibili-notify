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

/**
 * 从错误响应体里挑出给人看的那句话。
 *
 * 服务端有**两种**错误体形状:`{err}`(锐评 / 推送测试 / 卡片测试…)与
 * `{message}`(backup…)。两边都要认 —— 只认一种的话,另一种会被降级成
 * 「POST /api/… → 400」这种线格式噪音,用户看不到「智能女仆尚未启用」这类真正
 * 可操作的原因,只能来问「这功能是不是没写」。
 */
function errorMessage(payload: unknown, what: string, status: number): string {
	if (typeof payload === "object" && payload !== null) {
		for (const key of ["err", "message"] as const) {
			if (key in payload) {
				const v = (payload as Record<string, unknown>)[key];
				if (typeof v === "string" && v.trim()) return v;
			}
		}
	}
	return `${what} → ${status}`;
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
		throw new ApiError(res.status, payload, errorMessage(payload, `${method} ${path}`, res.status));
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
		throw new ApiError(res.status, payload, errorMessage(payload, `POST ${path}`, res.status));
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

function isPlainObject(v: unknown): v is Record<string, unknown> {
	if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
	const proto = Object.getPrototypeOf(v);
	return proto === Object.prototype || proto === null;
}

/**
 * SY1 —— PATCH 线格式:把 `undefined` 改写成 `null`(服务端的清除哨兵)。
 *
 * `JSON.stringify` 会把值为 `undefined` 的键整个丢掉,于是「清空一个可选字段」
 * 在 PATCH body 里根本表达不出来:键消失 → 服务端 deepMerge(config/store.ts)
 * 读作「本字段不改」→ 旧值原样留下 → 页面保存后依然是脏的。服务端约定显式
 * `null` = 清除该键,所以在唯一的出口把 `undefined` 翻译过去。
 *
 * 「不改这个字段」的表达方式仍然是**不写这个键**,而不是写 `undefined` —— 两者
 * 在 JSON 里本就不可区分,这里只是把前端唯一能表达的那个意图(清空)落到线上。
 * POST 不做此转换:那是创建语义,`undefined` 表示「没有这个字段」,转成 null 会
 * 被后端 schema 拒。
 */
function nullifyUndefined(value: unknown): unknown {
	if (value === undefined) return null;
	if (Array.isArray(value)) return value.map(nullifyUndefined);
	if (isPlainObject(value)) {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) out[k] = nullifyUndefined(v);
		return out;
	}
	return value;
}

export const api = {
	get: <T>(path: string) => request<T>("GET", path),
	post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
	patch: <T>(path: string, body?: unknown) =>
		request<T>("PATCH", path, body === undefined ? undefined : nullifyUndefined(body)),
	delete: <T>(path: string) => request<T>("DELETE", path),
	upload: <T>(path: string, form: FormData) => upload<T>(path, form),
	blob: (path: string) => requestBlob(path),
};
