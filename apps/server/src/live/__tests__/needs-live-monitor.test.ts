import { describe, expect, it } from "vite-plus/test";
import { LIVE_ROOM_CREATOR_KEYS, type LiveMonitorInput, needsLiveMonitor } from "../live-monitor";

const allOff = (): LiveMonitorInput => ({
	liveStart: false,
	liveStreaming: false,
	liveEnd: false,
	membership: false,
	superchat: false,
	customSpecialDanmakuUsers: { enable: false, msgTemplate: "" },
	customSpecialUsersEnterTheRoom: { enable: false, msgTemplate: "" },
});

describe("needsLiveMonitor —— 监听直播间的唯一判定", () => {
	it("全关 → 不监听", () => {
		expect(needsLiveMonitor(allOff())).toBe(false);
	});

	it.each(LIVE_ROOM_CREATOR_KEYS)("只开 %s 一把 → 监听", (key) => {
		expect(needsLiveMonitor({ ...allOff(), [key]: true })).toBe(true);
	});

	it("特别弹幕、特别关注进场各自单开 → 监听", () => {
		expect(
			needsLiveMonitor({
				...allOff(),
				customSpecialDanmakuUsers: { enable: true, specialDanmakuUsers: ["1"], msgTemplate: "" },
			}),
		).toBe(true);
		expect(
			needsLiveMonitor({
				...allOff(),
				customSpecialUsersEnterTheRoom: {
					enable: true,
					specialUsersEnterTheRoom: ["1"],
					msgTemplate: "",
				},
			}),
		).toBe(true);
	});
});
