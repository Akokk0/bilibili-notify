import { describe, expect, it } from "vite-plus/test";
import { failureFromBili, standardCodeOfBili } from "../error-codes.js";

describe("standardCodeOfBili —— B 站数字码 → BN 标准码", () => {
	it.each([-352, -412, -799, -509])("%i 是风控 / 限流 → rate_limited", (code) => {
		expect(standardCodeOfBili(code)).toBe("rate_limited");
	});

	it("-101 没登录 → unauthorized", () => {
		expect(standardCodeOfBili(-101)).toBe("unauthorized");
	});

	it("没对照的码 → undefined(调用方按 unknown 处理并记一笔)", () => {
		expect(standardCodeOfBili(-9999)).toBeUndefined();
		expect(standardCodeOfBili(0)).toBeUndefined();
	});
});

describe("failureFromBili —— B 站回了某个码 → 失败结果", () => {
	it("有对照的码 → 对应的标准码,原话与原码都带着", () => {
		expect(failureFromBili(-412, "请求被拦截")).toEqual({
			ok: false,
			code: "rate_limited",
			message: "请求被拦截",
			upstreamCode: -412,
		});
		expect(failureFromBili(-101, "账号未登录")).toMatchObject({
			code: "unauthorized",
			upstreamCode: -101,
		});
	});

	it("没对照的码 → unknown,原码进 upstreamCode", () => {
		expect(failureFromBili(-403, "访问权限不足")).toEqual({
			ok: false,
			code: "unknown",
			message: "访问权限不足",
			upstreamCode: -403,
		});
	});

	it("原话原样,不改、不补", () => {
		expect(failureFromBili(-352, "  风控校验失败 \n").message).toBe("  风控校验失败 \n");
	});
});
