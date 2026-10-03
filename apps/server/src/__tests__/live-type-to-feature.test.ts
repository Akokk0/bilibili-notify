/**
 * 直播端 LivePushType → 特性键 的翻译表。
 *
 * 特性键管开关与路由(词云 / 总结是下播的附加项,跟着下播走),历史也记它(⑬f:历史行的那一格叫
 * `feature`,不再另有一套推送种类)。周期「正在直播」(0)是 `liveStreaming`,重启补报(11)
 * 走开播的路由、历史记成开播(`liveStart`)、不 @全体。这张表和广播选项都在这里钉死。
 */

import { describe, expect, it } from "vite-plus/test";
import { liveBroadcastOpts, liveTypeToExtra, liveTypeToFeature } from "../runtime/engines";

describe("liveTypeToFeature", () => {
	it("完整映射表:词云 / 总结归到 liveEnd", () => {
		expect(liveTypeToFeature(0)).toBe("liveStreaming");
		expect(liveTypeToFeature(3)).toBe("liveStart");
		expect(liveTypeToFeature(4)).toBe("membership");
		expect(liveTypeToFeature(5)).toBe("liveEnd");
		expect(liveTypeToFeature(6)).toBe("superchat");
		expect(liveTypeToFeature(7)).toBe("specialDanmaku");
		expect(liveTypeToFeature(8)).toBe("specialUserEnter");
		expect(liveTypeToFeature(9)).toBe("liveEnd");
		expect(liveTypeToFeature(10)).toBe("liveEnd");
		expect(liveTypeToFeature(11)).toBe("liveStart"); // 重启补报:走开播的路由
	});

	it("未知 type 兜底为 liveStart", () => {
		expect(liveTypeToFeature(999)).toBe("liveStart");
	});
});

// ADR-0016 决策 5:附加项的键就是在这一步、紧挨着「翻成哪把特性」产出的 —— 推送层据它
// 在主特性的目标列表上再筛一道。
describe("liveTypeToExtra", () => {
	it("词云(5)/ 总结(10)各是一把附加项键", () => {
		expect(liveTypeToExtra(5)).toBe("wordcloud");
		expect(liveTypeToExtra(10)).toBe("liveSummary");
	});

	it("其余一律没有 —— 尤其下播卡本体(9):它要是也带上键,整张卡会被附加项的三态表收窄掉", () => {
		for (const t of [0, 3, 4, 6, 7, 8, 9, 11, 999]) {
			expect(liveTypeToExtra(t)).toBeUndefined();
		}
	});
});

describe("liveBroadcastOpts — 直播端一次广播交给推送层的选项", () => {
	it("开播:允许 @全体、透传 pushId,不是附加项", () => {
		expect(liveBroadcastOpts(3, { pushId: "p1" })).toEqual({
			pushId: "p1",
			role: undefined,
			allowAtAll: true,
			extra: undefined,
		});
	});

	it("周期复推:抑制 @全体", () => {
		expect(liveBroadcastOpts(0, undefined)).toMatchObject({ allowAtAll: false });
	});

	it("重启补报:抑制 @全体,不是附加项", () => {
		expect(liveBroadcastOpts(11, { pushId: "p1" })).toEqual({
			pushId: "p1",
			role: undefined,
			allowAtAll: false,
			extra: undefined,
		});
	});

	it("词云:附加项键照传、不 @全体", () => {
		expect(liveBroadcastOpts(5, { pushId: "p1", role: "extra" })).toEqual({
			pushId: "p1",
			role: "extra",
			allowAtAll: false,
			extra: "wordcloud",
		});
	});

	it("AI 总结:换一把附加项键,其余与词云同", () => {
		expect(liveBroadcastOpts(10, { pushId: "p1", role: "extra" })).toEqual({
			pushId: "p1",
			role: "extra",
			allowAtAll: false,
			extra: "liveSummary",
		});
	});

	it("下播卡本体:不带附加项键", () => {
		expect(liveBroadcastOpts(9, { pushId: "p1" })).toEqual({
			pushId: "p1",
			role: undefined,
			allowAtAll: false,
			extra: undefined,
		});
	});
});
