import { describe, expect, it } from "vite-plus/test";
import { FEATURE_KEYS, type FeatureKey, makeEmptySubscription } from "../../types/domain";
import { routingAlignedToFeatures, subscribedFeatures } from "./helpers";

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

/**
 * 切到「自定义」推送模式时,target 的 routing 应对齐订阅项生效特性 —— 而非维持
 * follow 模式灌进的全 9 项(否则自定义矩阵默认全开)。
 */
describe("routingAlignedToFeatures", () => {
	const DEFAULT_ON: FeatureKey[] = ["dynamic", "live", "liveEnd", "wordcloud", "liveSummary"];
	const DEFAULT_OFF: FeatureKey[] = [
		"liveGuardBuy",
		"superchat",
		"specialDanmaku",
		"specialUserEnter",
	];

	it("follow 模式灌满全 9 项 → 对齐后只留生效特性", () => {
		const sub = makeEmptySubscription("100");
		for (const k of FEATURE_KEYS) sub.routing[k] = ["t-1"];
		const routing = routingAlignedToFeatures(sub, "t-1");
		for (const k of DEFAULT_ON) expect(routing[k]).toContain("t-1");
		for (const k of DEFAULT_OFF) expect(routing[k]).not.toContain("t-1");
	});

	it("target 原本不在任何 routing → 只加进生效特性", () => {
		const sub = makeEmptySubscription("100");
		const routing = routingAlignedToFeatures(sub, "t-1");
		expect(routing.dynamic).toEqual(["t-1"]);
		expect(routing.superchat).toEqual([]);
	});

	it("跟随 overrides:开 superchat 则纳入,关 dynamic 则剔除", () => {
		const sub = makeEmptySubscription("100");
		for (const k of FEATURE_KEYS) sub.routing[k] = ["t-1"];
		sub.overrides = { features: { superchat: true, dynamic: false } };
		const routing = routingAlignedToFeatures(sub, "t-1");
		expect(routing.superchat).toContain("t-1");
		expect(routing.dynamic).not.toContain("t-1");
	});

	it("不影响其它 target", () => {
		const sub = makeEmptySubscription("100");
		for (const k of FEATURE_KEYS) sub.routing[k] = ["t-1", "t-2"];
		const routing = routingAlignedToFeatures(sub, "t-1");
		for (const k of FEATURE_KEYS) expect(routing[k]).toContain("t-2");
	});
});
