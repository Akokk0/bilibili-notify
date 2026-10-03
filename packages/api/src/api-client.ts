import {
	type HttpClient,
	isRedirectStatus,
	urlWithoutQuery,
	type WebSocketLike,
	type WebSocketOptions,
} from "@bilibili-notify/http";

/**
 * B 站请求客户端 —— `@bilibili-notify/http` 的 `HttpClient` 之上的一层薄包。
 *
 * 通用底座对「非 2xx 不抛、回原始字节、失败回结果形状」,而 B 站这一路从 axios 时代起就靠下面
 * 这几条语义跑着,这里原样保住,调用方(BilibiliAPI 与外层 retry)一个字不用改:
 * - **非 2xx 抛错**:等价 axios validateStatus 默认 —— 412 风控页等以异常进入外层 retry,
 *   不会被当成功响应。消息里的 URL 去掉 query(凭据常塞在 query 里,见 {@link urlWithoutQuery})。
 * - **JSON 尝试解析、失败回退原文**:JSON API 得对象,correspond HTML 页得字符串。
 * - **`onBody` 只对 2xx 的体触发**:响应拦截器挂点(-101 auth-lost 探测),非 2xx 先抛了,轮不到它。
 * - **失败一律抛**:`HttpClient` 回的失败结果(超时、连不上)在这里转成 `Error`,进外层 retry。
 * - 重定向最多跟 5 跳,跟满还在跳就抛。
 *
 * 默认头(Origin / Referer / sec-fetch-* 这类 B 站特有的)由调用方在构造 `HttpClient` 时交进去;
 * 这里只持一小份**可热换**的头({@link ApiClient.setHeader},自定义 UA 住这里),叠在它上面。
 */

export interface ApiClientOptions {
	http: HttpClient;
	/** 叠在 `http` 默认头之上的头(自定义 UA 之类);随每个请求外发,{@link ApiClient.setHeader} 可热换。 */
	headers?: Record<string, string>;
	/** 每个 2xx 响应解析后回调(响应拦截器挂点,-101 auth-lost 探测用)。 */
	onBody?: (body: unknown) => void;
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
	private readonly http: HttpClient;
	private readonly headers: Record<string, string>;
	private readonly onBody?: (body: unknown) => void;

	constructor(opts: ApiClientOptions) {
		this.http = opts.http;
		this.headers = { ...opts.headers };
		this.onBody = opts.onBody;
	}

	/** 热替换叠在默认头上的头(setUserAgent 用);已 in-flight 的请求仍走旧值。 */
	setHeader(name: string, value: string): void {
		setHeaderIn(this.headers, name, value);
	}

	/**
	 * 经同一个 `HttpClient`(同一份身份与 cookie 罐)建 WebSocket。握手头由客户端自己装配,
	 * 和 `get` / `postForm` 的头(默认头、这里叠的热换头)无关 —— 那些是 fetch 的头。
	 */
	websocket(url: string, options?: WebSocketOptions): WebSocketLike {
		return this.http.websocket(url, options);
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
		const result = await this.http.fetch(url, {
			headers: this.headers,
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
		const headers = { ...this.headers };
		for (const [name, value] of Object.entries(opts?.headers ?? {})) {
			setHeaderIn(headers, name, value);
		}
		if (contentType) setHeaderIn(headers, "Content-Type", contentType);

		const result = await this.http.fetch(url, {
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
		this.onBody?.(parsed);
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
