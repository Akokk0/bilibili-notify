import type { BrowserIdentity } from "@bilibili-notify/http";
import type { ServiceContext } from "@bilibili-notify/internal";
import { Api, type ApiHandlers } from "../../api";
import { ApiClient } from "../../api-client";
import { createBiliHttp } from "../../default-headers";

export interface MakeApiOptions {
	/** 默认是只有静默 logger 的最小桩;要看日志 / `track` 的用例自己给。 */
	serviceCtx?: ServiceContext;
	callbacks?: ApiHandlers;
	/** 已知身份:线上的 UA 与 sec-ch-ua 就是它(默认现生成一份)。 */
	identity?: BrowserIdentity;
}

/**
 * 十来个 `Api` 测试共用的造法:罐子、身份、`HttpClient` 都由这里建好交给 `Api`(与生产同一个
 * `createBiliHttp`),并把它们原样交回 —— 测试要看线上的头、罐子的内容、客户端是不是同一个,
 * 直接用这些,不用去掏 `Api` 的私有字段。
 *
 * `client` 是用**同一个** `HttpClient` 另外包出来的 `ApiClient`(它本来就是薄包),给要直接
 * 打 `get` / `postForm` 看线上请求的用例;它与 `api` 里自己持的那个 `ApiClient` 共用底下的客户端与罐子。
 */
export function makeApi(options: MakeApiOptions = {}) {
	const logger = { info() {}, warn() {}, error() {}, debug() {} };
	const { jar, identity, http } = createBiliHttp(options.identity);
	const api = new Api({
		serviceCtx: options.serviceCtx ?? ({ logger } as never),
		callbacks: options.callbacks ?? {},
		http,
		jar,
	});
	const client = new ApiClient({ http });
	return { api, jar, identity, http, client };
}
