import { describe, expect, it } from "vite-plus/test";
import {
	LIVE_ROOM_CREATOR_KEYS,
	type LiveMonitorInput,
	liveMonitorInputOf,
	needsLiveMonitor,
	specialUserFlagsOf,
} from "../live-monitor";

const allOff = (): LiveMonitorInput => ({
	liveStart: false,
	liveStreaming: false,
	liveEnd: false,
	membership: false,
	superchat: false,
	specialDanmaku: false,
	specialUserEnter: false,
});

// 前三条搬自服务端 `live/__tests__/needs-live-monitor.test.ts`(全关 / 逐把单开 / 两个特别关注各自单开),入参换成新形状。
describe("needsLiveMonitor —— 监听直播间的唯一判定", () => {
	it("全关 → 不监听", () => {
		expect(needsLiveMonitor(allOff())).toBe(false);
	});

	it.each(LIVE_ROOM_CREATOR_KEYS)("只开 %s 一把 → 监听", (key) => {
		expect(needsLiveMonitor({ ...allOff(), [key]: true })).toBe(true);
	});

	it("特别弹幕、特别进场各自单开 → 监听", () => {
		expect(needsLiveMonitor({ ...allOff(), specialDanmaku: true })).toBe(true);
		expect(needsLiveMonitor({ ...allOff(), specialUserEnter: true })).toBe(true);
	});

	it("五把直播类开关就是这五个键", () => {
		expect([...LIVE_ROOM_CREATOR_KEYS]).toEqual([
			"liveStart",
			"liveStreaming",
			"liveEnd",
			"membership",
			"superchat",
		]);
	});
});

describe("specialUserFlagsOf", () => {
	it("没有特别关注用户 → 两格都空", () => {
		expect(specialUserFlagsOf({ specialUsers: [] })).toEqual({
			specialDanmaku: false,
			specialUserEnter: false,
		});
	});

	it("按种类分别判,一位可以同时是两种", () => {
		expect(specialUserFlagsOf({ specialUsers: [{ kinds: ["danmaku"] }] })).toEqual({
			specialDanmaku: true,
			specialUserEnter: false,
		});
		expect(specialUserFlagsOf({ specialUsers: [{ kinds: ["enter"] }, { kinds: ["x"] }] })).toEqual({
			specialDanmaku: false,
			specialUserEnter: true,
		});
		expect(specialUserFlagsOf({ specialUsers: [{ kinds: ["enter", "danmaku"] }] })).toEqual({
			specialDanmaku: true,
			specialUserEnter: true,
		});
	});
});

describe("liveMonitorInputOf —— 把折好的开关与特别关注条件摆成判定的入参", () => {
	it("只取五把直播类开关,别的开关(作品等)不带进去", () => {
		const features = {
			post: true,
			liveStart: false,
			liveStreaming: true,
			liveEnd: false,
			membership: false,
			superchat: true,
		};
		const special = { specialDanmaku: false, specialUserEnter: true };
		expect(liveMonitorInputOf(features, special)).toEqual({
			liveStart: false,
			liveStreaming: true,
			liveEnd: false,
			membership: false,
			superchat: true,
			specialDanmaku: false,
			specialUserEnter: true,
		});
	});
});
