/**
 * 请求客户端对外的接口类型 —— 每个集成(内置的、拓展的)的上下文上 `ctx.http` 是它(ADR-0025 决策 6)。
 *
 * 为什么住核心包:`IntegrationContext` 在这里,它的 `http` 一格要引用这些类型;实现却在 `packages/http`,
 * 而 `packages/http` 已经依赖核心包 —— 类型再放在实现那一头,包之间就成环了。所以**只有类型**
 * 住这里,实现留在 `packages/http`(它 `implements` 这里的 {@link HttpClient},并把这些类型原样转出,
 * 下游的 `import … from "@bilibili-notify/http"` 不用改)。
 *
 * 宿主自己才用得上的口(拦内网的 `addressCheck`、cookie 罐、销毁连接池)不在这里:拓展看不到。
 */

import type { Result } from "./result";

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
	/**
	 * 请求体。只收能原样重发的类型(307 / 308 要重发)。GET / HEAD 不许带。
	 * `FormData` 每一跳由运行时现序列化(boundary 也是运行时补的,别自己写 `Content-Type`);
	 * 但它不能和宿主自用的 `addressCheck` 同用(那条路是 npm `undici`,不认全局的 `FormData`),当场回 `invalid`。
	 */
	body?: string | Uint8Array<ArrayBuffer> | FormData;
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
	 * 「不带浏览器身份、不碰罐」一档:不补身份四件、不带客户端的默认头、不带 `Cookie`、不收 `Set-Cookie`
	 * (重定向的每一跳也一样,`cookies` 选项在这一档下不起作用)。调用方这一次自己写的头照发。
	 * 内置的适配器调官方接口 / 主人填的地址用它:那些对端不该看到 B 站这套浏览器指纹与登录态。
	 */
	bare?: boolean;
	/**
	 * 响应体的字节上限。超了回 `invalid`:带 `Content-Length` 且已经超的不读体;其余边读边数,读过上限当场掐断
	 * (不把超大的体整个读进内存再量)。不给就整个读完。只管最后落脚的那个回应,重定向跳的体本来就不读。
	 */
	maxBodyBytes?: number;
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

/**
 * `websocket()` 交出的连接 —— `ws` 的 WebSocket 的最小子集,不把第三方库的类型摆进对外面。
 *
 * 事件(`open` / `message` / `error` / `close`)用 `on` 订阅,监听器的参数照 `ws` 给:
 * `message` 是 `(data, isBinary)`,`close` 是 `(code, reason)`。**一定要挂 `error`**:
 * 握手期被关(含 `signal` 中止)时 `ws` 会先报一次 `error` 再 `close`,没人接会炸进程。
 */
export interface WebSocketLike {
	/** 二进制帧交给 `message` 监听器的形态;常用 `"nodebuffer"`。 */
	binaryType: string;
	/** 连接状态,取值照 WHATWG:0 建连中 / 1 已连上 / 2 关闭中 / 3 已关。 */
	readonly readyState: number;
	on(event: string, listener: (...args: unknown[]) => void): void;
	/** 字符串发文本帧,字节发二进制帧(`ws` 本来就这么分)。 */
	send(data: string | Uint8Array): void;
	close(): void;
}

export interface WebSocketOptions {
	/**
	 * 附加的握手头。默认头(`Cookie`、`User-Agent`)在前,这里同名(大小写不敏感)的盖过它、
	 * 留在原位置,别的追加在后面。
	 */
	headers?: Record<string, string>;
	/**
	 * 中止就关掉连接(建连时已经中止的,连接一建好就关)。握手期被关会先报一次 `error` 再 `close`。
	 * 集成停下时自动关就靠它(3a 把 `ctx.signal` 接到这里)。
	 */
	signal?: AbortSignal;
	/** 「不带身份、不碰罐」一档:握手不带 `Cookie` 与身份的 `User-Agent`,只有上面的 `headers`。 */
	bare?: boolean;
}

/**
 * 每个集成一个的请求客户端(对外的那一面)。`fetch` 非 2xx 不抛、网络断 / 超时 / 被中止都回结果形状;
 * `websocket` 给错地址回 `invalid`,不抛。
 */
export interface HttpClient {
	fetch(url: string | URL, options?: FetchOptions): Promise<Result<HttpResponse>>;
	/** 用这个客户端的身份与罐子建一条 WebSocket;帧、心跳、重连归调用方。 */
	websocket(url: string | URL, options?: WebSocketOptions): Result<{ socket: WebSocketLike }>;
}
