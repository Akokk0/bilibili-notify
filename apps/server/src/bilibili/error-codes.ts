import { type Failure, type FailureCode, fail } from "@bilibili-notify/internal";

/**
 * B 站「数字码 → BN 标准码」对照(ADR-0026 决策 4 下 10-14 的 🔗):风控 / 限流、没登录这两类要分得出来,
 * 面板与女仆才知道该等一会儿还是该去登录。表外的码回 `undefined`,调用方按 `unknown` 处理并记一笔
 * (原话进 `message`、数字码进 `upstreamCode`,认得了再来加一行)。
 *
 * 请求层(`api/api.ts` 的 `resultOf`)在接口回来时查一次这张表,经 {@link failureFromBili} 翻成失败结果;
 * 表外码的 warn(每个码一次)也在请求层记,这里只是纯函数。
 */
const TABLE: Readonly<Record<number, FailureCode>> = {
	[-352]: "rate_limited", // 风控校验失败
	[-412]: "rate_limited", // 请求被拦截(太频繁)
	[-799]: "rate_limited", // 请求过于频繁
	[-509]: "rate_limited", // 请求过于频繁
	[-101]: "unauthorized", // 账号未登录
};

export function standardCodeOfBili(code: number): FailureCode | undefined {
	return TABLE[code];
}

/**
 * B 站回了一个非 0 的码:翻成失败结果。有对照的取对应的标准码,表外的是 `unknown`(失败规矩第 6 条:
 * 对端明确回了失败、只给了没有对照的码);两种都带 `upstreamCode`,`message` 是 B 站的原话。
 * 不记日志 —— 纯函数,请求层、devtools 的盖板位与测试的假回应都靠它造同一个形状。
 */
export function failureFromBili(code: number, message: string): Failure {
	return fail(standardCodeOfBili(code) ?? "unknown", message, { upstreamCode: code });
}
