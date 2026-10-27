import { describe, expect, it } from "vite-plus/test";
import { textPreview } from "../text-preview.js";

describe("textPreview", () => {
	it("字符串照念", () => {
		expect(textPreview("auth_lost")).toBe("auth_lost");
	});

	it("不是字符串的只说类型", () => {
		expect(textPreview(1)).toBe("(number)");
		expect(textPreview(undefined)).toBe("(undefined)");
		expect(textPreview(null)).toBe("(object)");
		expect(textPreview({ code: "x" })).toBe("(object)");
	});

	it("正好 64 字不截", () => {
		const exact = "a".repeat(64);
		expect(textPreview(exact)).toBe(exact);
	});

	it("超过 64 字截一段加省略号", () => {
		expect(textPreview("a".repeat(100))).toBe(`${"a".repeat(64)}…`);
	});
});
