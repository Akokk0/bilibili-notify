import { isRedirectStatus, urlWithoutQuery } from "@bilibili-notify/http";
import type {
	HttpClient,
	Result,
	WebSocketLike,
	WebSocketOptions,
} from "@bilibili-notify/internal";

/**
 * B 站请求客户端 —— `@bilibili-notify/http` 的 `HttpClient` 之上的一层薄包。
 *
 * 通用底座对「非 2xx 不抛、回原始字节、失败回结果形状」,而 B 站这一路从 axios 时代起就靠下面
 * 这几条语义跑着,这里原样保住,调用方(Api 与外层 retry)一个字不用改:
 * - **非 2xx 抛错**:等价 axios validateStatus 默认 —— 412 风控页等以异常进入外层 retry,
 *   不会被当成功响应。消息里的 URL 去掉 query(凭据常塞在 query 里,见 {@link urlWithoutQuery})。
 * - **JSON 尝试解析、失败回退原文**:JSON API 得对象,correspond HTML 页得字符串。
 * - **`onBody` 只对 2xx 的体触发**:响应拦截器挂点(-101 auth-lost 探测),非 2xx 先抛了,轮不到它。
 *   它带着这次请求发出去之前取的登录代(`generation`),迟到的回应由调用方按它认。
 * - **失败一律抛**:`HttpClient` 回的失败结果(超时、连不上)在这里转成 `Error`,进外层 retry。
 * - 重定向最多跟 5 跳,跟满还在跳就抛。
 *
 * 默认头(Origin / Referer / sec-fetch-* 这类 B 站特有的、连同身份的 UA)由调用方在构造 `HttpClient` 时交进去;
 * 这里不再另持一层头 —— 那一层是为热换自定义 UA 留的,自定义 UA 删了它就没有用处(ADR-0025 决策 7)。
 */

export interface ApiClientOptions {
	http: HttpClient;
	/**
	 * 每个 2xx 响应解析后回调(响应拦截器挂点,-101 auth-lost 探测用)。第二个参数是这次请求**发出去之前**
	 * 取的那个记号(没给 `generation` 就是 `undefined`)。
	 */
	onBody?: (body: unknown, generation: number | undefined) => void;
	/**
	 * 「这次请求是对着哪一段登录发的」的取法:每次请求在交给 `HttpClient` **之前**叫一次,回应的体交给 `onBody` 时
	 * 原样带回。必须在发之前取 —— 请求在途时登录可能换了一段,回来再取就认不出这份回应问的是上一段。
	 */
	generation?: () => number;
}

interface RequestOptions {
	headers?: Record<string, string>;
}

const MAX_REDIRECTS = 5;

/** 大小写不敏感地设一个头:同名(如 User-Agent vs user-agent)只留最新值。 */
function setHeaderIn(headers: Record<string, string>, name: string, value: string): void {
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === name.toLowerCase()) delete headers[key];
	}
	headers[name] = value;
}

export class ApiClient {
	private readonly httpClient: HttpClient;
	private readonly onBody?: (body: unknown, generation: number | undefined) => void;
	private readonly generation?: () => number;

	constructor(opts: ApiClientOptions) {
		this.httpClient = opts.http;
		this.onBody = opts.onBody;
		this.generation = opts.generation;
	}

	/**
	 * 同一个 `HttpClient` 的只读窄口:要走 B 站这套 cookie 与身份、又不要这一层「非 2xx 抛错」语义的调用方
	 * (抓图进图库,`createImageFetcher({ http })`)拿它。只开 `fetch`,别的口子不外露。
	 */
	get http(): Pick<HttpClient, "fetch"> {
		return this.httpClient;
	}

	/**
	 * 经同一个 `HttpClient`(同一份身份与 cookie 罐)建 WebSocket。握手头由客户端自己装配,
	 * 和 `get` / `postForm` 的头(默认头、这次请求的头)无关 —— 那些是 fetch 的头。
	 */
	websocket(url: string, options?: WebSocketOptions): Result<{ socket: WebSocketLike }> {
		return this.httpClient.websocket(url, options);
	}

	async get(url: string, opts?: RequestOptions): Promise<unknown> {
		return this.request("GET", url, undefined, undefined, opts);
	}

	/**
	 * 只看**第一跳**的 Location,不跟过去:短链(b23.tv)解析要的是落地地址本身,
	 * 落地页是整张 HTML,跟过去白拿几十 KB。不是重定向就返回 null。
	 * 相对 Location 按当前地址补成绝对地址。只外发 cookie、不摄入那一跳的 Set-Cookie。
	 */
	async redirectLocation(url: string): Promise<string | null> {
		const result = await this.httpClient.fetch(url, {
			maxRedirects: 0,
			cookies: "send-only",
		});
		if (!result.ok) throw new Error(result.message);
		const location = result.headers.get("location");
		if (!isRedirectStatus(result.status) || !location) return null;
		return new URL(location, result.url).toString();
	}

	/** x-www-form-urlencoded POST(bilibili 写接口一律该编码)。 */
	async postForm(
		url: string,
		body: Record<string, string | number | boolean | undefined>,
		opts?: RequestOptions,
	): Promise<unknown> {
		const params = new URLSearchParams();
		for (const [k, v] of Object.entries(body)) {
			if (v !== undefined) params.append(k, String(v));
		}
		return this.request("POST", url, params.toString(), "application/x-www-form-urlencoded", opts);
	}

	private async request(
		method: "GET" | "POST",
		url: string,
		body: string | undefined,
		contentType: string | undefined,
		opts?: RequestOptions,
	): Promise<unknown> {
		const headers: Record<string, string> = {};
		for (const [name, value] of Object.entries(opts?.headers ?? {})) {
			setHeaderIn(headers, name, value);
		}
		if (contentType) setHeaderIn(headers, "Content-Type", contentType);

		// 发之前取记号:`HttpClient` 装 Cookie 头在这之后,所以记着新一段的请求带的一定是新一段的 cookie。
		const generation = this.generation?.();
		const result = await this.httpClient.fetch(url, {
			method,
			headers,
			body,
			maxRedirects: MAX_REDIRECTS,
		});
		if (!result.ok) throw new Error(result.message);

		// 跟满跳数还是 30x:通用客户端把那个 3xx 原样交回来,B 站这一路当失败。
		if (isRedirectStatus(result.status) && result.headers.has("location")) {
			throw new Error(`重定向超过 ${MAX_REDIRECTS} 跳: ${urlWithoutQuery(url)}`);
		}
		const text = result.text();
		if (!result.isSuccess) {
			// 等价 axios validateStatus 默认:非 2xx 一律异常,进外层 retry。
			throw new Error(
				`Request failed with status code ${result.status}: ${method} ${urlWithoutQuery(result.url)}`,
			);
		}
		const parsed = tryParseJson(text);
		this.onBody?.(parsed, generation);
		return parsed;
	}
}

/** axios 默认 responseType 等价:能 JSON.parse 就给对象,否则原文字符串。 */
function tryParseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}
