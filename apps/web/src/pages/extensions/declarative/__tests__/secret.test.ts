/**
 * 密钥在面板上的两件事(`secret.ts`)。
 *
 * 🔴 **存着的那一把只画服务端给的遮挡**(ADR-0019 决策 35 / 38):面板不再自己截头尾 —— 浏览器手里
 * 本来就没有全文。万一下发的不是遮挡的形状,一律画一串点,不原样上屏。
 *
 * (原先这里钉的是浏览器自己的遮法 `maskSecret`;头尾改由服务端算之后,那把尺子只剩服务端一份。)
 */

import { describe, expect, it } from "vite-plus/test";
import { maskedOf, newHexSecret } from "../secret";

const TOKEN = "0123456789abcdef0123456789abcdef";

describe("maskedOf", () => {
	it("服务端给的遮挡:原样交出", () => {
		expect(maskedOf({ masked: `0123${"•".repeat(8)}cdef` })).toBe(`0123${"•".repeat(8)}cdef`);
	});

	it("没配(空串 / 没有):undefined —— 面板要分得开「没配」与「配了」", () => {
		expect(maskedOf("")).toBeUndefined();
		expect(maskedOf(undefined)).toBeUndefined();
		expect(maskedOf(null)).toBeUndefined();
	});

	it("不是遮挡的形状(明文、别的对象):一串点,原文不上屏", () => {
		for (const value of [TOKEN, { secret: TOKEN }, 42, [TOKEN]]) {
			const shown = maskedOf(value);
			expect(shown, JSON.stringify(value)).toBe("•".repeat(8));
			expect(shown).not.toContain("0123");
		}
	});
});

describe("newHexSecret", () => {
	it("32 位小写十六进制,每次都不一样", () => {
		const first = newHexSecret();
		expect(first).toMatch(/^[0-9a-f]{32}$/);
		expect(newHexSecret()).not.toBe(first);
	});
});
