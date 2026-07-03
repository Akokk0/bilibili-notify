import type { BiliCookieJar } from "./cookie-jar";

/**
 * fetch 传输层 —— 取代 axios + axios-cookiejar-support。
 *
 * 与 axios 行为对齐的三处关键语义:
 * - **手动跟随重定向**:fetch `redirect:"follow"` 拿不到中间跳的 Set-Cookie,
 *   而登录/刷新链可能在 302 上发 cookie。这里 `redirect:"manual"` 循环跟随,
 *   逐跳把 Set-Cookie 摄入 jar 后再跳(axios-cookiejar-support 同款保证)。
 * - **非 2xx 抛错**:等价 axios validateStatus 默认 —— 412 风控页等以异常
 *   进入外层 retry 退避,不会被当成功响应。
 * - **JSON 尝试解析、失败回退原文**:等价 axios 默认 responseType 行为,
 *   JSON API 得对象、correspond HTML 页得字符串。
 */

export interface BiliHttpClientOptions {
	jar: BiliCookieJar;
	/** 默认请求头(User-Agent / Origin / sec-ch-* 等),随每个请求外发。 */
	headers?: Record<string, string>;
	/**
	 * 单跳超时毫秒。挂起连接(对端不回 / 半开 TCP)超时抛错进外层 retry,
	 * 不卡死刷新链(继承 axios 时代 20s 语义,按跳计)。
	 */
	timeoutMs?: number;
	/** 每个成功响应解析后回调(响应拦截器挂点,-101 auth-lost 探测用)。 */
	onBody?: (body: unknown) => void;
}

interface RequestOptions {
	headers?: Record<string, string>;
}

const MAX_REDIRECTS = 5;

export class BiliHttpClient {
	private readonly jar: BiliCookieJar;
	private readonly defaultHeaders: Record<string, string>;
	private readonly timeoutMs: number;
	private readonly onBody?: (body: unknown) => void;

	constructor(opts: BiliHttpClientOptions) {
		this.jar = opts.jar;
		this.defaultHeaders = { ...opts.headers };
		this.timeoutMs = opts.timeoutMs ?? 20_000;
		this.onBody = opts.onBody;
	}

	/** 热替换默认头(setUserAgent 用);已 in-flight 的请求仍走旧值。 */
	setHeader(name: string, value: string): void {
		// 大小写不敏感去重:同名(如 User-Agent vs user-agent)只留最新值。
		for (const key of Object.keys(this.defaultHeaders)) {
			if (key.toLowerCase() === name.toLowerCase()) delete this.defaultHeaders[key];
		}
		this.defaultHeaders[name] = value;
	}

	async get(url: string, opts?: RequestOptions): Promise<unknown> {
		return this.request("GET", url, undefined, undefined, opts);
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
		let currentUrl = new URL(url);
		let currentMethod = method;
		let currentBody = body;
		let currentContentType = contentType;

		for (let hop = 0; ; hop++) {
			const headers: Record<string, string> = { ...this.defaultHeaders, ...opts?.headers };
			if (currentContentType) headers["Content-Type"] = currentContentType;
			const cookie = this.jar.cookieHeaderFor(currentUrl);
			if (cookie) headers.Cookie = cookie;

			const res = await fetch(currentUrl, {
				method: currentMethod,
				headers,
				body: currentBody,
				redirect: "manual",
				signal: AbortSignal.timeout(this.timeoutMs),
			});

			// 先收本跳 Set-Cookie(重定向响应也可能发 cookie —— 这正是不能用
			// redirect:"follow" 的原因),再决定跟随。
			for (const line of getSetCookieLines(res)) {
				this.jar.setFromSetCookie(line, currentUrl);
			}

			const location = res.headers.get("location");
			if (isRedirect(res.status) && location) {
				// body 已不消费,显式取消避免连接占用。
				await res.body?.cancel();
				if (hop >= MAX_REDIRECTS) {
					throw new Error(`重定向超过 ${MAX_REDIRECTS} 跳: ${url}`);
				}
				currentUrl = new URL(location, currentUrl);
				// 303(以及历史行为下 301/302 的 POST)降级为 GET 且不重发 body;
				// 307/308 保持方法与 body(与 fetch/浏览器语义一致)。
				if (
					res.status === 303 ||
					(currentMethod === "POST" && res.status !== 307 && res.status !== 308)
				) {
					currentMethod = "GET";
					currentBody = undefined;
					currentContentType = undefined;
				}
				continue;
			}

			const text = await res.text();
			if (!res.ok) {
				// 等价 axios validateStatus 默认:非 2xx 一律异常,进外层 retry。
				throw new Error(
					`Request failed with status code ${res.status}: ${currentMethod} ${currentUrl}`,
				);
			}
			const parsed = tryParseJson(text);
			this.onBody?.(parsed);
			return parsed;
		}
	}
}

function isRedirect(status: number): boolean {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** 兼容读取全部 Set-Cookie 行(getSetCookie 需 Node ≥18.14.1;留兜底)。 */
function getSetCookieLines(res: Response): string[] {
	const h = res.headers as Headers & { getSetCookie?: () => string[] };
	if (typeof h.getSetCookie === "function") return h.getSetCookie();
	const single = res.headers.get("set-cookie");
	return single ? [single] : [];
}

/** axios 默认 responseType 等价:能 JSON.parse 就给对象,否则原文字符串。 */
function tryParseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}
