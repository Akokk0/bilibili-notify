import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { type Failure, fail, ok, type Result } from "@bilibili-notify/internal/constants";
import { Agent, buildConnector, Headers as UndiciHeaders, fetch as undiciFetch } from "undici";
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
 *
 * **两条发请求的路。** 平常的请求走 Node 自带的 `fetch`。给了 {@link FetchOptions.addressCheck} 的请求(抓图那一层
 * 拦内网用)走 npm `undici` 的 `fetch` + 这个客户端自己的守卫连接池:要把地址判定挂在**真正建连接用的那一次解析**上,
 * 只有自定义连接函数做得到,而 Node 自带的 `fetch` 不收 npm `undici` 的连接池(两边版本不同,当场报
 * `invalid onRequestStart method`)。两条路的头装配、cookie、重定向、超时、失败码是同一份代码;不给 `addressCheck`
 * 的请求线上一个字节不变。用过守卫那条路的客户端要 {@link HttpClient.dispose}。
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
	/**
	 * 名字 → 地址(IP 字面量)的解析函数,只有带 {@link FetchOptions.addressCheck} 的请求用它(那条路自己解析,
	 * 好在连接之前判地址)。默认是系统解析(`dns.lookup`,全部地址)。测试注入一张表。
	 */
	lookup?: (hostname: string) => Promise<readonly string[]>;
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
	/**
	 * 响应体的字节上限。超了回 `invalid`:带 `Content-Length` 且已经超的不读体;其余边读边数,读过上限当场掐断
	 * (不把超大的体整个读进内存再量)。不给就整个读完。只管最后落脚的那个回应,重定向跳的体本来就不读。
	 */
	maxBodyBytes?: number;
	/**
	 * 连接之前对**要连的那个地址**(IP 字面量)的检查,回失败就不连、`fetch` 回 `invalid`(消息带着那个地址)。
	 * 判的是真正建连接用的那一次解析:名字解析出来的每个地址都判,任何一个不过整个拒;地址里直接写 IP 的不经解析
	 * 当场判;重定向的每一跳、每一条新连接都判。生产用 `requirePublicAddress`(拦内网,防 SSRF)。
	 * 不给就不判,请求走平常那条路。
	 */
	addressCheck?: (address: string) => Result;
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

/** 单跳的中止信号:调用方的 signal 与本跳的超时合成一个,并记下是不是超时掐的(回 `timeout` 还是「被中止」靠它分)。 */
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

/** 守卫连接函数拒连时抛的错:带着要回给调用方的那个失败,穿过 `fetch failed` 的外壳后由 {@link addressRejection} 认出来。 */
class AddressRejectedError extends Error {
	constructor(readonly failure: Failure) {
		super(failure.message);
		this.name = "AddressRejectedError";
	}
}

/** `fetch` 抛出来的错里(顺着 `cause` 找)有没有守卫连接函数的拒连;有就是要回的失败。 */
function addressRejection(err: unknown): Failure | undefined {
	for (let at = err, depth = 0; at instanceof Error && depth < 5; at = at.cause, depth++) {
		if (at instanceof AddressRejectedError) return at.failure;
	}
	return undefined;
}

async function systemLookup(hostname: string): Promise<string[]> {
	return (await dnsLookup(hostname, { all: true })).map((entry) => entry.address);
}

/**
 * 守卫连接函数:每条新连接在这里解析、判地址,再连**判过的那个地址** —— 检查与连接是同一次解析。
 * 连接池里复用的连接都是这样建出来的,所以复用不用再判。
 *
 * - 主机是 IP 字面量:不解析,当场判(`net.connect` 遇到字面量根本不调 `lookup`,所以判定不能只挂在解析上)。
 * - 主机是名字:解析出全部地址,**每一个**都判,任何一个不过整个拒(公网与内网混着回的名字不可信);
 *   都过了连 IPv4 的第一个(没有 IPv4 就连第一个)。
 * - TLS 的 SNI 与证书校验仍按原来的主机名(`servername`),不是按连过去的 IP。
 */
function guardedConnector(
	lookup: (hostname: string) => Promise<readonly string[]>,
	check: (address: string) => Result,
): buildConnector.connector {
	const connect = buildConnector({});
	const pick = async (hostname: string): Promise<string> => {
		const host = hostname.replace(/^\[|\]$/g, "");
		const literal = isIP(host) !== 0;
		const addresses = literal ? [host] : await lookup(host);
		if (addresses.length === 0) throw new Error(`名字没有解析出地址: ${host}`);
		for (const address of addresses) {
			const verdict = check(address);
			if (verdict.ok) continue;
			const where = literal ? address : `${host} 解析到 ${address}`;
			throw new AddressRejectedError(
				fail("invalid", `不许连这个地址(${where}): ${verdict.message}`),
			);
		}
		return addresses.find((address) => isIP(address) === 4) ?? (addresses[0] as string);
	};
	return (options, callback) => {
		pick(options.hostname).then(
			(address) => connect({ ...options, hostname: address }, callback),
			(err) => callback(err instanceof Error ? err : new Error(String(err)), null),
		);
	};
}

/** 回应头搬进全局的 `Headers`(npm `undici` 的 `Headers` 不是它的实例,调用方只认全局那个)。 */
function toGlobalHeaders(from: UndiciHeaders): Headers {
	const headers = new Headers();
	for (const [name, value] of from) headers.append(name, value);
	return headers;
}

/** 两条路的回应共有的那几样(Node 自带的 `Response` 与 npm `undici` 的都有)。 */
interface WireBody {
	headers: { get(name: string): string | null };
	body: { getReader(): ReadableStreamDefaultReader<Uint8Array>; cancel(): Promise<void> } | null;
	arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * 读响应体。给了上限就边读边数:`Content-Length` 已经超的不读,读过上限当场 cancel(连接随之断开)——
 * 不能「先收完再量」,那等于把内存用量交给对端决定。超了回 `null`。
 */
async function readBody(res: WireBody, maxBytes: number | undefined): Promise<Uint8Array | null> {
	if (maxBytes === undefined) return new Uint8Array(await res.arrayBuffer());
	const declared = Number(res.headers.get("content-length") ?? Number.NaN);
	const reader = res.body?.getReader();
	if (!reader) {
		const buffered = new Uint8Array(await res.arrayBuffer());
		return buffered.byteLength > maxBytes ? null : buffered;
	}
	if (Number.isFinite(declared) && declared > maxBytes) {
		await reader.cancel();
		return null;
	}
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
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
	private readonly lookup: (hostname: string) => Promise<readonly string[]>;
	/** 守卫那条路的连接池,一种判定一个(判定写死在连接函数里);用到才建。 */
	private readonly guardedAgents = new Map<(address: string) => Result, Agent>();

	constructor(opts: HttpClientOptions) {
		this.jar = opts.jar;
		this.identity = opts.identity;
		this.defaultHeaders = { ...opts.headers };
		this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.lookup = opts.lookup ?? systemLookup;
	}

	/**
	 * 关掉守卫那条路攒下的连接(在途的请求随之失败)。平常那条路用的是 Node 全局的连接池,不归这里管。
	 * 发过带 `addressCheck` 的请求的客户端,用完要调;没发过的调了也无妨。
	 */
	async dispose(): Promise<void> {
		const agents = [...this.guardedAgents.values()];
		this.guardedAgents.clear();
		await Promise.all(agents.map((agent) => agent.destroy()));
	}

	private guardedAgent(check: (address: string) => Result): Agent {
		let agent = this.guardedAgents.get(check);
		if (!agent) {
			agent = new Agent({ connect: guardedConnector(this.lookup, check) });
			this.guardedAgents.set(check, agent);
		}
		return agent;
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

			// 守卫那条路的头装进 npm `undici` 自己的 `Headers`:把全局的 `Headers` 交给它,线上会被改成小写并按字母重排。
			const check = options.addressCheck;
			let headers: Headers | UndiciHeaders;
			try {
				headers = this.requestHeaders(
					check ? new UndiciHeaders() : new Headers(),
					options.headers,
					target,
					bodyless,
				);
			} catch (err) {
				return fail("invalid", `请求头不合法: ${describeError(err)}`);
			}

			const attempt = startHopSignal(options.signal, timeoutMs);
			let leg: Leg;
			try {
				const res = check
					? await undiciFetch(target, {
							method: currentMethod,
							headers: headers as UndiciHeaders,
							body: currentBody,
							redirect: "manual",
							signal: attempt.signal,
							dispatcher: this.guardedAgent(check),
						})
					: await globalThis.fetch(target, {
							method: currentMethod,
							headers: headers as Headers,
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
					const body = await readBody(res, options.maxBodyBytes);
					if (body === null) {
						return fail(
							"invalid",
							`响应体超过 ${options.maxBodyBytes} 字节: ${urlWithoutQuery(target)}`,
						);
					}
					leg = {
						following: false,
						status: res.status,
						headers:
							res.headers instanceof UndiciHeaders ? toGlobalHeaders(res.headers) : res.headers,
						body,
						setCookies,
					};
				}
			} catch (err) {
				// 守卫连接函数拒连:带着地址的那个失败原样回。
				const rejected = addressRejection(err);
				if (rejected) return rejected;
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
	private requestHeaders<H extends Pick<Headers, "set" | "has" | "delete">>(
		headers: H,
		extra: Headers | Record<string, string> | undefined,
		target: URL,
		bodyless: boolean,
	): H {
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
