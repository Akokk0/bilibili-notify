/**
 * 回归守护 — P0-1 fix(live): route live-summary independently from wordcloud。
 *
 * adapter 的 typeToFeature 映射表是 koishi 端 PushLike → BilibiliPush.broadcastToFeature
 * 之间的唯一翻译层。任何人删错一行,直播相关路由静默错位。这里锁住所有 LivePushType
 * 数字的目标 FeatureKey。
 */

import { describe, expect, it } from "vite-plus/test";
import { liveTypeAllowsAtAll, liveTypeToFeature } from "../live-type-map";

describe("koishi/live adapter typeToFeature", () => {
	it("LivePushType 完整映射表", () => {
		expect(liveTypeToFeature(0)).toBe("live"); // Live
		expect(liveTypeToFeature(3)).toBe("live"); // StartBroadcasting
		expect(liveTypeToFeature(4)).toBe("liveGuardBuy");
		expect(liveTypeToFeature(5)).toBe("wordcloud"); // WordCloudAndLiveSummary → 仅词云
		expect(liveTypeToFeature(6)).toBe("superchat");
		expect(liveTypeToFeature(7)).toBe("specialDanmaku");
		expect(liveTypeToFeature(8)).toBe("specialUserEnter");
		expect(liveTypeToFeature(9)).toBe("liveEnd");
		expect(liveTypeToFeature(10)).toBe("liveSummary"); // P0-1 新加,与 5 解耦
	});

	it("未知 type 兜底为 live", () => {
		expect(liveTypeToFeature(999)).toBe("live");
	});
});

describe("koishi/live adapter liveTypeAllowsAtAll", () => {
	it("仅 StartBroadcasting(=3,开播)允许 @全体", () => {
		expect(liveTypeAllowsAtAll(3)).toBe(true);
	});

	it("周期「正在直播」(Live=0)及其它一律不允许 @全体(本次 bug 修复)", () => {
		// 0 与 3 都映射成 feature "live",但只有 3 可 @全体。
		expect(liveTypeToFeature(0)).toBe("live");
		expect(liveTypeAllowsAtAll(0)).toBe(false);
		for (const t of [4, 5, 6, 7, 8, 9, 10]) {
			expect(liveTypeAllowsAtAll(t)).toBe(false);
		}
	});

	it("未知 type 兜底不允许 @全体", () => {
		expect(liveTypeAllowsAtAll(999)).toBe(false);
	});
});
