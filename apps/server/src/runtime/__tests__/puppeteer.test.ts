import { describe, expect, it } from "vite-plus/test";
import { resolveChromePath } from "../puppeteer";

describe("resolveChromePath", () => {
	it("returns the explicit path as-is when provided (operator's choice wins)", () => {
		// 显式路径优先,即使探测判定它不存在也原样返回 —— 路径写错由 puppeteer 启动
		// 报清晰错误,而非静默换一个浏览器造成困惑。
		const result = resolveChromePath("/custom/chrome", {
			exists: () => false,
			platform: "linux",
		});
		expect(result).toBe("/custom/chrome");
	});

	it("falls back to the first existing platform candidate when path is empty", () => {
		// 没显式路径时,按平台候选表顺序取第一个 exists 命中的。
		const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
		const result = resolveChromePath("", {
			platform: "darwin",
			exists: (p) => p === chrome,
		});
		expect(result).toBe(chrome);
	});

	it("returns the first candidate when several exist (priority order)", () => {
		const result = resolveChromePath(undefined, {
			platform: "linux",
			exists: () => true, // 全都"存在" → 取候选表最靠前的
		});
		expect(result).toBe("/usr/bin/google-chrome");
	});

	it("returns null when no candidate exists on the platform", () => {
		const result = resolveChromePath(undefined, {
			platform: "linux",
			exists: () => false,
		});
		expect(result).toBeNull();
	});

	it("returns null for a platform without a candidate table", () => {
		const result = resolveChromePath(undefined, {
			platform: "freebsd" as NodeJS.Platform,
			exists: () => true,
		});
		expect(result).toBeNull();
	});
});
