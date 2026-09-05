/**
 * 直播端 LivePushType → 特性键 / 推送类型 的翻译表。
 *
 * 特性键管开关与路由(词云 / 总结是下播的附加项,跟着下播走);推送类型管历史怎么记
 * (开播与周期「正在直播」共用一把特性键,历史上却是两类)。两张表都在这里钉死。
 */

import { describe, expect, it } from "vite-plus/test";
import { liveBroadcastOpts, liveTypeToFeature, liveTypeToPushKind } from "../runtime/engines";

describe("liveTypeToFeature", () => {
	it("完整映射表:词云 / 总结归到 liveEnd", () => {
		expect(liveTypeToFeature(0)).toBe("live");
		expect(liveTypeToFeature(3)).toBe("live");
		expect(liveTypeToFeature(4)).toBe("liveGuardBuy");
		expect(liveTypeToFeature(5)).toBe("liveEnd");
		expect(liveTypeToFeature(6)).toBe("superchat");
		expect(liveTypeToFeature(7)).toBe("specialDanmaku");
		expect(liveTypeToFeature(8)).toBe("specialUserEnter");
		expect(liveTypeToFeature(9)).toBe("liveEnd");
		expect(liveTypeToFeature(10)).toBe("liveEnd");
	});

	it("未知 type 兜底为 live", () => {
		expect(liveTypeToFeature(999)).toBe("live");
	});
});

describe("liveTypeToPushKind", () => {
	it("完整映射表:周期复推单列一类,词云 / 总结记在下播名下", () => {
		expect(liveTypeToPushKind(0)).toBe("live-ongoing");
		expect(liveTypeToPushKind(3)).toBe("live");
		expect(liveTypeToPushKind(4)).toBe("guard");
		expect(liveTypeToPushKind(5)).toBe("live-end");
		expect(liveTypeToPushKind(6)).toBe("sc");
		expect(liveTypeToPushKind(7)).toBe("special-danmaku");
		expect(liveTypeToPushKind(8)).toBe("special-enter");
		expect(liveTypeToPushKind(9)).toBe("live-end");
		expect(liveTypeToPushKind(10)).toBe("live-end");
		expect(liveTypeToPushKind(999)).toBe("live");
	});
});

describe("liveBroadcastOpts — 直播端一次广播交给推送层的选项", () => {
	it("开播:允许 @全体、kind live、透传 pushId", () => {
		expect(liveBroadcastOpts(3, { pushId: "p1" })).toEqual({
			pushId: "p1",
			role: undefined,
			allowAtAll: true,
			kind: "live",
		});
	});

	it("周期复推:抑制 @全体、kind live-ongoing", () => {
		expect(liveBroadcastOpts(0, undefined)).toMatchObject({
			allowAtAll: false,
			kind: "live-ongoing",
		});
	});

	it("词云:附加项照传、kind live-end、不 @全体", () => {
		expect(liveBroadcastOpts(5, { pushId: "p1", role: "extra" })).toEqual({
			pushId: "p1",
			role: "extra",
			allowAtAll: false,
			kind: "live-end",
		});
	});
});
