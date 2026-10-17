/**
 * 覆盖 buildLiveSubViewSingle 的视图形状。
 *
 * 直播视图:「无 per-UP override 时不伪装全局值」—— 此前从 `eff = resolve(sub, globals.defaults)` 派生
 * 直播封面 / aiOverride 字段并硬写成启用,即便用户没设 per-UP override 也写满视图;直播监听器是
 * add 时的快照,全局改动 hot-reload 后永远沿用旧值。修复后只有 sub.overrides 真存在时才生成对应字段。
 *
 * 动态那一半的名单(启用的才列、别的来源不列、全局开关与订阅覆盖谁压谁)搬去了
 * `subscriptions/__tests__/source-subscriptions.test.ts`。
 */
import {
	type ImageRef,
	makeDefaultGlobalConfig,
	makeEmptySubscription,
	type Subscription,
} from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { buildLiveSubViewSingle } from "../engines";
import type { SubRuntimeStore } from "../sub-runtime-store";

const fakeRuntimeStore = (): SubRuntimeStore =>
	({
		get: () => undefined,
		// biome-ignore lint/suspicious/noExplicitAny: 测试只用 get,其余方法不触发
	}) as any;

const makeSub = (overrides: Subscription["overrides"] = {}): Subscription => ({
	...makeEmptySubscription({
		id: "11111111-1111-1111-1111-111111111111",
		identity: { sourceKey: "bilibili", externalId: "12345" },
	}),
	enabled: true,
	overrides,
});

describe("buildLiveSubViewSingle — 不伪装全局值", () => {
	it("无 per-UP override → liveCoverImageIds 是 undefined,aiOverride 也是 undefined", () => {
		const sub = makeSub({});
		const view = buildLiveSubViewSingle(sub, fakeRuntimeStore(), makeDefaultGlobalConfig());
		expect(view.liveCoverImageIds).toBeUndefined();
		expect(view.aiOverride).toBeUndefined();
	});

	it("仅设 cards override → liveCoverImageIds 原样给出,aiOverride 仍 undefined", () => {
		const sub = makeSub({
			cards: { liveCoverImageIds: ["up-cover.png"] },
		});
		const view = buildLiveSubViewSingle(sub, fakeRuntimeStore(), makeDefaultGlobalConfig());
		expect(view.liveCoverImageIds).toEqual(["up-cover.png"]);
		expect(view.aiOverride).toBeUndefined();
	});

	it("订阅把直播封面设成空列表 → 也是覆盖(这位 UP 不用自定义封面):给出的是空列表,不是 undefined", () => {
		// 验红:把 liveWorkSettings 里的 `liveCoverImageIds` 改成按长度折(空列表给 undefined),空列表被当成没设,这条红。
		const view = buildLiveSubViewSingle(
			makeSub({ cards: { liveCoverImageIds: [] } }),
			fakeRuntimeStore(),
			makeDefaultGlobalConfig(),
		);
		expect(view.liveCoverImageIds).toEqual([]);
	});

	it("仅设 ai override → aiOverride 有值,liveCoverImageIds 不影响", () => {
		const sub = makeSub({ ai: { preset: "inherit" } });
		const view = buildLiveSubViewSingle(sub, fakeRuntimeStore(), makeDefaultGlobalConfig());
		expect(view.aiOverride).toBeDefined();
		expect(view.liveCoverImageIds).toBeUndefined();
	});

	it("无 per-UP 模板 override → customLiveMsg 始终下发全局默认三段(无开关,对齐 liveSummary)", () => {
		const sub = makeSub({});
		const g = makeDefaultGlobalConfig();
		const view = buildLiveSubViewSingle(sub, fakeRuntimeStore(), g);
		expect(view.customLiveMsg).toEqual({
			enable: true,
			customLiveStart: g.defaults.templates.liveStart,
			customLiveStreaming: g.defaults.templates.liveStreaming,
			customLiveEnd: g.defaults.templates.liveEnd,
		});
	});

	it("设 per-UP liveStart override → customLiveStart 用 override 值,其余回退全局", () => {
		const sub = makeSub({ templates: { liveStart: "自定义开播文案 {name}" } });
		const g = makeDefaultGlobalConfig();
		const view = buildLiveSubViewSingle(sub, fakeRuntimeStore(), g);
		expect(view.customLiveMsg).toEqual({
			enable: true,
			customLiveStart: "自定义开播文案 {name}",
			customLiveStreaming: g.defaults.templates.liveStreaming,
			customLiveEnd: g.defaults.templates.liveEnd,
		});
	});
});

/**
 * 回归守卫 —— 上舰自定义的三档文案**各自**下发。
 *
 * 此前这一步只把 `guardBuy.captain.template` 当成唯一一条文案往下传(图片倒是三档
 * 各传各的),面板上给提督 / 总督写的专属文案运行时从来不读,有人上总督推出去的
 * 是舰长那句。三档写成三句不同的话,少传一档、传串一档都会红。
 * ㉓d 起文案按体系存,宿主把生效值里 B 站的体系(`guard`)那一份整份下发:`enabled`、体系默认、按档 key 存的覆盖。
 */
describe("buildLiveSubViewSingle — 上舰自定义的文案按体系整份下发", () => {
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
		const view = buildLiveSubViewSingle(
			makeSub({ templates: { membership: { guard } } }),
			fakeRuntimeStore(),
			makeDefaultGlobalConfig(),
		);
		expect(view.guardTemplate).toEqual(guard);
	});

	it("无 per-UP 覆盖 → 视图带上全局的体系文案", () => {
		const g = makeDefaultGlobalConfig();
		g.defaults.templates.membership.guard = guard;
		const view = buildLiveSubViewSingle(makeSub({}), fakeRuntimeStore(), g);
		expect(view.guardTemplate).toEqual(guard);
	});

	it("两边都没动 → 出厂那份:自定义关着,体系默认是「{viewer} 成为了 {name} 的{tier}！」", () => {
		const view = buildLiveSubViewSingle(makeSub({}), fakeRuntimeStore(), makeDefaultGlobalConfig());
		expect(view.guardTemplate).toEqual({
			enabled: false,
			default: { template: "{viewer} 成为了 {name} 的{tier}！", imageUrl: "" },
			tiers: {},
		});
	});
});

/**
 * ㉓d:醒目留言与会员的门槛从 `filters` 搬成 `superchat.minAmount` 与 `membership.minRank`。宿主把**折好的生效值**下发:
 * 覆盖有就用覆盖(0 也算),会员门槛取生效值里 B 站那一项(`guard`);都没配就是没配(不设门槛)。
 */
describe("buildLiveSubViewSingle — 两个直播门槛", () => {
	it("全局与覆盖都没配 → 两个门槛都是 undefined(不设门槛)", () => {
		const view = buildLiveSubViewSingle(makeSub({}), fakeRuntimeStore(), makeDefaultGlobalConfig());
		expect(view.minSuperchatAmount).toBeUndefined();
		expect(view.minGuardRank).toBeUndefined();
	});

	it("无 per-UP 覆盖 → 下发全局的门槛", () => {
		const g = makeDefaultGlobalConfig();
		g.defaults.superchat = { minAmount: 30 };
		g.defaults.membership = { minRank: { guard: 2 } };
		const view = buildLiveSubViewSingle(makeSub({}), fakeRuntimeStore(), g);
		expect(view.minSuperchatAmount).toBe(30);
		expect(view.minGuardRank).toBe(2);
	});

	it("per-UP 覆盖盖掉全局:金额写 0 = 这个订阅不设门槛(盖掉全局的 30),会员 rank 1 = 全推(盖掉全局的 2)", () => {
		const g = makeDefaultGlobalConfig();
		g.defaults.superchat = { minAmount: 30 };
		g.defaults.membership = { minRank: { guard: 2 } };
		const view = buildLiveSubViewSingle(
			makeSub({ superchat: { minAmount: 0 }, membership: { minRank: { guard: 1 } } }),
			fakeRuntimeStore(),
			g,
		);
		expect(view.minSuperchatAmount).toBe(0);
		expect(view.minGuardRank).toBe(1);
	});

	it("会员门槛按体系合并:订阅只覆盖了别的体系,B 站这一项仍取全局的", () => {
		const g = makeDefaultGlobalConfig();
		g.defaults.membership = { minRank: { guard: 3 } };
		const view = buildLiveSubViewSingle(
			makeSub({ membership: { minRank: { other: 2 } } }),
			fakeRuntimeStore(),
			g,
		);
		expect(view.minGuardRank).toBe(3);
	});
});

describe("直播订阅视图不抄头像(3a-35):头像由核心出卡时按订阅 id 现读", () => {
	const avatar = `${"b".repeat(64)}.jpg` as ImageRef;
	const runtime = {
		get: () => ({ cachedProfile: { name: "UP", avatar } }),
	} as unknown as SubRuntimeStore;

	// 验红:往两份视图里抄回 avatar,这条红。
	it("资料里有头像也不抄进直播视图(抄了就是开机快照,之后补上的头像永远跟不上)", () => {
		const liveView = buildLiveSubViewSingle(makeSub(), runtime, makeDefaultGlobalConfig());
		expect(liveView).not.toHaveProperty("avatar");
	});
});
