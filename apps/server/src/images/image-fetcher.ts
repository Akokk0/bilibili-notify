import { t as serverText } from "../i18n/index.js";
/**
 * 抓图服务:把远端的图抓进图库 / 把手里的字节存进图库,回引用(ADR-0025 决策 8、10;签名见
 * docs/1.0/subscription-sources.md 的 `IntegrationContext`)。以后绑到每个集成的上下文上当 `ctx.fetchImage` /
 * `ctx.storeImage`;现在是独立的核心服务,一个调用方(一个请求客户端 + 一家图库引用方)建一个。
 *
 * `fetchImage` 走**调用方给的那个请求客户端**(同一套 cookie、身份与默认头),平台要的头(Referer、签名)由调用方
 * 这次传。下面这一层只在抓图上有,客户端别的请求不受它管:
 *
 * - **拦内网**(防 SSRF):地址判定挂在客户端真正建连接用的那一次解析上(`FetchOptions.addressCheck`),重定向的
 *   每一跳、地址里直接写 IP 的都判,没有 DNS 重绑定的窗口。默认 `requirePublicAddress`。
 * - **重定向自己一跳一跳跟**(最多 {@link IMAGE_FETCH_MAX_REDIRECTS} 跳):调用方这次传的头只发给**起点那个源**,
 *   跳到别的源就不带 —— 带着平台的 Referer / 签名去敲别人的门没有道理。客户端自己的默认头、按目标现取的 Cookie 不动。
 * - **cookie 只外发、不摄入**:图床、CDN 回的 `Set-Cookie` 不进集成的罐。
 * - **单张 8MB**(边读边数,读过就掐断)、**按内容嗅探**(对端说它是什么不算数;只认 png / jpeg / webp / gif)、
 *   **单跳超时**(默认 {@link IMAGE_FETCH_TIMEOUT_MS},不另设总时限)。
 *
 * 失败都是结果、不抛(docs/agents/conventions/failure-results.md 规矩 8):
 *
 * | 情况 | 码 |
 * | --- | --- |
 * | 地址不合法、不是 http(s)、内网地址、超 8MB、不是图、401 / 403 / 404 / 410 / 429 以外的 4xx | `invalid` |
 * | 401、403 | `unauthorized` |
 * | 404、410 | `not_found` |
 * | 429 | `rate_limited` |
 * | 超时 | `timeout` |
 * | 连不上、读到一半断、5xx、跟满了还是 3xx、磁盘写失败 | `unavailable` |
 * | 调用方中止 | `indeterminate`(请求客户端回的那个码) |
 *
 * 非 2xx 的一律把状态码写进 `message`;地址只写到路径,不带 query(里头可能是凭据)。
 *
 * 用到守卫那条路的请求客户端攒着自己的连接池:**谁建了交给这里的客户端,谁负责 `dispose()` 它**。
 */

import {
	type FetchOptions,
	type HttpClient,
	isRedirectStatus,
	requirePublicAddress,
	urlWithoutQuery,
} from "@bilibili-notify/http";
import {
	type Failure,
	fail,
	type ImageRef,
	type Result,
	sniffImageFormat,
} from "@bilibili-notify/internal";
import { IMAGE_MAX_BYTES, type ImageWriter } from "./image-store.js";

/** 抓一张图的单跳超时。 */
export const IMAGE_FETCH_TIMEOUT_MS = 15_000;

/** 抓一张图最多跟几跳重定向。 */
export const IMAGE_FETCH_MAX_REDIRECTS = 5;

export interface ImageFetcherDeps {
	/** 调用方的请求客户端:抓图用它的 cookie、身份与默认头。 */
	http: Pick<HttpClient, "fetch">;
	/** 存图的口(调用方登记成图库引用方拿到的那个);抓图服务自己不登记。 */
	images: Pick<ImageWriter, "put">;
	/** 连接之前对要连的地址的检查,默认 `requirePublicAddress`(拦内网)。测试注入放行回环的。 */
	addressCheck?: FetchOptions["addressCheck"];
	/** 单跳超时毫秒,默认 {@link IMAGE_FETCH_TIMEOUT_MS}。 */
	timeoutMs?: number;
}

export interface ImageFetcher {
	/** 抓一张远端的图存进图库,回引用。 */
	fetchImage(
		url: string,
		opts?: { headers?: Record<string, string>; signal?: AbortSignal },
	): Promise<Result<{ ref: ImageRef }>>;
	/** 手里已经是字节的图存进图库,回引用。同一套嗅探与 8MB。 */
	storeImage(
		bytes: Uint8Array,
		opts?: { signal?: AbortSignal },
	): Promise<Result<{ ref: ImageRef }>>;
}

const notAnImage = () => serverText("service.images.image-fetcher.text.1");
const tooLarge = () =>
	serverText("service.images.image-fetcher.text.2", { value0: IMAGE_MAX_BYTES / 1024 / 1024 });

/** 对端回了非 2xx:状态码 → 失败。 */
function statusFailure(status: number, where: string): Failure {
	const message = serverText("service.images.image-fetcher.text.3", {
		value0: status,
		value1: where,
	});
	if (status === 401 || status === 403) return fail("unauthorized", message);
	if (status === 404 || status === 410) return fail("not_found", message);
	if (status === 429) return fail("rate_limited", message);
	if (status >= 400 && status < 500) return fail("invalid", message);
	return fail("unavailable", message);
}

export function createImageFetcher(deps: ImageFetcherDeps): ImageFetcher {
	const addressCheck = deps.addressCheck ?? requirePublicAddress;
	const timeoutMs = deps.timeoutMs ?? IMAGE_FETCH_TIMEOUT_MS;

	return {
		async fetchImage(url, opts = {}) {
			let target: URL;
			try {
				target = new URL(url);
			} catch {
				return fail(
					"invalid",
					serverText("service.images.image-fetcher.text.4", { value0: urlWithoutQuery(url) }),
				);
			}
			const origin = target.origin;

			for (let hop = 0; ; hop++) {
				const response = await deps.http.fetch(target, {
					// 调用方这次传的头只给起点那个源。
					headers: target.origin === origin ? opts.headers : undefined,
					signal: opts.signal,
					timeoutMs,
					// 重定向在这里一跳一跳跟:每一跳要重新决定带不带调用方的头。
					maxRedirects: 0,
					maxBodyBytes: IMAGE_MAX_BYTES,
					addressCheck,
					cookies: "send-only",
				});
				if (!response.ok) return response;

				const location = response.headers.get("location");
				if (isRedirectStatus(response.status) && location !== null) {
					if (hop >= IMAGE_FETCH_MAX_REDIRECTS) {
						return fail(
							"unavailable",
							serverText("service.images.image-fetcher.text.5", {
								value0: IMAGE_FETCH_MAX_REDIRECTS,
								value1: response.status,
								value2: urlWithoutQuery(target),
							}),
						);
					}
					try {
						target = new URL(location, target);
					} catch {
						return fail(
							"unavailable",
							serverText("service.images.image-fetcher.text.6", {
								value0: response.status,
								value1: urlWithoutQuery(target),
							}),
						);
					}
					continue;
				}
				if (!response.isSuccess) return statusFailure(response.status, urlWithoutQuery(target));
				if (!sniffImageFormat(response.body)) {
					return fail("invalid", `${notAnImage()}: ${urlWithoutQuery(target)}`);
				}
				return deps.images.put(response.body);
			}
		},

		async storeImage(bytes, opts = {}) {
			if (opts.signal?.aborted)
				return fail("indeterminate", serverText("service.images.image-fetcher.text.7"));
			if (bytes.byteLength > IMAGE_MAX_BYTES) return fail("invalid", tooLarge());
			if (!sniffImageFormat(bytes)) return fail("invalid", notAnImage());
			return deps.images.put(bytes);
		},
	};
}
