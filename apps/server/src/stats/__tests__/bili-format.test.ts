/**
 * 单元测试 — 统计里 B 站那头的写法(`bili-format`,纯函数)。
 *
 * ADR-0020 决策 5 / 7 的 🔗:统计仓只存中立的「有没有视频」与数字,B 站的类型串只在交进来之前(B 站适配)与读老行时
 * (迁移)用到,两处共用这一份。归类一旦漂移,投稿数 / 动态数两个口径会同时错,而且错得很安静,所以用例写得比较死。
 * 「1.2万」的解析(`parseBiliViewers`)㉒d 起只留给迁移,搬到了 `migration/stats.ts`,测试在
 * `migration/__tests__/bili-viewers.test.ts`。
 */

import { describe, expect, it } from "vite-plus/test";
import { classifyBiliDynamic } from "../bili-format.js";

describe("classifyBiliDynamic — B 站动态类型 → 要记的作品有没有视频", () => {
	it("视频投稿 → 有视频", () => {
		expect(classifyBiliDynamic("DYNAMIC_TYPE_AV")).toEqual({ hasVideo: true });
	});

	it("开播那两种 → undefined:不是作品,统计不记(直播按场次另算,ADR-0027)", () => {
		expect(classifyBiliDynamic("DYNAMIC_TYPE_LIVE_RCMD")).toBeUndefined();
		expect(classifyBiliDynamic("DYNAMIC_TYPE_LIVE")).toBeUndefined();
	});

	it("图文 / 纯文字 / 转发 → 没有视频", () => {
		expect(classifyBiliDynamic("DYNAMIC_TYPE_DRAW")).toEqual({ hasVideo: false });
		expect(classifyBiliDynamic("DYNAMIC_TYPE_WORD")).toEqual({ hasVideo: false });
		expect(classifyBiliDynamic("DYNAMIC_TYPE_FORWARD")).toEqual({ hasVideo: false });
	});

	it("没见过的新类型 → 没有视频的作品,不静默丢弃", () => {
		expect(classifyBiliDynamic("DYNAMIC_TYPE_SOMETHING_NEW")).toEqual({ hasVideo: false });
	});
});
