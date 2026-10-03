import { type Failure, fail, ok, type Result } from "@bilibili-notify/internal/constants";
import type { BrowserIdentity } from "./browser-identity";
import type { CookieJar } from "./cookie-jar";
import {
	connectWebSocket,
	cookieLookupUrl,
	type WebSocketLike,
	type WebSocketOptions,
} from "./websocket";

/**
 * fetch 传输层 —— 通用底座,不带任何平台的默认值(Origin / Referer / sec-fetch-* 这类归调用方)。
 * 每个集成一个客户端,身份与 cookie 罐都是它自己的。
 *
 * 与直接用全局 `fetch` 的区别:
 * - **手动跟随重定向**:`redirect:"follow"` 拿不到中间跳的 Set-Cookie,而登录 / 刷新链可能在
 *   302 上发 cookie。这里 `redirect:"manual"` 循环跟随,逐跳把 Set-Cookie 摄入罐子后再跳。
 *   每一跳之前调 {@link FetchOptions.beforeHop},调用方可以否决。
 * - **非 2xx 不抛**:状态码交给调用方判。网络断、超时、被中止、被否决都回结果形状
 *   (码见 docs/agents/conventions/failure-results.md),抛错只留给 bug。
 * - **只回原始字节**:要文本或 JSON 时现转,不替调用方猜编码、不替它「失败回退原文」。
 * - 超时按跳算(挂起的连接、半开 TCP 不会卡死调用方),并且管到 body 读完。
 */

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_REDIRECTS = 5;

export interface HttpClientOptions {
	/** 这个客户端的 cookie 罐:每个请求从里面取 Cookie,每跳响应的 Set-Cookie 摄进去。 */
	jar: CookieJar;
	/** 现成的浏览器身份(UA 与 sec-ch-ua 那一套)。本包只用它,不生成、不存。 */
	identity: BrowserIdentity;
	/**
	 * 调用方的默认请求头,随每个请求外发,盖过身份的同名头(大小写不敏感)。
	 * 本包自己不带任何平台的默认头。线上头序按交进来的顺序排,身份那四个头调用方没写的才补、
	 * 排在后面 —— 要掌控头序(指纹对齐)的调用方把它们自己写在想要的位置上。
	 */
	headers?: Record<string, string>;
	/** 单跳超时毫秒,默认 20 秒。 */
	timeoutMs?: number;
}

/** 即将发出的一跳(含第一次请求)。 */
export interface Hop {
	/** 这一跳要去的地址。 */
	url: URL;
	/** 第几跳:第一次请求是 0,之后每跟一次重定向加 1。 */
	index: number;
	/** 上一跳的地址与它回的状态码(重定向要去的就是 `url`);第 0 跳没有。 */
	from?: { url: URL; status: number };
}

/**
 * 每一跳发出之前调(第一次请求也算),回 `ok()` 放行,回失败就否决:`fetch` 把这个失败原样
 * 回给调用方、这一跳不发。前一跳的 Set-Cookie 此时已经摄进罐子。可以是异步的。
 */
export type HopHandler = (hop: Hop) => Result | Promise<Result>;

export interface FetchOptions {
	/** 默认 GET。 */
	method?: string;
	/** 这一次请求的头,盖过客户端默认头与身份(大小写不敏感)。 */
	headers?: Headers | Record<string, string>;
	/** 请求体。只收能原样重发的类型(307 / 308 要重发)。GET / HEAD 不许带。 */
	body?: string | Uint8Array<ArrayBuffer>;
	/** 调用方的中止信号。 */
	signal?: AbortSignal;
	/** 这一次请求的单跳超时毫秒,默认取客户端的。 */
	timeoutMs?: number;
	/**
	 * 最多跟几跳重定向,默认 5。`0` 就是不跟。跟满了遇到的下一个 3xx 不当失败,原样回给调用方
	 * (状态码 3xx、带 Location 头),由调用方判 —— 所以 `maxRedirects: 0` 就是「只看第一跳的 Location」。
	 */
	maxRedirects?: number;
	/** 每一跳发出之前的检查,可否决。 */
	beforeHop?: HopHandler;
	/**
	 * `"exchange"`(默认)外发罐子的 cookie、也把响应的 Set-Cookie 摄进罐子;
	 * `"send-only"` 只外发、不摄入(罐子里的东西这个请求只读)。
	 */
	cookies?: "exchange" | "send-only";
}

/**
 * 一次请求的回应。成功那一支的内容铺平在 `ok` 旁边(`Result<HttpResponse>`),所以这里**没有**
 * `ok` 这一格:先看 `result.ok`(请求有没有走通),再看 `status`(对端怎么说)。
 */
export interface HttpResponse {
	/** 最后落脚的地址(跟过重定向之后)。 */
	url: string;
	status: number;
	headers: Headers;
	/** 原始字节。 */
	body: Uint8Array;
	/** 状态码是不是 2xx。 */
	isSuccess: boolean;
	/** 按 UTF-8 转文本(去掉 BOM)。 */
	text(): string;
	/** 按 JSON 解析:不是合法 JSON 回 `invalid`(对端回了别的东西不是 bug,不抛)。 */
	json(): Result<{ value: unknown }>;
}

const utf8 = new TextDecoder();

function createResponse(
	url: string,
	status: number,
	headers: Headers,
	body: Uint8Array,
): HttpResponse {
	return {
		url,
		status,
		headers,
		body,
		isSuccess: status >= 200 && status < 300,
		text: () => utf8.decode(body),
		json: () => {
			try {
				return ok({ value: JSON.parse(utf8.decode(body)) as unknown });
			} catch {
				return fail("invalid", "响应不是合法的 JSON");
			}
		},
	};
}

export function isRedirectStatus(status: number): boolean {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * 用于错误消息 / 日志的 URL —— **只保留 origin+pathname,剥掉 query**。
 *
 * 不少接口把凭据塞进 query(csrf、qrcode_key、token)。失败消息会经调用方的重试与 catch
 * 落进日志,原样带 query 等于把凭据明文写进日志,用户报 bug 贴日志时泄漏。路径本身足够
 * 定位失败端点,query 值对排障无用。
 */
export function urlWithoutQuery(u: string | URL): string {
	try {
		const parsed = typeof u === "string" ? new URL(u) : u;
		return `${parsed.origin}${parsed.pathname}`;
	} catch {
		// 相对 / 不可解析:退回按 `?` 截断,至少不带 query。
		return String(u).split("?")[0] ?? String(u);
	}
}

function entriesOf(init: Headers | Record<string, string> | undefined): [string, string][] {
	if (init === undefined) return [];
	return init instanceof Headers ? [...init.entries()] : Object.entries(init);
}

function describeError(err: unknown): string {
	if (!(err instanceof Error)) return String(err);
	const cause = err.cause;
	if (!(cause instanceof Error)) return err.message;
	const code = (cause as { code?: unknown }).code;
	const detail =
		typeof code === "string" && !cause.message.includes(code)
			? `${code} ${cause.message}`.trim()
			: cause.message;
	return detail ? `${err.message}: ${detail}` : err.message;
}

/** 调用方的 signal 已中止:`TimeoutError` 算超时,其余(停用 / 收摊)算被中止。 */
function abortFailure(signal: AbortSignal, target: URL): Failure {
	const where = urlWithoutQuery(target);
	const name = (signal.reason as { name?: unknown } | undefined)?.name;
	return name === "TimeoutError"
		? fail("timeout", `请求超时被中止: ${where}`)
		: fail("indeterminate", `请求被中止: ${where}`);
}

/** 单跳的中止信号:调用方的 signal 与本跳的超时合成一个(不用 AbortSignal.any:要兼容 Node 20.0)。 */
function startHopSignal(parent: AbortSignal | undefined, timeoutMs: number) {
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort(new DOMException("请求超时", "TimeoutError"));
	}, timeoutMs);
	const onParentAbort = () => controller.abort(parent?.reason);
	parent?.addEventListener("abort", onParentAbort, { once: true });
	if (parent?.aborted) onParentAbort();
	return {
		signal: controller.signal,
		timedOut: () => timedOut,
		dispose: () => {
			clearTimeout(timer);
			parent?.removeEventListener("abort", onParentAbort);
		},
	};
}

/** 一跳走完的样子:要么继续跟下一跳,要么就是最终回应。 */
type Leg =
	| { following: true; status: number; location: string; setCookies: string[] }
	| {
			following: false;
			status: number;
			headers: Headers;
			body: Uint8Array;
			setCookies: string[];
	  };

export class HttpClient {
	private readonly jar: CookieJar;
	private readonly identity: BrowserIdentity;
	private readonly defaultHeaders: Record<string, string>;
	private readonly timeoutMs: number;

	constructor(opts: HttpClientOptions) {
		this.jar = opts.jar;
		this.identity = opts.identity;
		this.defaultHeaders = { ...opts.headers };
		this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	async fetch(url: string | URL, options: FetchOptions = {}): Promise<Result<HttpResponse>> {
		const method = (options.method ?? "GET").toUpperCase();
		if (options.body !== undefined && (method === "GET" || method === "HEAD")) {
			return fail("invalid", `${method} 请求不能带 body`);
		}
		let target: URL;
		try {
			target = new URL(url);
		} catch {
			return fail("invalid", `不是合法的地址: ${urlWithoutQuery(String(url))}`);
		}

		const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
		const timeoutMs = options.timeoutMs ?? this.timeoutMs;
		const exchangeCookies = (options.cookies ?? "exchange") === "exchange";
		// 请求发出时记下罐子换过几次:回来时对不上,这份响应属于上一个会话,Set-Cookie 不收。
		const epoch = this.jar.epoch;

		let currentMethod = method;
		let currentBody = options.body;
		let bodyless = false;
		let from: Hop["from"];

		for (let index = 0; ; index++) {
			if (target.protocol !== "http:" && target.protocol !== "https:") {
				return fail("invalid", `只支持 http / https: ${urlWithoutQuery(target)}`);
			}
			if (options.signal?.aborted) return abortFailure(options.signal, target);

			const verdict = await options.beforeHop?.({ url: target, index, from });
			if (verdict && !verdict.ok) return verdict;

			let headers: Headers;
			try {
				headers = this.requestHeaders(options.headers, target, bodyless);
			} catch (err) {
				return fail("invalid", `请求头不合法: ${describeError(err)}`);
			}

			const attempt = startHopSignal(options.signal, timeoutMs);
			let leg: Leg;
			try {
				const res = await globalThis.fetch(target, {
					method: currentMethod,
					headers,
					body: currentBody,
					redirect: "manual",
					signal: attempt.signal,
				});
				const setCookies = res.headers.getSetCookie();
				const location = res.headers.get("location");
				if (isRedirectStatus(res.status) && location !== null && index < maxRedirects) {
					// body 已不消费,显式取消避免连接占用。
					await res.body?.cancel();
					leg = { following: true, status: res.status, location, setCookies };
				} else {
					leg = {
						following: false,
						status: res.status,
						headers: res.headers,
						body: new Uint8Array(await res.arrayBuffer()),
						setCookies,
					};
				}
			} catch (err) {
				// 这一小段里只有网络栈:连不上、读到一半断线、被超时或调用方中止。
				if (attempt.timedOut()) {
					return fail("timeout", `请求超过 ${timeoutMs / 1000} 秒没回: ${urlWithoutQuery(target)}`);
				}
				if (options.signal?.aborted) return abortFailure(options.signal, target);
				return fail("unavailable", `请求失败: ${urlWithoutQuery(target)} (${describeError(err)})`);
			} finally {
				attempt.dispose();
			}

			// 先收本跳 Set-Cookie(重定向响应也可能发 cookie —— 这正是不能用 redirect:"follow" 的原因),
			// 再决定跟随。
			if (exchangeCookies && this.jar.epoch === epoch) {
				for (const line of leg.setCookies) this.jar.setFromSetCookie(line, target);
			}

			if (!leg.following) {
				return ok(createResponse(target.href, leg.status, leg.headers, leg.body));
			}

			let next: URL;
			try {
				next = new URL(leg.location, target);
			} catch {
				return fail("unavailable", `对端给了不合法的重定向地址: ${urlWithoutQuery(target)}`);
			}
			// 303(以及 301/302 上的 POST)降级为 GET 且不重发 body;307/308 保持方法与 body
			// (与 fetch / 浏览器语义一致)。body 没了,描述它的头也要剥掉。
			if (
				(leg.status === 303 && currentMethod !== "GET" && currentMethod !== "HEAD") ||
				(currentMethod === "POST" && leg.status !== 307 && leg.status !== 308)
			) {
				currentMethod = "GET";
				currentBody = undefined;
				bodyless = true;
			}
			from = { url: target, status: leg.status };
			target = next;
		}
	}

	/**
	 * 用这个客户端的身份与罐子建一条 WebSocket。帧、心跳、重连归调用方,这里只管握手和 `signal`。
	 *
	 * 握手头是**自己的一套**,不走 fetch 的头装配:`Cookie`(罐子里有这个地址该带的才带)在前,
	 * 然后 `User-Agent`(身份的),再然后是 `options.headers`(同名的盖过默认值、留在原位置)。
	 * 不带 `sec-ch-ua*` / `Origin`,也不带构造客户端时交进来的默认头 —— 那些是 fetch 的头。
	 * 头序与切过来之前裸 `ws` 建连时一致(头序也是指纹)。
	 *
	 * 地址不合法、协议 `ws` 不收(如 `ftp:`)时同步抛错,和 `new WebSocket` 一样(给错地址是 bug)。
	 */
	websocket(url: string | URL, options: WebSocketOptions = {}): WebSocketLike {
		const target = new URL(url);
		const handshake: [string, string][] = [];
		const cookie = this.jar.cookieHeaderFor(cookieLookupUrl(target));
		if (cookie) handshake.push(["Cookie", cookie]);
		handshake.push(["User-Agent", this.identity.userAgent]);
		for (const [name, value] of Object.entries(options.headers ?? {})) {
			const at = handshake.findIndex(([known]) => known.toLowerCase() === name.toLowerCase());
			if (at >= 0) handshake[at] = [name, value];
			else handshake.push([name, value]);
		}
		return connectWebSocket(target, Object.fromEntries(handshake), options.signal);
	}

	/**
	 * 一跳的请求头:身份 < 客户端默认头 < 这次请求的头;最后才是罐子的 Cookie。
	 * 线上头序:默认头、这次请求的头(同名的留在先出现的位置),然后是身份里调用方没写的,最后 Cookie。
	 */
	private requestHeaders(
		extra: Headers | Record<string, string> | undefined,
		target: URL,
		bodyless: boolean,
	): Headers {
		const headers = new Headers();
		for (const [name, value] of Object.entries(this.defaultHeaders)) headers.set(name, value);
		for (const [name, value] of entriesOf(extra)) headers.set(name, value);
		const { identity } = this;
		const identityHeaders: [string, string][] = [
			["User-Agent", identity.userAgent],
			["sec-ch-ua", identity.secChUa],
			["sec-ch-ua-mobile", identity.secChUaMobile],
			["sec-ch-ua-platform", identity.secChUaPlatform],
		];
		for (const [name, value] of identityHeaders) {
			if (!headers.has(name)) headers.set(name, value);
		}
		if (bodyless) headers.delete("content-type");
		const cookie = this.jar.cookieHeaderFor(target);
		if (cookie) headers.set("Cookie", cookie);
		return headers;
	}
}
