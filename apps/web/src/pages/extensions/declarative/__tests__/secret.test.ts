/**
 * 掩码的活是「屏幕上认得出是哪一把,但拿不到它」。头四尾四对**够长**的密钥成立,对短的就是
 * 把全文原样印出来 —— 32 位是 BN 自己生成的长度,而手填 / 别处迁移来的不是。
 *
 * (这一条原先钉在手写的桥页上,叫 `maskToken`;桥迁到 v2 之后,遮法只剩声明式设置项这一份。)
 */

import { describe, expect, it } from "vite-plus/test";
import { maskSecret } from "../secret";

const TOKEN = "0123456789abcdef0123456789abcdef";

describe("maskSecret", () => {
	it("短的整段打点 —— 留下的明文必须比原文短", () => {
		for (const value of ["a", "abcd", "ab12cd34"]) {
			const masked = maskSecret(value);
			expect(masked.replace(/•/g, ""), value).toHaveLength(0);
			expect(masked, value).not.toContain(value);
		}
	});

	it("够长的仍留头尾各四位 —— 两条才分得出谁是谁", () => {
		expect(maskSecret(TOKEN)).toBe(`0123${"•".repeat(24)}cdef`);
		expect(maskSecret("abcd12345")).toBe(`abcd${"•".repeat(4)}2345`);
	});
});
