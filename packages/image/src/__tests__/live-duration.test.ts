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

	// 时刻带毫秒:先把整段取整到秒再拆单位。从前拆完单独给秒取整 —— 119.6 秒拆成 1 分 59.6 秒,
	// 取整成「1分60秒」;300.3 秒拆成 5 分 0.3 秒,多出一个「5分0秒」。
	it("不足一秒的零头先整段取整,再拆单位:不出「60秒」,也不出尾巴上的「0秒」", () => {
		expect(liveDuration(T0, T0 + 119_600)).toBe("2分");
		expect(liveDuration(T0, T0 + 59_600)).toBe("1分");
		expect(liveDuration(T0, T0 + 300_300)).toBe("5分");
		expect(liveDuration(T0, T0 + 125_400)).toBe("2分5秒");
		expect(liveDuration(T0, T0 + 3_599_700)).toBe("1小时");
		expect(liveDuration(T0, T0 + 400)).toBe("0秒");
	});

	it("倒过来的也先取整:带负号,零头不留;不到半秒是「0秒」,不带负号", () => {
		expect(liveDuration(T0 + 119_600, T0)).toBe("-2分");
		expect(liveDuration(T0 + 125_400, T0)).toBe("-2分5秒");
		expect(liveDuration(T0 + 400, T0)).toBe("0秒");
	});
});
