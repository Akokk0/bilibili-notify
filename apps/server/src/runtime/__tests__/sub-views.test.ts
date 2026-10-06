/**
 * 覆盖 buildDynamicSubsView / buildLiveSubViewSingle 的「无 per-UP override 时
 * 不伪装全局值」语义。背景:此前两个函数从 `eff = resolve(sub, globals.defaults)`
 * 派生 customCardStyle / aiOverride 字段并硬写 `enable: true`,即便用户没设
 * per-UP override 也写满 SubItemView。dynamic 端 dynamicSubManager 是 add 时
 * 的快照(没有 refreshOps 周期同步),导致全局 cardStyle / ai 改动 hot-reload
 * 后 dynamic 推送永远沿用 add 时的旧值,bypass `imageRenderer.config` /
 * `commentary.config` 的全局兜底。
 *
 * 修复后:只有 sub.overrides.cardStyle / sub.overrides.ai / sub.overrides.filters
 * 真存在时才生成对应字段;无 override 时分别留 `{ enable: false }` / `undefined`。
 * engine 推送路径(dynamic-engine 卡片 / room-helpers 直播卡 / commentary)看到
 * undefined 自动走 this.config 兜底,跟全局 hot-reload 立即同步。
 */
import {
	type GlobalConfig,
	makeDefaultGlobalConfig,
	makeEmptySubscription,
	type Subscription,
} from "@bilibili-notify/internal";
import type { SubscriptionStore } from "@bilibili-notify/subscription";
import { describe, expect, it } from "vite-plus/test";
import { buildDynamicSubsView, buildLiveSubViewSingle } from "../engines";
import type { SubRuntimeStore } from "../sub-runtime-store";

const fakeRuntimeStore = (): SubRuntimeStore =>
	({
		get: () => undefined,
		// biome-ignore lint/suspicious/noExplicitAny: 测试只用 get,其余方法不触发
	}) as any;

const fakeStore = (subs: Subscription[]): SubscriptionStore =>
	({
		list: () => subs,
		// biome-ignore lint/suspicious/noExplicitAny: 测试只用 list
	}) as any;

const makeSub = (overrides: Subscription["overrides"] = {}): Subscription => ({
	...makeEmptySubscription({
		id: "11111111-1111-1111-1111-111111111111",
		identity: { sourceKey: "bilibili", externalId: "12345" },
	}),
	enabled: true,
	overrides,
});

describe("buildDynamicSubsView — 不伪装全局值", () => {
	it("无 per-UP override → customCardStyle.enable=false,aiOverride/filter 都是 undefined", () => {
		const sub = makeSub({});
		const view = buildDynamicSubsView(
			fakeStore([sub]),
			fakeRuntimeStore(),
			makeDefaultGlobalConfig(),
		);
		expect(view["12345"]).toBeDefined();
		expect(view["12345"]?.customCardStyle).toEqual({ enable: false });
		expect(view["12345"]?.aiOverride).toBeUndefined();
		expect(view["12345"]?.filter).toBeUndefined();
	});

	it("订阅设了直播封面 → 作品卡不读它:customCardStyle 仍是 enable:false,aiOverride/filter 仍 undefined", () => {
		// 卡片设置只剩直播封面,而作品(动态)卡不出封面;样式覆盖一律「没有」,渲染器逐字段回退全局。
		// 验红:让 dynamicWorkSettings 把 `overrides.cards` 折进样式,这条红。
		const sub = makeSub({ cards: { liveCoverImageIds: ["up-cover.png"] } });
		const view = buildDynamicSubsView(
			fakeStore([sub]),
			fakeRuntimeStore(),
			makeDefaultGlobalConfig(),
		);
		expect(view["12345"]?.customCardStyle).toEqual({ enable: false });
		expect(view["12345"]?.aiOverride).toBeUndefined();
		expect(view["12345"]?.filter).toBeUndefined();
	});

	it("仅设 ai override → aiOverride 有值(eff.ai 派生),customCardStyle/filter 不影响", () => {
		const sub = makeSub({ ai: { preset: "inherit" } });
		const view = buildDynamicSubsView(
			fakeStore([sub]),
			fakeRuntimeStore(),
			makeDefaultGlobalConfig(),
		);
		expect(view["12345"]?.aiOverride).toBeDefined();
		expect(view["12345"]?.customCardStyle).toEqual({ enable: false });
		expect(view["12345"]?.filter).toBeUndefined();
	});

	it("改全局 globals.defaults.cards → 无 per-UP override 的 sub 的 customCardStyle 保持 enable:false(不会把全局值塞进去)", () => {
		const sub = makeSub({});
		const globals: GlobalConfig = makeDefaultGlobalConfig();
		globals.defaults.cards.liveCoverImageIds = ["global.png"];
		const view = buildDynamicSubsView(fakeStore([sub]), fakeRuntimeStore(), globals);
		// 关键断言:全局值改了,但因为 sub 没 per-UP override,customCardStyle 仍是
		// {enable:false},不带任何样式字段。下游 ImageRenderer 走 this.config
		// 兜底,this.config 已被 hot-reload 路径(imageRenderer.updateConfig)同步。
		expect(view["12345"]?.customCardStyle).toEqual({ enable: false });
	});
});

describe("buildLiveSubViewSingle — 不伪装全局值", () => {
	it("无 per-UP override → customCardStyle.enable=false,aiOverride 是 undefined", () => {
		const sub = makeSub({});
		const view = buildLiveSubViewSingle(sub, fakeRuntimeStore(), makeDefaultGlobalConfig());
		expect(view.customCardStyle).toEqual({ enable: false });
		expect(view.aiOverride).toBeUndefined();
	});

	it("仅设 cards override → customCardStyle.enable=true,aiOverride 仍 undefined", () => {
		const sub = makeSub({
			cards: { liveCoverImageIds: ["up-cover.png"] },
		});
		const view = buildLiveSubViewSingle(sub, fakeRuntimeStore(), makeDefaultGlobalConfig());
		expect(view.customCardStyle).toEqual({
			enable: true,
			liveCoverImage: "up-cover.png",
			liveCoverImages: ["up-cover.png"],
		});
		expect(view.aiOverride).toBeUndefined();
	});

	it("订阅把直播封面设成空列表 → 也是覆盖(这位 UP 不用自定义封面):enable:true、封面为空", () => {
		// 验红:把 liveWorkSettings 里的 `?.liveCoverImageIds ?` 判断改成看长度,空列表被当成没设,这条红。
		const view = buildLiveSubViewSingle(
			makeSub({ cards: { liveCoverImageIds: [] } }),
			fakeRuntimeStore(),
			makeDefaultGlobalConfig(),
		);
		expect(view.customCardStyle).toMatchObject({ enable: true, liveCoverImages: [] });
	});

	it("仅设 ai override → aiOverride 有值,customCardStyle 不影响", () => {
		const sub = makeSub({ ai: { preset: "inherit" } });
		const view = buildLiveSubViewSingle(sub, fakeRuntimeStore(), makeDefaultGlobalConfig());
		expect(view.aiOverride).toBeDefined();
		expect(view.customCardStyle).toEqual({ enable: false });
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
