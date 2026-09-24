/**
 * 单元测试 — 统计里 B 站那头的写法(`bili-format`,纯函数)。
 *
 * ADR-0020 决策 5 / 7 的 🔗:统计仓只存中立的种类与数字,B 站的类型串与「1.2万」这种
 * 压缩写法只在交进来之前(B 站适配)与读老行时(store 的老行翻译)用到,两处共用这一份。
 * 归类一旦漂移,投稿数 / 动态数两个口径会同时错,而且错得很安静,所以用例写得比较死。
 */

import { describe, expect, it } from "vite-plus/test";
import { classifyBiliDynamic, parseBiliViewers } from "../bili-format.js";

describe("classifyBiliDynamic — B 站动态类型 → 中立种类", () => {
	it("视频投稿 → video", () => {
		expect(classifyBiliDynamic("DYNAMIC_TYPE_AV")).toBe("video");
	});

	it("开播那两种 → live:不是作品,但算活动证据(ADR-0020 决策 5 的第二个 🔗)", () => {
		expect(classifyBiliDynamic("DYNAMIC_TYPE_LIVE_RCMD")).toBe("live");
		expect(classifyBiliDynamic("DYNAMIC_TYPE_LIVE")).toBe("live");
	});

	it("图文 / 纯文字 / 转发 → post", () => {
		expect(classifyBiliDynamic("DYNAMIC_TYPE_DRAW")).toBe("post");
		expect(classifyBiliDynamic("DYNAMIC_TYPE_WORD")).toBe("post");
		expect(classifyBiliDynamic("DYNAMIC_TYPE_FORWARD")).toBe("post");
	});

	it("没见过的新类型 → post,不静默丢弃", () => {
		expect(classifyBiliDynamic("DYNAMIC_TYPE_SOMETHING_NEW")).toBe("post");
	});
});

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
