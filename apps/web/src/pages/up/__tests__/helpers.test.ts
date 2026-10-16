import { describe, expect, it } from "vite-plus/test";
import {
	DEFAULT_FEATURE_FLAGS,
	FEATURE_KEYS,
	type FeatureKey,
	makeEmptySubscription,
} from "../../../types/domain";
import {
	colorFromSeed,
	displayName,
	routingAlignedToFeatures,
	subscribedFeatures,
	subscriptionColor,
} from "../helpers";

/**
 * 回归:订阅卡片的特性标签必须反映「订阅项主开关」(overrides.features,缺省继承
 * DEFAULT_FEATURE_FLAGS),而非 routing。此前 UpCard 据 routing 判定 —— follow 模式
 * 加推送目标会把目标灌进全部 7 个特性的 routing,导致卡片恒显全部标签。
 */
describe("subscribedFeatures", () => {
	it("无 overrides:返回 DEFAULT_FEATURE_FLAGS 中默认开启的特性", () => {
		const sub = makeEmptySubscription({ sourceKey: "bilibili", externalId: "100" });
		expect(subscribedFeatures(sub)).toEqual(["post", "liveStart", "liveEnd"]);
	});

	it("overrides 关掉某默认开启的特性 → 不出现", () => {
		const sub = makeEmptySubscription({ sourceKey: "bilibili", externalId: "100" });
		sub.overrides = { features: { post: false } };
		expect(subscribedFeatures(sub)).not.toContain("post");
	});

	it("overrides 开启某默认关闭的特性 → 出现", () => {
		const sub = makeEmptySubscription({ sourceKey: "bilibili", externalId: "100" });
		sub.overrides = { features: { superchat: true } };
		expect(subscribedFeatures(sub)).toContain("superchat");
	});

	// 直播拆键(⑬d):旧的「周期间隔大于 0」迁成**全局**的 `features.liveStreaming = true`,而面板没有全局
	// 特性开关的界面 —— 订阅继承的基线得是真正的全局值(调用方给),不是出厂值,否则继承着全局「开」的订阅在卡片上
	// 显示成关、弹层里也关不掉。
	it("基线由调用方给:继承全局「周期开」的订阅显示出 liveStreaming;订阅自己关了就不显示", () => {
		const base = { ...DEFAULT_FEATURE_FLAGS, liveStreaming: true };
		const sub = makeEmptySubscription({ sourceKey: "bilibili", externalId: "100" });
		expect(subscribedFeatures(sub)).not.toContain("liveStreaming"); // 缺省基线 = 出厂(关)
		expect(subscribedFeatures(sub, base)).toContain("liveStreaming");
		sub.overrides = { features: { liveStreaming: false } };
		expect(subscribedFeatures(sub, base)).not.toContain("liveStreaming");
	});

	it("routing 灌满全部目标也不影响结果 —— 只看主开关,不看 routing", () => {
		const sub = makeEmptySubscription({ sourceKey: "bilibili", externalId: "100" });
		// 模拟 follow 模式加推送目标:全部 7 个特性的 routing 都塞了同一个目标。
		for (const k of Object.keys(sub.routing) as FeatureKey[]) sub.routing[k] = ["t-1"];
		// 主开关只留 post(其余默认开启的全关掉)。
		sub.overrides = { features: { liveStart: false, liveEnd: false } };
		expect(subscribedFeatures(sub)).toEqual(["post"]);
	});
});

/**
 * 切到「自定义」推送模式时,target 的 routing 应对齐订阅项生效特性 —— 而非维持
 * follow 模式灌进的全 7 项(否则自定义矩阵默认全开)。
 */
describe("routingAlignedToFeatures", () => {
	const DEFAULT_ON: FeatureKey[] = ["post", "liveStart", "liveEnd"];
	const DEFAULT_OFF: FeatureKey[] = ["membership", "superchat", "viewerChat", "viewerEnter"];

	it("follow 模式灌满全 7 项 → 对齐后只留生效特性", () => {
		const sub = makeEmptySubscription({ sourceKey: "bilibili", externalId: "100" });
		for (const k of FEATURE_KEYS) sub.routing[k] = ["t-1"];
		const routing = routingAlignedToFeatures(sub, "t-1");
		for (const k of DEFAULT_ON) expect(routing[k]).toContain("t-1");
		for (const k of DEFAULT_OFF) expect(routing[k]).not.toContain("t-1");
	});

	it("target 原本不在任何 routing → 只加进生效特性", () => {
		const sub = makeEmptySubscription({ sourceKey: "bilibili", externalId: "100" });
		const routing = routingAlignedToFeatures(sub, "t-1");
		expect(routing.post).toEqual(["t-1"]);
		expect(routing.superchat).toEqual([]);
	});

	it("跟随 overrides:开 superchat 则纳入,关 post 则剔除", () => {
		const sub = makeEmptySubscription({ sourceKey: "bilibili", externalId: "100" });
		for (const k of FEATURE_KEYS) sub.routing[k] = ["t-1"];
		sub.overrides = { features: { superchat: true, post: false } };
		const routing = routingAlignedToFeatures(sub, "t-1");
		expect(routing.superchat).toContain("t-1");
		expect(routing.post).not.toContain("t-1");
	});

	it("不影响其它 target", () => {
		const sub = makeEmptySubscription({ sourceKey: "bilibili", externalId: "100" });
		for (const k of FEATURE_KEYS) sub.routing[k] = ["t-1", "t-2"];
		const routing = routingAlignedToFeatures(sub, "t-1");
		for (const k of FEATURE_KEYS) expect(routing[k]).toContain("t-2");
	});
});

/**
 * 拓展订阅(ADR-0019 决策 9)没有 uid:颜色跟着人走、按「拓展 id + 冒号 + 外部 id」取(决策 73),
 * 名字回落到外部 id。B 站订阅照旧按 uid —— 同一位 UP 在页面上和服务端画的周报图上是同一个颜色。
 */
describe("subscriptionColor / displayName × 两支订阅", () => {
	const bili = makeEmptySubscription({ sourceKey: "bilibili", externalId: "12345" });
	const ext = makeEmptySubscription({ sourceKey: "douyin", externalId: "12345" });

	it("B 站按 uid,拓展按「拓展 id:外部 id」这一串 —— 带着冒号与拓展名,永远不等于纯数字 uid", () => {
		expect(subscriptionColor(bili)).toBe(colorFromSeed("12345"));
		expect(subscriptionColor(ext)).toBe(colorFromSeed("douyin:12345"));
	});

	it("同一个人删了再加(订阅 id 变了)→ 颜色不变", () => {
		const readded = { ...ext, id: "e-readded-0000-4000-8000-000000000009" };
		const original = { ...ext, id: "e-original-0000-4000-8000-000000000001" };
		expect(subscriptionColor(readded)).toBe(subscriptionColor(original));
	});

	it("B 站没资料 → 「UID xxx」;拓展没资料 → 外部 id(别名已退役,ADR-0021 决策 16)", () => {
		expect(displayName(bili)).toBe("UID 12345");
		expect(displayName(ext)).toBe("12345");
	});
});
