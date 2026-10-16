import { describe, expect, it } from "vite-plus/test";
import { LIVE_ROOM_CREATOR_KEYS, type LiveMonitorInput, needsLiveMonitor } from "../live-monitor";

const allOff = (): LiveMonitorInput => ({
	features: {
		liveStart: false,
		liveStreaming: false,
		liveEnd: false,
		membership: false,
		superchat: false,
		viewerChat: false,
		viewerEnter: false,
	},
	specialViewers: [],
});

/** 在 {@link allOff} 上改开关与名单。 */
const input = (
	features: Partial<LiveMonitorInput["features"]>,
	specialViewers: LiveMonitorInput["specialViewers"] = [],
): LiveMonitorInput => ({
	features: { ...allOff().features, ...features },
	specialViewers,
});

const CHAT = [{ features: ["viewerChat"] }] as const;
const ENTER = [{ features: ["viewerEnter"] }] as const;

/**
 * 判据(ADR-0027 决策 1 的 🔗 2026-10-13,3b-16):五把直播类开关任一开着,或「某把特别开关开着、且名单上有人带它」。
 * 只看折好的开关与名单,不看推送目标。
 *
 * 验红(施工时真改坏跑过):把 `needsLiveMonitor` 里特别那两支的开关一半去掉 → (b)(d) 红;把「名单上有人带它」
 * 去掉 → (c)(d) 红。
 */
describe("needsLiveMonitor —— 监听直播间的唯一判定", () => {
	it("全关、名单空 → 不监听", () => {
		expect(needsLiveMonitor(allOff())).toBe(false);
	});

	it.each(LIVE_ROOM_CREATOR_KEYS)("只开 %s 一把、名单空 → 监听", (key) => {
		expect(needsLiveMonitor(input({ [key]: true }))).toBe(true);
	});

	describe("特别弹幕 viewerChat", () => {
		it("(a) 开关开着、名单上有人带它 → 监听", () => {
			expect(needsLiveMonitor(input({ viewerChat: true }, CHAT))).toBe(true);
		});

		it("(b) 名单上有人带它、开关关着 → 不监听", () => {
			expect(needsLiveMonitor(input({ viewerChat: false }, CHAT))).toBe(false);
		});

		it("(c) 开关开着、名单上的人只带 viewerEnter → 不监听", () => {
			expect(needsLiveMonitor(input({ viewerChat: true }, ENTER))).toBe(false);
		});

		it("开关开着、名单空 → 不监听", () => {
			expect(needsLiveMonitor(input({ viewerChat: true }, []))).toBe(false);
		});
	});

	describe("特别进场 viewerEnter(对称)", () => {
		it("(a) 开关开着、名单上有人带它 → 监听", () => {
			expect(needsLiveMonitor(input({ viewerEnter: true }, ENTER))).toBe(true);
		});

		it("(b) 名单上有人带它、开关关着 → 不监听", () => {
			expect(needsLiveMonitor(input({ viewerEnter: false }, ENTER))).toBe(false);
		});

		it("(c) 开关开着、名单上的人只带 viewerChat → 不监听", () => {
			expect(needsLiveMonitor(input({ viewerEnter: true }, CHAT))).toBe(false);
		});
	});

	it("(d) 一个人同时带两把,只开其中一把 → 监听;两把都关 → 不监听", () => {
		const both = [{ features: ["viewerChat", "viewerEnter"] }] as const;
		expect(needsLiveMonitor(input({ viewerEnter: true }, both))).toBe(true);
		expect(needsLiveMonitor(input({}, both))).toBe(false);
	});

	it("(e) 五把直播开关任一开着,名单空 → 监听;特别开关关着、名单上有人也不拦它", () => {
		expect(needsLiveMonitor(input({ liveEnd: true }, []))).toBe(true);
		expect(needsLiveMonitor(input({ liveEnd: true, viewerChat: false }, CHAT))).toBe(true);
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
