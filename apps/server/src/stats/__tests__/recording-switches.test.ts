import { describe, expect, it } from "vite-plus/test";
import { recordingSwitches } from "../recording-switches.js";

const OFF = {
	post: false,
	liveStart: false,
	liveStreaming: false,
	liveEnd: false,
	membership: false,
	superchat: false,
	viewerChat: false,
	viewerEnter: false,
};

/**
 * 统计「在记」的直播那一格,用的是监听直播间的同一份判定(ADR-0027 决策 1):五把直播开关任一开着,
 * 或某把特别开关开着且名单上有人带它。
 *
 * 验红:`recording-switches.ts` 里把名单换成空表 → 「开关开着、名单上有人带它」红;把开关忽略 → 「名单上有人、开关关着」红。
 */
describe("recordingSwitches", () => {
	it("作品开关单看 post", () => {
		expect(recordingSwitches({ ...OFF, post: true }, []).posts).toBe(true);
		expect(recordingSwitches(OFF, []).posts).toBe(false);
	});

	it("五把直播开关任一开着 → live 在记,名单空也一样", () => {
		expect(recordingSwitches({ ...OFF, superchat: true }, []).live).toBe(true);
	});

	it("全关 → 不记", () => {
		expect(recordingSwitches(OFF, []).live).toBe(false);
	});

	it("viewerChat 开着、名单上有人带它 → 记", () => {
		expect(
			recordingSwitches({ ...OFF, viewerChat: true }, [{ features: ["viewerChat"] }]).live,
		).toBe(true);
	});

	it("名单上有人带 viewerChat、开关关着 → 不记", () => {
		expect(recordingSwitches(OFF, [{ features: ["viewerChat"] }]).live).toBe(false);
	});

	it("viewerEnter 开着、名单上的人只带 viewerChat → 不记", () => {
		expect(
			recordingSwitches({ ...OFF, viewerEnter: true }, [{ features: ["viewerChat"] }]).live,
		).toBe(false);
	});
});
