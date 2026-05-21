import { describe, expect, it } from "vitest";
import { type FeatureKey, makeEmptySubscription } from "../../types/domain";
import { subscribedFeatures } from "./helpers";

/**
 * 回归:订阅卡片的特性标签必须反映「订阅项主开关」(overrides.features,缺省继承
 * DEFAULT_FEATURE_FLAGS),而非 routing。此前 UpCard 据 routing 判定 —— follow 模式
 * 加推送目标会把目标灌进全部 9 个特性的 routing,导致卡片恒显全部标签。
 */
describe("subscribedFeatures", () => {
	it("无 overrides:返回 DEFAULT_FEATURE_FLAGS 中默认开启的特性", () => {
		const sub = makeEmptySubscription("100");
		expect(subscribedFeatures(sub)).toEqual([
			"dynamic",
			"live",
			"liveEnd",
			"wordcloud",
			"liveSummary",
		]);
	});

	it("overrides 关掉某默认开启的特性 → 不出现", () => {
		const sub = makeEmptySubscription("100");
		sub.overrides = { features: { dynamic: false } };
		expect(subscribedFeatures(sub)).not.toContain("dynamic");
	});

	it("overrides 开启某默认关闭的特性 → 出现", () => {
		const sub = makeEmptySubscription("100");
		sub.overrides = { features: { superchat: true } };
		expect(subscribedFeatures(sub)).toContain("superchat");
	});

	it("routing 灌满全部目标也不影响结果 —— 只看主开关,不看 routing", () => {
		const sub = makeEmptySubscription("100");
		// 模拟 follow 模式加推送目标:全部 9 个特性的 routing 都塞了同一个目标。
		for (const k of Object.keys(sub.routing) as FeatureKey[]) sub.routing[k] = ["t-1"];
		// 主开关只留 dynamic(其余默认开启的全关掉)。
		sub.overrides = {
			features: { live: false, liveEnd: false, wordcloud: false, liveSummary: false },
		};
		expect(subscribedFeatures(sub)).toEqual(["dynamic"]);
	});
});
