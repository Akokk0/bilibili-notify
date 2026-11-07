import type { ErrorResponse } from "@bilibili-notify/contract";
import { type Failure, type FailureCode, fail, type Logger } from "@bilibili-notify/internal";
import type { Context, ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { t as serverText } from "../i18n/index.js";

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
	return c.json(errorBodyOf(failure), status);
}

/**
 * 失败 → 错误体({@link ErrorResponse}):去掉 `ok`,逐个字段挑。不经 HTTP 状态码、把失败塞进别的通道里的
 * 出口也用它(如 SSE 的 `error` 帧),免得各写一份、清单长不一样。
 */
export function errorBodyOf(failure: Failure): ErrorResponse {
	const body: ErrorResponse = { code: failure.code, message: failure.message };
	if (failure.issues !== undefined) body.issues = failure.issues;
	if (failure.upstreamCode !== undefined) body.upstreamCode = failure.upstreamCode;
	return body;
}

/** 全局出错处理回给客户端的那一句:原话只进日志,不外泄。 */
export const unhandledErrorMessage = () => serverText("service.routes.respond-failure.text.1");

/** 推送链路尚未就绪时，依赖它的接口回的固定提示。 */
export const pipelineNotReadyMessage = () => serverText("service.routes.respond-failure.text.2");

/** `notFound` 回的那一句。 */
export const routeNotFoundMessage = () => serverText("service.routes.respond-failure.text.3");

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
	get unauthorized() {
		return serverText("service.routes.respond-failure.text.4");
	},
	get not_found() {
		return serverText("service.routes.respond-failure.text.5");
	},
	get conflict() {
		return serverText("service.routes.respond-failure.text.6");
	},
	get rate_limited() {
		return serverText("service.routes.respond-failure.text.7");
	},
	get unavailable() {
		return unhandledErrorMessage();
	},
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
		err.message.trim() === ""
			? (DEFAULT_MESSAGE_OF_CODE[code] ?? serverText("service.routes.respond-failure.text.8"))
			: err.message;
	return { failure: fail(code, message), status: err.status };
}

/**
 * 全局出错处理(ADR-0026 决策 2、6):抛错只留给 bug,这里接住 —— 原始错误进错误日志,客户端只拿一句
 * 固定的话,`String(err)` 不再外泄(里头可能带路径、内部状态)。`HTTPException` 是中间件 / 路由主动
 * 抛的,按它的状态码挑码、状态码与 message 照原样。
 *
 * 挂在 `app.onError`,`app.ts` 一处。
 */
export function requestErrorHandler(logger: Pick<Logger, "error">): ErrorHandler {
	return (err, c) => {
		if (err instanceof HTTPException) {
			const { failure, status } = failureOfHttpException(err);
			if (status >= 500) logger.error("http exception", err);
			return respondFailure(c, failure, status);
		}
		logger.error("unhandled request error", err);
		return respondFailure(c, fail("unavailable", unhandledErrorMessage()));
	};
}
