import { describe, expect, it } from "vite-plus/test";
import { standardCodeOfBili } from "../error-codes.js";

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
