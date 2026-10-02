/**
 * 订阅源声明的事件 → 它那一条订阅能有的特性(ADR-0019 决策 4 / 5)。
 *
 * 一对一的部分(`post → post`、`liveStart → liveStart`、`liveEnd → liveEnd`)走 `SUBSCRIPTION_EVENT_FEATURES`;
 * 周期「正在直播」(`liveStreaming`)不是一种事件,它的规则是:**声明了开播与下播两种事件才有**(⑬d)—— 只报开播的源
 * 没有下播事件把这一场收掉,周期推送一旦开了就没有尽头。文档规则里另有「来源能查在播状态」那半,随 3a,这里不做。
 */

import { describe, expect, it } from "vite-plus/test";
import { featuresForEvents } from "../constants";

describe("featuresForEvents", () => {
	it("一对一的三种:顺序跟 FEATURE_KEYS 走,不跟清单里写的顺序走", () => {
		expect(featuresForEvents(["liveEnd", "post"])).toEqual(["post", "liveEnd"]);
		expect(featuresForEvents(["liveStart"])).toEqual(["liveStart"]);
		expect(featuresForEvents(["post"])).toEqual(["post"]);
		expect(featuresForEvents([])).toEqual([]);
	});

	it("同时声明了开播与下播 → 多一把 liveStreaming,排在 liveStart 之后", () => {
		expect(featuresForEvents(["liveEnd", "liveStart"])).toEqual([
			"liveStart",
			"liveStreaming",
			"liveEnd",
		]);
		expect(featuresForEvents(["post", "liveStart", "liveEnd"])).toEqual([
			"post",
			"liveStart",
			"liveStreaming",
			"liveEnd",
		]);
	});

	it("只声明开播、或只声明下播 → 没有 liveStreaming", () => {
		expect(featuresForEvents(["post", "liveStart"])).not.toContain("liveStreaming");
		expect(featuresForEvents(["post", "liveEnd"])).not.toContain("liveStreaming");
	});
});
