import { i18n } from "../i18n";
/**
 * Thin fetch wrapper for /api/* endpoints. Vite dev server proxies these to
 * the Hono server (see vite.config.ts). In production the dashboard
 * is served from the same origin, so relative paths just work.
 */

import type { ExtensionSettingsIssue, FailureCode } from "@bilibili-notify/contract";
import { FAILURE_CODES } from "@bilibili-notify/internal/result";
import { withDesktopTokenHeader } from "./desktop-token";

/**
 * 一条逐格原因:标准的 `Issue` 加一格 `op`(只有拓展设置那处带,第几步惹出来的,ADR-0026 决策 6)。
 * 形状的正本是契约的 {@link ExtensionSettingsIssue}。
 */
export type ApiIssue = ExtensionSettingsIssue;

/**
 * 非 2xx 的错误响应,**只在这里解析一次**(ADR-0026 决策 6):界面读 `code` + `message`,逐格标红读
 * `issues`,分情况只按 `code` 判,不再按状态码或机器串换文案。`body` 留着原始响应体 ——
 * 给 `upstreamCode` 这类 ApiError 不另开一格的附加。
 *
 * 构造时从 `body` 里读出 `code` / `issues`,所以自己 `new ApiError(status, body, message)` 的
 * 出口(聊天、皮肤流)也拿得到,不必各写一遍。
 */
export class ApiError extends Error {
	/** 标准码。响应体是 `{ code, message }` 才有;断线(`status` 为 0)与认不出的体都没有。 */
	readonly code?: FailureCode;
	/** 逐条原因,即响应体的 `issues`。 */
	readonly issues?: ApiIssue[];

	constructor(
		public readonly status: number,
		public readonly body: unknown,
		message: string,
		/** 解析好的错误体。缺省就地解析;`apiErrorOf` 已经解析过一次,直接递进来免得再读。 */
		parsed: ParsedErrorBody = readErrorBody(body),
	) {
		super(message);
		this.name = "ApiError";
		if (parsed.code !== undefined) this.code = parsed.code;
		if (parsed.issues !== undefined) this.issues = parsed.issues;
	}
}

interface ParsedErrorBody {
	code?: FailureCode;
	message?: string;
	issues?: ApiIssue[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 一段非空文字。 */
function textOf(v: unknown): string | undefined {
	return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

/** 一条 issue 的形状整理:路径只留 string / number 段,缺话给兜底句,`op` 有才带。 */
function issueOf(raw: unknown): ApiIssue {
	const bag = isRecord(raw) ? raw : {};
	const issue: ApiIssue = {
		message: typeof bag.message === "string" ? bag.message : i18n.t("panelUi.services.api.1"),
	};
	if (Array.isArray(bag.path)) {
		const path = bag.path.filter(
			(segment): segment is string | number =>
				typeof segment === "string" || typeof segment === "number",
		);
		if (path.length > 0) issue.path = path;
	}
	if (typeof bag.op === "number") issue.op = bag.op;
	return issue;
}

/**
 * 错误体只认一种形状:平铺的 `{ code, message, issues? }`(服务端一律经 `respondFailure` 回)。
 * `code` 得在码表里 —— 不在的不冒充标准码;认不出的体交空,调用方拿兜底那句。
 */
function readErrorBody(payload: unknown): ParsedErrorBody {
	if (!isRecord(payload)) return {};
	const { code } = payload;
	const message = textOf(payload.message);
	if (typeof code !== "string" || !Object.hasOwn(FAILURE_CODES, code) || message === undefined) {
		return {};
	}
	const parsed: ParsedErrorBody = { code: code as FailureCode, message };
	if (Array.isArray(payload.issues)) parsed.issues = payload.issues.map(issueOf);
	return parsed;
}

/**
 * 非 2xx 响应体 → `ApiError`。`fallback` 是体里读不出话来时的那一句。
 * 不走 `api` 的 fetch 出口(登录、下载、聊天上传)也经它,解析只此一处。
 */
export function apiErrorOf(status: number, payload: unknown, fallback: string): ApiError {
	const parsed = readErrorBody(payload);
	return new ApiError(status, payload, parsed.message ?? fallback, parsed);
}

/**
 * 逐条原因:响应体的 `issues`(构造时读好了)。
 * 不是 `ApiError`、或这次失败没带逐条原因的交 `null` —— 那种失败的原话(`message`)就是该说的。
 */
export function issuesOf(err: unknown): ApiIssue[] | null {
	return err instanceof ApiError && err.issues !== undefined ? err.issues : null;
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
				i18n.t("panelUi.services.api.2", { value0: what }),
			);
		}
		if (err instanceof TypeError) {
			throw new ApiError(
				OFFLINE_STATUS,
				undefined,
				i18n.t("panelUi.services.api.3", { value0: what, value1: err.message }),
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
		i18n.t("panelUi.services.api.4", { value0: what }),
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
		throw apiErrorOf(res.status, payload, `${what} → ${res.status}`);
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
		throw apiErrorOf(res.status, payload, `${what} → ${res.status}`);
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
		const { payload } = await readJsonPayload(res);
		throw apiErrorOf(res.status, payload, `GET ${path} → ${res.status}`);
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
