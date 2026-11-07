/**
 * 直播端 LivePushKind → 特性键 的翻译表。
 *
 * 特性键管开关与路由,历史也记它(⑬f:历史行的那一格叫 `feature`,不再另有一套推送种类)。
 * 周期「正在直播」(0)是 `liveStreaming`,重启补报(11)走开播的路由、历史记成开播(`liveStart`)、
 * 不 @全体。下播的词云 / 总结不在这张表里:它们是下播那次推送里的附加项锚点,按附加项的键认
 * (原先的 5 / 10 两档已删),见 `engine-push-adapters.test.ts`。
 */

import { describe, expect, it } from "vite-plus/test";
import { LivePushKind } from "../../live/live-types";
import { liveKindAllowsAtAll, liveKindToFeature } from "../bound-push";

describe("liveKindToFeature", () => {
	it("完整映射表", () => {
		expect(liveKindToFeature(0)).toBe("liveStreaming");
		expect(liveKindToFeature(3)).toBe("liveStart");
		expect(liveKindToFeature(4)).toBe("membership");
		expect(liveKindToFeature(6)).toBe("superchat");
		expect(liveKindToFeature(7)).toBe("viewerChat");
		expect(liveKindToFeature(8)).toBe("viewerEnter");
		expect(liveKindToFeature(9)).toBe("liveEnd");
		expect(liveKindToFeature(11)).toBe("liveStart"); // 重启补报:走开播的路由
	});

	it("未知 type 兜底为 liveStart", () => {
		expect(liveKindToFeature(999)).toBe("liveStart");
	});

	it("枚举里的每一档都在表里有自己的一行(删掉的 5 / 10 两档不在枚举里)", () => {
		const codes = Object.values(LivePushKind);
		expect(codes.sort((a, b) => a - b)).toEqual([0, 3, 4, 6, 7, 8, 9, 11]);
	});
});

describe("liveKindAllowsAtAll — 只有真开播许 @全体", () => {
	it("开播(3)许;周期复推(0)、重启补报(11)与其余一律不许", () => {
		expect(liveKindAllowsAtAll(3)).toBe(true);
		for (const t of [0, 4, 6, 7, 8, 9, 11, 999]) {
			expect(liveKindAllowsAtAll(t)).toBe(false);
		}
	});
});
