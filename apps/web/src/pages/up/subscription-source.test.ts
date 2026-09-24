/**
 * 订阅源拓展在订阅页上的样子(ADR-0019 决策 4 / 5 / 10 / 41)。
 *
 * - 事件 → 特性走 internal 那一张表:`post → dynamic`、`liveStart → live`、`liveEnd → liveEnd`,
 *   顺序跟 FEATURE_KEYS 走,不跟清单里写的顺序走。
 * - 平台选择只列**在跑**的订阅源;外观照清单给、停着也有,但「在不在场」另看 `state`。
 * - 拓展列表没回来时不下「没开」的结论;没装时拿不到名字就写拓展 id。
 */

import type { ExtensionDTO } from "@bilibili-notify/contract";
import { DEFAULT_ROAST_SCHEDULE } from "@bilibili-notify/internal/constants";
import { describe, expect, it } from "vite-plus/test";
import type { ExtensionSubscription } from "../../types/domain";
import {
	featuresForEvents,
	runningSubscriptionSources,
	subscriptionPlatformOf,
} from "./subscription-source";

function ext(over: Partial<ExtensionDTO> = {}): ExtensionDTO {
	return {
		id: "douyin",
		name: "抖音订阅",
		dir: "/data/extensions/douyin",
		enabled: true,
		state: "running",
		apiVersion: 2,
		provides: ["subscription"],
		subscription: {
			display: { label: "抖音", shortLabel: "抖", color: "#161823", postNoun: "作品" },
			events: ["liveStart", "post"],
		},
		...over,
	};
}

function sub(extensionId = "douyin"): ExtensionSubscription {
	return {
		kind: "extension",
		id: "22222222-2222-4222-8222-222222222222",
		extensionId,
		externalId: "MS4wLjAB-sec",
		enabled: true,
		groups: [],
		routing: {
			dynamic: [],
			live: [],
			liveEnd: [],
			liveGuardBuy: [],
			superchat: [],
			specialDanmaku: [],
			specialUserEnter: [],
		},
		extras: { atAllDynamic: {}, atAllLive: {}, wordcloud: {}, liveSummary: {} },
		overrides: {},
		roastSchedule: { ...DEFAULT_ROAST_SCHEDULE },
		state: { lastPushedAt: {}, liveStatus: "unknown" },
	};
}

describe("事件 → 特性", () => {
	it("按决策 4 那张表映射,顺序跟 FEATURE_KEYS 走", () => {
		expect(featuresForEvents(["liveEnd", "post"])).toEqual(["dynamic", "liveEnd"]);
		expect(featuresForEvents(["liveStart"])).toEqual(["live"]);
		expect(featuresForEvents(["post", "liveStart", "liveEnd"])).toEqual([
			"dynamic",
			"live",
			"liveEnd",
		]);
	});
});

describe("平台选择那一排", () => {
	it("只列在跑、且开了订阅那一口的拓展", () => {
		const list = [
			ext(),
			ext({ id: "stopped", state: "disabled" }),
			ext({ id: "push-only", subscription: undefined, provides: ["push"] }),
		];
		expect(runningSubscriptionSources(list).map((e) => e.id)).toEqual(["douyin"]);
	});

	it("拓展列表还没回来 → 一个都不列", () => {
		expect(runningSubscriptionSources(undefined)).toEqual([]);
	});
});

describe("一条拓展订阅的平台", () => {
	it("在跑:外观照清单,只列它报的事件对应的特性", () => {
		const p = subscriptionPlatformOf(sub(), [ext()]);
		expect(p).toMatchObject({
			label: "抖音",
			shortLabel: "抖",
			color: "#161823",
			postNoun: "作品",
			absent: false,
		});
		expect(p.features).toEqual(["dynamic", "live"]);
	});

	it("停着:外观照样有(决策 41),但算不在场", () => {
		const p = subscriptionPlatformOf(sub(), [ext({ state: "disabled", enabled: false })]);
		expect(p.label).toBe("抖音");
		expect(p.absent).toBe(true);
	});

	it("没装:拿不到名字就写拓展 id,特性按拓展订阅最多能有的那几种", () => {
		const p = subscriptionPlatformOf(sub("douyin"), []);
		expect(p.label).toBe("douyin");
		expect(p.absent).toBe(true);
		expect(p.features).toEqual(["dynamic", "live", "liveEnd"]);
	});

	it("装着但清单没交订阅那一口:退回拓展的名字", () => {
		const p = subscriptionPlatformOf(sub(), [
			ext({ subscription: undefined, state: "failed", detail: "清单读不了" }),
		]);
		expect(p.label).toBe("抖音订阅");
		expect(p.absent).toBe(true);
	});

	it("拓展列表没回来:不下结论", () => {
		const p = subscriptionPlatformOf(sub(), undefined);
		expect(p.absent).toBeUndefined();
		expect(p.label).toBe("douyin");
	});
});
