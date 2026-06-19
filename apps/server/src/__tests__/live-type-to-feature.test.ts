/**
 * 回归守护 — P0-1 fix(live): route live-summary independently from wordcloud。
 *
 * 与 koishi/live 的同名映射对齐;两端 adapter 必须给出一致的 LivePushType → FeatureKey
 * 翻译,否则同一份业务核心在双端会出现路由分歧。
 */

import { describe, expect, it } from "vite-plus/test";
import { liveTypeToFeature } from "../runtime/engines";

describe("apps/server adapter typeToFeature", () => {
	it("LivePushType 完整映射表", () => {
		expect(liveTypeToFeature(0)).toBe("live");
		expect(liveTypeToFeature(3)).toBe("live");
		expect(liveTypeToFeature(4)).toBe("liveGuardBuy");
		expect(liveTypeToFeature(5)).toBe("wordcloud");
		expect(liveTypeToFeature(6)).toBe("superchat");
		expect(liveTypeToFeature(7)).toBe("specialDanmaku");
		expect(liveTypeToFeature(8)).toBe("specialUserEnter");
		expect(liveTypeToFeature(9)).toBe("liveEnd");
		expect(liveTypeToFeature(10)).toBe("liveSummary"); // P0-1 新加
	});

	it("未知 type 兜底为 live", () => {
		expect(liveTypeToFeature(999)).toBe("live");
	});
});
