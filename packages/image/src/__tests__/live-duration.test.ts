/**
 * 直播时长那一句(`liveDuration`,ADR-0019 决策 67):拓展订阅的直播文案 `{time}` 用它 —— 与 B 站那头
 * (`ImageRenderer.getTimeDifference`,读时钟)同一种写法,只是两个时刻都由调用方给:下播卡的时长要定格
 * 在下播那一刻(断流接续等的那几分钟不算进去)。
 */

import { describe, expect, it } from "vite-plus/test";
import { liveDuration } from "../live-view";

const T0 = Date.UTC(2026, 8, 24, 4, 0, 0);

describe("liveDuration", () => {
	it("写成「2小时13分5秒」,为零的单位不写", () => {
		expect(liveDuration(T0, T0 + (2 * 3600 + 13 * 60 + 5) * 1000)).toBe("2小时13分5秒");
		expect(liveDuration(T0, T0 + 2 * 3600 * 1000)).toBe("2小时");
		expect(liveDuration(T0, T0 + 26 * 3600 * 1000)).toBe("1天2小时");
	});

	it("两个时刻相等是「0秒」;倒过来带负号", () => {
		expect(liveDuration(T0, T0)).toBe("0秒");
		expect(liveDuration(T0 + 60_000, T0)).toBe("-1分");
	});
});
