import type { FailureCode } from "@bilibili-notify/internal";

/**
 * B 站「数字码 → BN 标准码」对照(ADR-0026 决策 4 下 10-14 的 🔗):风控 / 限流、没登录这两类要分得出来,
 * 面板与女仆才知道该等一会儿还是该去登录。表外的码回 `undefined`,调用方按 `unknown` 处理并记一笔
 * (原话进 `message`、数字码进 `upstreamCode`,认得了再来加一行)。
 *
 * 只是一张纯函数的表,不接请求层;3b-18 再把它接进请求层。
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
