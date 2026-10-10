/**
 * 单元测试 — 迁移里读 0.x 动态类型串的归类(`migration/stats.ts` 的 `classifyBiliDynamic`,纯函数)。
 *
 * ADR-0020 决策 5 / 7 的 🔗:统计仓只存中立的「有没有视频」,0.x 落盘的 `{type}` 行迁一代时按类型串翻。
 * 1.0 起新作品行不看类型串(看 `post.video`),这个函数只剩迁移在用(原先在 `stats/bili-format.ts`,测试也从那边搬来)。
 * 归类一旦漂移,投稿数 / 动态数两个口径会同时错,而且错得很安静,所以用例写得比较死。
 */

import { describe, expect, it } from "vite-plus/test";
import { classifyBiliDynamic } from "../stats.js";

describe("classifyBiliDynamic — 0.x 的 B 站动态类型 → 迁的作品有没有视频", () => {
	it("视频投稿 → 有视频", () => {
		expect(classifyBiliDynamic("DYNAMIC_TYPE_AV")).toEqual({ hasVideo: true });
	});

	it("开播那两种 → undefined:老行不是作品,迁移时丢掉(直播按场次另算,ADR-0027)", () => {
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
