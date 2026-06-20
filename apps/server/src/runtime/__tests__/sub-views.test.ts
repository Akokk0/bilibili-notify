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
		uid: "12345",
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

	it("仅设 cardStyle override → customCardStyle.enable=true 且带 per-UP 颜色,aiOverride/filter 仍 undefined", () => {
		const sub = makeSub({
			cardStyle: { cardColorStart: "#aaa", cardColorEnd: "#bbb" },
		});
		const view = buildDynamicSubsView(
			fakeStore([sub]),
			fakeRuntimeStore(),
			makeDefaultGlobalConfig(),
		);
		expect(view["12345"]?.customCardStyle).toEqual({
			enable: true,
			cardColorStart: "#aaa",
			cardColorEnd: "#bbb",
		});
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

	it("改全局 globals.defaults.cardStyle 颜色 → 无 per-UP override 的 sub 的 customCardStyle 保持 enable:false(不会把全局值塞进去)", () => {
		const sub = makeSub({});
		const globals: GlobalConfig = makeDefaultGlobalConfig();
		globals.defaults.cardStyle.cardColorStart = "#changed";
		const view = buildDynamicSubsView(fakeStore([sub]), fakeRuntimeStore(), globals);
		// 关键断言:全局值改了,但因为 sub 没 per-UP override,customCardStyle 仍是
		// {enable:false},不带任何 cardColor 字段。下游 ImageRenderer 走 this.config
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

	it("仅设 cardStyle override → customCardStyle.enable=true,aiOverride 仍 undefined", () => {
		const sub = makeSub({
			cardStyle: { cardColorStart: "#aaa", cardColorEnd: "#bbb" },
		});
		const view = buildLiveSubViewSingle(sub, fakeRuntimeStore(), makeDefaultGlobalConfig());
		expect(view.customCardStyle).toEqual({
			enable: true,
			cardColorStart: "#aaa",
			cardColorEnd: "#bbb",
		});
		expect(view.aiOverride).toBeUndefined();
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
			customLive: g.defaults.templates.liveOngoing,
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
			customLive: g.defaults.templates.liveOngoing,
			customLiveEnd: g.defaults.templates.liveEnd,
		});
	});
});
