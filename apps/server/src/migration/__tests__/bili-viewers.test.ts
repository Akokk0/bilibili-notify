/**
 * 单元测试 — 迁移里读 0.x 字符串峰值的「X 人看过」压缩写法(`migration/stats.ts` 的 `parseBiliViewers`,纯函数)。
 *
 * 0.x 的下播帧把本场峰值落成 B 站排好的字(「1.2万」),迁一代时翻成数字。1.0 起总线上的观看人数是精确数
 * (`live-viewers-changed.viewers`,㉒d),统计的 B 站适配不再解析它 —— 这个解析只剩迁移用,所以搬到了迁移模块
 * (原先在统计目录下,测试也从那边搬来)。
 */

import { describe, expect, it } from "vite-plus/test";
import { parseBiliViewers } from "../stats.js";

describe("parseBiliViewers — 「X 人看过」的压缩写法 → 数字", () => {
	it("「万」按 1e4 换算", () => {
		expect(parseBiliViewers("1.2万")).toBe(12_000);
	});

	it("「亿」按 1e8 换算,不是当成裸数字", () => {
		expect(parseBiliViewers("1.2亿")).toBe(120_000_000);
	});

	it("裸数字原样取用,两头的空白不碍事", () => {
		expect(parseBiliViewers("9500")).toBe(9500);
		expect(parseBiliViewers(" 751 ")).toBe(751);
	});

	it("解析不出 → NaN,不是 0(未知不是零)", () => {
		expect(parseBiliViewers("看不懂")).toBeNaN();
		expect(parseBiliViewers("???")).toBeNaN();
		expect(parseBiliViewers("")).toBeNaN();
	});
});
