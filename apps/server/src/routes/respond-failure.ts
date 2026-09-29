import type { ErrorResponse } from "@bilibili-notify/contract";
import { type Failure, type FailureCode, fail } from "@bilibili-notify/internal";
import type { Context } from "hono";
import type { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * 失败的出口(ADR-0026 决策 6):HTTP 非 2xx 的错误体一律经 {@link respondFailure} 回,
 * 状态码从 `code` 推。规矩见 docs/agents/conventions/failure-results.md 规矩 7。
 * 守卫「错误体」(scripts/error-body-guard.mjs)在每条服务端测试收尾对一遍回出去的体。
 */

/**
 * 标准码 → HTTP 状态码。用穷举的 `satisfies`:码表加一个码而这里漏了,类型当场报错。
 *
 * `unauthorized` 是 403 而不是 401:面板见 401 就把人踢回登录框,那只该是**看板自己**的登录失效;
 * 来源、平台的凭据失效(比如 B 站没登录)是一次操作失败了,回 403。看板鉴权那几处显式传 401。
 *
 * `not_configured` 是 409:请求本身没错,是当前的配置不满足;503 带着「稍后再来」的意思,不对。
 *
 * `unavailable` 是 503 而不是 500:全局出错处理把「抛出来的」都按它回,而抛错只留给 bug ——
 * 对客户端来说都是「服务这一下没成、稍后可以再来」。`indeterminate` 用 502:对端给了个说不清的结果。
 */
const STATUS_OF_CODE = {
	not_found: 404,
	invalid: 400,
	unauthorized: 403,
	rate_limited: 429,
	unavailable: 503,
	not_configured: 409,
	timeout: 504,
	unsupported: 400,
	conflict: 409,
	indeterminate: 502,
	unknown: 500,
} as const satisfies Record<FailureCode, ContentfulStatusCode>;

export function statusOf(code: FailureCode): ContentfulStatusCode {
	return STATUS_OF_CODE[code];
}

/**
 * 回一份错误体。`status` 缺省从 `code` 推,调用方可以指定(如超上限的 413)。
 *
 * 体是 {@link ErrorResponse}:去掉 `ok`;附加只有 `issues` 与 `upstreamCode`,没有的不出现。
 * 逐个字段挑而不是展开 `failure` —— 清单是封闭的,类型之外混进来的字段不往外甩。
 */
export function respondFailure(
	c: Context,
	failure: Failure,
	status: ContentfulStatusCode = statusOf(failure.code),
): Response {
	const body: ErrorResponse = { code: failure.code, message: failure.message };
	if (failure.issues !== undefined) body.issues = failure.issues;
	if (failure.upstreamCode !== undefined) body.upstreamCode = failure.upstreamCode;
	return c.json(body, status);
}

/** 全局出错处理回给客户端的那一句:原话只进日志,不外泄。 */
export const UNHANDLED_ERROR_MESSAGE = "服务端出错了，详情在日志里";

/** `notFound` 回的那一句。 */
export const ROUTE_NOT_FOUND_MESSAGE = "没有这个接口";

/** HTTP 状态码 → 标准码。只给全局出错处理里的 `HTTPException` 用。 */
function codeOfHttpStatus(status: number): FailureCode {
	if (status === 401) return "unauthorized";
	if (status === 404) return "not_found";
	if (status === 409) return "conflict";
	if (status === 429) return "rate_limited";
	if (status >= 500) return "unavailable";
	return "invalid";
}

/** `HTTPException` 自己没带话时的中文兜底。 */
const DEFAULT_MESSAGE_OF_CODE: Partial<Record<FailureCode, string>> = {
	unauthorized: "没登录，或登录已失效",
	not_found: "没有找到要的东西",
	conflict: "与当前状态冲突",
	rate_limited: "请求太频繁，请稍后再试",
	unavailable: UNHANDLED_ERROR_MESSAGE,
};

/**
 * Hono 的 `HTTPException`(中间件或路由主动抛的)翻成失败:按它的状态码挑码,状态码照原样,
 * message 用它自己的,空的话给一句中文。它带的自定义 `res`(如 WWW-Authenticate 头)不转 ——
 * 服务端现在没有谁抛带 `res` 的。
 */
export function failureOfHttpException(err: HTTPException): {
	failure: Failure;
	status: ContentfulStatusCode;
} {
	const code = codeOfHttpStatus(err.status);
	const message =
		err.message.trim() === "" ? (DEFAULT_MESSAGE_OF_CODE[code] ?? "请求不对") : err.message;
	return { failure: fail(code, message), status: err.status };
}
