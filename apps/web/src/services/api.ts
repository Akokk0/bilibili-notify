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
 * 服务端有**三种**错误体形状:`{err}`(锐评 / 推送测试 / 卡片测试…)、
 * `{message}`(backup…)与 `{errors: string[]}`(皮肤上传 / 编辑保存的字段级
 * 校验)。都要认 —— 漏认一种,那一路的失败就被降级成「POST /api/… → 400」这种
 * 线格式噪音,用户看不到「哪个字段不合法」这类真正可操作的原因。
 */
function errorMessage(payload: unknown, what: string, status: number): string {
	if (typeof payload === "object" && payload !== null) {
		for (const key of ["err", "message"] as const) {
			if (key in payload) {
				const v = (payload as Record<string, unknown>)[key];
				if (typeof v === "string" && v.trim()) return v;
			}
		}
		const errors = (payload as Record<string, unknown>).errors;
		if (Array.isArray(errors)) {
			const lines = errors.filter((e): e is string => typeof e === "string" && e.trim() !== "");
			if (lines.length > 0) return lines.join(";");
		}
	}
	return `${what} → ${status}`;
}

/**
 * 断线的状态码。真 HTTP 状态码从 100 起,`0` 不与任何一个撞 —— 调用方靠它把
 * 「压根没连上」与「服务端返回了错误」分开:后者有服务端那句话可显示,前者没有。
 */
export const OFFLINE_STATUS = 0;

/**
 * 把 `fetch` 的断线包装成 ApiError。
 *
 * `fetch` 只在**连接层**失败时抛 `TypeError`(DNS / 拒连 / 连接被切 / CORS),
 * 拿到响应哪怕是 500 也照样 resolve。所以这里捕到 TypeError 就等价于「这次请求
 * 根本没走完」,而浏览器给的那句 `Failed to fetch` 对用户零信息量。
 *
 * 真实案例:卡片全家福四张卡并发请求,服务端串行渲染,排在后面的超过反代超时被
 * 切断 —— 服务端日志一路「渲染完成」,用户屏幕上却是三块「渲染失败 · Failed to
 * fetch」。两边对不上,谁也查不动。原话保留在括号里,是给排查的人对线索用的。
 *
 * 只包 TypeError:别的错误(代码写错、AbortError 等)原样抛出去,吞掉只会把 bug
 * 伪装成网络问题。
 */
/**
 * 这次失败是不是「等超时了」。`AbortSignal.timeout()` 到点抛的是 name 为
 * `TimeoutError` 的 DOMException;按 name 判而不按类型判,免得换个运行时(测试环境、
 * 桌面壳)构造出来的不是同一个 DOMException 就漏掉。
 */
function isTimeoutError(err: unknown): boolean {
	return err instanceof Error && err.name === "TimeoutError";
}

async function withOffline<T>(what: string, run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (err) {
		if (isTimeoutError(err)) {
			// 与「连接被切」分开说:那边是连接层断了,这边是服务端收下了却迟迟不回应。
			// 两种排查方向完全不同,混成一句话只会把人带偏。
			throw new ApiError(
				OFFLINE_STATUS,
				undefined,
				`等待超时，${what}在死线内没有等到服务器响应 —— 服务端可能仍在渲染,也可能卡住了`,
			);
		}
		if (err instanceof TypeError) {
			throw new ApiError(
				OFFLINE_STATUS,
				undefined,
				`连接中断，${what}没有拿到服务器响应（${err.message}）—— 可能是服务已重启、网络断开，或反向代理把这次请求掐断了`,
			);
		}
		throw err;
	}
}

/**
 * 单次请求的可选项。
 *
 * `timeoutMs` 是**死线**,不是性能调优:预览走客户端串行队列,一个永不落地的请求会
 * 让队尾永远不前进,后面几张卡连请求都发不出去 —— 屏幕上一排转圈,错误文字都没有。
 * 到点 abort 既把那条连接放掉,也让队伍能往前挪。不传 = 不设死线(照旧)。
 */
interface RequestOptions {
	timeoutMs?: number;
}

/**
 * 读 JSON 响应体,并把「读失败」如实带出来。
 *
 * 从前这儿是 `.catch(() => undefined)` 一把吞掉,于是**成功响应**读到一半断了(服务端
 * 被 OOM 杀掉、反代读超时)也会当成「成功,内容是 undefined」返回,调用方再去读它的
 * 字段就炸出一句「Cannot read properties of undefined」—— 正是「服务端日志写着完成、
 * 前端却对不上」那类查不动的场面。
 *
 * 但错误响应上它仍该被容忍:那时已经有状态码可报,状态码比一句解析失败有用得多。
 */
async function readJsonPayload(res: Response): Promise<{ payload: unknown; failed: boolean }> {
	if (!res.headers.get("content-type")?.includes("application/json")) {
		return { payload: undefined, failed: false };
	}
	try {
		return { payload: await res.json(), failed: false };
	} catch {
		return { payload: undefined, failed: true };
	}
}

/** 成功响应却没把 body 读全时的说法 —— 与「连接压根没建起来」分开。 */
function incompleteBodyError(what: string): ApiError {
	return new ApiError(
		OFFLINE_STATUS,
		undefined,
		`响应不完整，${what}的返回内容没有读全 —— 连接多半在传输途中被切断（服务已重启、内存不足被杀,或反向代理读超时）`,
	);
}

async function request<T>(
	method: string,
	path: string,
	body?: unknown,
	opts?: RequestOptions,
): Promise<T> {
	const what = `${method} ${path}`;
	// 组请求的活儿留在包装**外面**:`Headers.set` 与 `JSON.stringify` 都会抛 TypeError,
	// 跑在里头就会被认成断线,把一个前端 bug 说成网络问题(还附赠一句去调反代读超时)。
	const headers = withDesktopTokenHeader(
		body !== undefined ? { "content-type": "application/json" } : undefined,
	);
	const payloadBody = body !== undefined ? JSON.stringify(body) : undefined;
	const res = await withOffline(what, () =>
		fetch(path, {
			method,
			headers,
			body: payloadBody,
			credentials: "include",
			signal: opts?.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
		}),
	);
	const { payload, failed } = await readJsonPayload(res);
	if (!res.ok) {
		if (res.status === 401 && !path.startsWith("/api/session")) {
			onUnauthorized?.();
		}
		throw new ApiError(res.status, payload, errorMessage(payload, what, res.status));
	}
	if (failed) throw incompleteBodyError(what);
	return payload as T;
}

/**
 * Multipart upload(背景图等)。不设 content-type —— 让浏览器自动带上 multipart
 * boundary;其余(desktop token / 凭据 / 错误处理)与 `request` 一致。
 */
async function upload<T>(path: string, form: FormData): Promise<T> {
	const what = `POST ${path}`;
	const headers = withDesktopTokenHeader();
	const res = await withOffline(what, () =>
		fetch(path, { method: "POST", headers, body: form, credentials: "include" }),
	);
	const { payload, failed } = await readJsonPayload(res);
	if (!res.ok) {
		if (res.status === 401 && !path.startsWith("/api/session")) onUnauthorized?.();
		throw new ApiError(res.status, payload, errorMessage(payload, what, res.status));
	}
	if (failed) throw incompleteBodyError(what);
	return payload as T;
}

/**
 * 取二进制资源(背景图缩略图等)。复用同一套 desktop token / 凭据 —— `<img src>` 不会
 * 带自定义 header,桌面壳 token-header 鉴权下直接 401;故由此 fetch 拿 Blob,调用方再
 * `URL.createObjectURL` 喂给 `<img>`。token 留在 header、不进 URL。
 */
async function requestBlob(path: string): Promise<Blob> {
	const res = await withOffline(`GET ${path}`, () =>
		fetch(path, {
			headers: withDesktopTokenHeader(),
			credentials: "include",
		}),
	);
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
	get: <T>(path: string, opts?: RequestOptions) => request<T>("GET", path, undefined, opts),
	post: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
		request<T>("POST", path, body, opts),
	put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
	patch: <T>(path: string, body?: unknown) =>
		request<T>("PATCH", path, body === undefined ? undefined : nullifyUndefined(body)),
	delete: <T>(path: string) => request<T>("DELETE", path),
	upload: <T>(path: string, form: FormData) => upload<T>(path, form),
	blob: (path: string) => requestBlob(path),
};
