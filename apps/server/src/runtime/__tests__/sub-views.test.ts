import {
	makeDefaultGlobalConfig,
	makeEmptySubscription,
	type Subscription,
} from "@bilibili-notify/internal";
import { templateDefaultsFor } from "@bilibili-notify/internal/texts/builtin";
import { describe, expect, it } from "vite-plus/test";
import { liveSettingsOf } from "../../live/live-settings.js";

const ZH = templateDefaultsFor("zh-CN");

const makeSub = (overrides: Subscription["overrides"] = {}): Subscription => ({
	...makeEmptySubscription({
		id: "11111111-1111-1111-1111-111111111111",
		identity: { sourceKey: "bilibili", externalId: "12345" },
	}),
	enabled: true,
	overrides,
});

describe("liveSettingsOf — 不伪装全局值", () => {
	it("无 per-UP override → liveCoverImageIds 是 undefined,aiOverride 也是 undefined", () => {
		const view = liveSettingsOf(makeSub(), makeDefaultGlobalConfig());
		expect(view.liveCoverImageIds).toBeUndefined();
		expect(view.aiOverride).toBeUndefined();
	});

	it("仅设 cards override → liveCoverImageIds 原样给出,aiOverride 仍 undefined", () => {
		const view = liveSettingsOf(
			makeSub({ cards: { liveCoverImageIds: ["up-cover.png"] } }),
			makeDefaultGlobalConfig(),
		);
		expect(view.liveCoverImageIds).toEqual(["up-cover.png"]);
		expect(view.aiOverride).toBeUndefined();
	});

	it("订阅把直播封面设成空列表 → 也是覆盖(这位 UP 不用自定义封面):给出的是空列表,不是 undefined", () => {
		const view = liveSettingsOf(
			makeSub({ cards: { liveCoverImageIds: [] } }),
			makeDefaultGlobalConfig(),
		);
		expect(view.liveCoverImageIds).toEqual([]);
	});

	it("仅设 ai override → aiOverride 有值,liveCoverImageIds 不影响", () => {
		const view = liveSettingsOf(makeSub({ ai: { preset: "inherit" } }), makeDefaultGlobalConfig());
		expect(view.aiOverride).toBeDefined();
		expect(view.liveCoverImageIds).toBeUndefined();
	});

	it("无 per-UP 模板 override → customLiveMsg 始终下发全局默认三段(无开关,对齐 liveSummary)", () => {
		const g = makeDefaultGlobalConfig();
		const view = liveSettingsOf(makeSub(), g);
		expect(view.customLiveMsg).toEqual({
			customLiveStart: ZH.liveStart,
			customLiveStreaming: ZH.liveStreaming,
			customLiveEnd: ZH.liveEnd,
		});
	});

	it("设 per-UP liveStart override → customLiveStart 用 override 值,其余回退全局", () => {
		const g = makeDefaultGlobalConfig();
		const view = liveSettingsOf(makeSub({ templates: { liveStart: "自定义开播文案 {name}" } }), g);
		expect(view.customLiveMsg).toEqual({
			customLiveStart: "自定义开播文案 {name}",
			customLiveStreaming: ZH.liveStreaming,
			customLiveEnd: ZH.liveEnd,
		});
	});
});

describe("liveSettingsOf — 上舰自定义的文案按体系整份下发", () => {
	const guard = {
		enabled: true,
		default: { template: "默认那句 {viewer}", imageUrl: "" },
		tiers: {
			captain: { template: "舰长那句 {viewer}", imageUrl: "cap.png" },
			commander: { template: "提督那句 {viewer}", imageUrl: "com.png" },
			governor: { template: "总督那句 {viewer}", imageUrl: "gov.png" },
		},
	};

	it("per-UP 覆盖了会员文案 → 视图带上该 UP 的体系文案(默认 + 三档)", () => {
		const view = liveSettingsOf(
			makeSub({ templates: { membership: { guard } } }),
			makeDefaultGlobalConfig(),
		);
		expect(view.membershipTemplates("guard")).toEqual(guard);
	});

	it("无 per-UP 覆盖 → 视图带上全局的体系文案", () => {
		const g = makeDefaultGlobalConfig();
		g.defaults.templates.membership.guard = guard;
		expect(liveSettingsOf(makeSub(), g).membershipTemplates("guard")).toEqual(guard);
	});

	it("两边都没动 → 出厂那份:自定义关着,体系默认是「{viewer} 成为了 {name} 的{tier}！」", () => {
		expect(
			liveSettingsOf(makeSub(), makeDefaultGlobalConfig()).membershipTemplates("guard"),
		).toEqual({
			enabled: false,
			default: { template: "{viewer} 成为了 {name} 的{tier}！", imageUrl: "" },
			tiers: {},
		});
	});
});

describe("liveSettingsOf — 两个直播门槛", () => {
	it("全局与覆盖都没配 → 两个门槛都是 undefined(不设门槛)", () => {
		const view = liveSettingsOf(makeSub(), makeDefaultGlobalConfig());
		expect(view.minSuperchatAmount).toBeUndefined();
		expect(view.membershipMinRank.guard).toBeUndefined();
	});

	it("无 per-UP 覆盖 → 下发全局的门槛", () => {
		const g = makeDefaultGlobalConfig();
		g.defaults.superchat = { minAmount: 30 };
		g.defaults.membership = { minRank: { guard: 2 } };
		const view = liveSettingsOf(makeSub(), g);
		expect(view.minSuperchatAmount).toBe(30);
		expect(view.membershipMinRank.guard).toBe(2);
	});

	it("per-UP 覆盖盖掉全局:金额写 0 = 这个订阅不设门槛(盖掉全局的 30),会员 rank 1 = 全推(盖掉全局的 2)", () => {
		const g = makeDefaultGlobalConfig();
		g.defaults.superchat = { minAmount: 30 };
		g.defaults.membership = { minRank: { guard: 2 } };
		const view = liveSettingsOf(
			makeSub({ superchat: { minAmount: 0 }, membership: { minRank: { guard: 1 } } }),
			g,
		);
		expect(view.minSuperchatAmount).toBe(0);
		expect(view.membershipMinRank.guard).toBe(1);
	});

	it("会员门槛按体系合并:订阅只覆盖了别的体系,B 站这一项仍取全局的", () => {
		const g = makeDefaultGlobalConfig();
		g.defaults.membership = { minRank: { guard: 3 } };
		const view = liveSettingsOf(makeSub({ membership: { minRank: { other: 2 } } }), g);
		expect(view.membershipMinRank.guard).toBe(3);
	});
});

describe("直播订阅视图不抄头像(3a-35):头像由核心出卡时按订阅 id 现读", () => {
	it("资料里有头像也不抄进直播视图(抄了就是开机快照,之后补上的头像永远跟不上)", () => {
		expect(liveSettingsOf(makeSub(), makeDefaultGlobalConfig())).not.toHaveProperty("avatar");
	});
});
