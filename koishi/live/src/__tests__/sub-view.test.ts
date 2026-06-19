/**
 * 单元测试 — koishi/live 的 SubItemView 折算(sub-view.ts)。
 *
 * 核心不变量:
 *   - storeToSubItemView 把 per-UP override 与 live 插件 config 折成「两层」——
 *     per-UP 缺失则回退 config;`??` 作用在原始 override 上,per-UP 的 false / 0
 *     等假值不会被 config 真值吃掉(这是之前 restartPush bug 的根因)。
 *   - features 走静态默认 DEFAULT_FEATURE_FLAGS ?? per-UP(koishi 端无全局 features 配置)。
 *   - buildAiOverride 仅在有真正 per-UP AI 覆盖时产出;否则 undefined,直播总结
 *     交给 AI 引擎用自身插件 config。
 */

import {
	DEFAULT_FEATURE_FLAGS,
	makeEmptySubscription,
	type Subscription,
} from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import type { BilibiliNotifyLiveConfig } from "../config";
import { buildAiOverride, resolveFeatures, storeToLiveView, storeToSubItemView } from "../sub-view";

function makeConfig(over: Partial<BilibiliNotifyLiveConfig> = {}): BilibiliNotifyLiveConfig {
	return {
		logLevel: 1,
		pushTime: 4,
		restartPush: true,
		minScPrice: 30,
		minGuardLevel: 2,
		liveSummary: [],
		customGuardBuy: { enable: false },
		customLiveMsg: { enable: false },
		...over,
	};
}

function makeSub(overrides: Subscription["overrides"] = {}): Subscription {
	const sub = makeEmptySubscription({ id: "00000000-0000-4000-8000-000000000000", uid: "123" });
	sub.overrides = overrides;
	return sub;
}

describe("resolveFeatures", () => {
	it("无 per-UP override → 全部取静态默认 DEFAULT_FEATURE_FLAGS", () => {
		expect(resolveFeatures(makeSub())).toEqual(DEFAULT_FEATURE_FLAGS);
	});

	it("per-UP 部分覆盖 → 覆盖项生效,其余仍取默认", () => {
		const f = resolveFeatures(makeSub({ features: { live: false, superchat: true } }));
		expect(f.live).toBe(false);
		expect(f.superchat).toBe(true);
		expect(f.dynamic).toBe(DEFAULT_FEATURE_FLAGS.dynamic);
	});
});

describe("storeToSubItemView — per-UP override ?? config 两层折算", () => {
	it("无 per-UP override → 阈值 / 调度全部回退到 live config", () => {
		const view = storeToSubItemView(makeSub(), makeConfig());
		expect(view.minScPrice).toBe(30);
		expect(view.minGuardLevel).toBe(2);
		expect(view.pushTime).toBe(4);
		expect(view.restartPush).toBe(true);
	});

	it("per-UP override 命中 → 优先用 per-UP 值(含 false / 0 等假值)", () => {
		const view = storeToSubItemView(
			makeSub({
				filters: { minScPrice: 0, minGuardLevel: 3 },
				schedule: { pushTime: 0, restartPush: false },
			}),
			makeConfig(),
		);
		// 关键回归守卫:per-UP 的 false / 0 不能被 config 的真值吃掉。
		expect(view.minScPrice).toBe(0);
		expect(view.minGuardLevel).toBe(3);
		expect(view.pushTime).toBe(0);
		expect(view.restartPush).toBe(false);
	});

	it("per-UP 部分覆盖 → 覆盖项用 per-UP,缺失项回退 config", () => {
		const view = storeToSubItemView(
			makeSub({ schedule: { restartPush: false } }),
			makeConfig({ pushTime: 4, restartPush: true }),
		);
		expect(view.restartPush).toBe(false); // per-UP 命中
		expect(view.pushTime).toBe(4); // config 回退
	});

	it("features 写进 SubItemView 的布尔开关字段", () => {
		const view = storeToSubItemView(makeSub({ features: { live: false } }), makeConfig());
		expect(view.live).toBe(false);
		expect(view.liveEnd).toBe(DEFAULT_FEATURE_FLAGS.liveEnd);
	});

	it("默认关闭的直播收入类 feature 可由 per-UP overrides.features 开启", () => {
		expect(DEFAULT_FEATURE_FLAGS.superchat).toBe(false);
		expect(DEFAULT_FEATURE_FLAGS.liveGuardBuy).toBe(false);

		const view = storeToSubItemView(
			makeSub({ features: { superchat: true, liveGuardBuy: true } }),
			makeConfig(),
		);
		expect(view.superchat).toBe(true);
		expect(view.liveGuardBuy).toBe(true);
	});

	it("无任何 custom override → 各 customX 块 enable:false", () => {
		const view = storeToSubItemView(makeSub(), makeConfig());
		expect(view.customCardStyle).toEqual({ enable: false });
		expect(view.customLiveMsg).toEqual({ enable: false });
		expect(view.customGuardBuy).toEqual({ enable: false });
		expect(view.customLiveSummary).toEqual({ enable: false });
		expect(view.customSpecialDanmakuUsers).toEqual({ enable: false, msgTemplate: "" });
		expect(view.customSpecialUsersEnterTheRoom).toEqual({ enable: false, msgTemplate: "" });
		expect(view.aiOverride).toBeUndefined();
	});

	it("cardStyle override → customCardStyle.enable:true 并带颜色", () => {
		const view = storeToSubItemView(
			makeSub({ cardStyle: { cardColorStart: "#111", cardColorEnd: "#222" } }),
			makeConfig(),
		);
		expect(view.customCardStyle).toEqual({
			enable: true,
			cardColorStart: "#111",
			cardColorEnd: "#222",
		});
	});

	it("specialUsers 按 kind 拆分进 danmaku / enter 两块", () => {
		const sub = makeSub({
			templates: { specialDanmaku: "弹幕模板", specialUserEnter: "进房模板" },
		});
		sub.specialUsers = [
			{ uid: "111", kinds: ["danmaku"] },
			{ uid: "222", kinds: ["enter"] },
			{ uid: "333", kinds: ["danmaku", "enter"] },
		];
		const view = storeToSubItemView(sub, makeConfig());
		expect(view.customSpecialDanmakuUsers).toEqual({
			enable: true,
			specialDanmakuUsers: ["111", "333"],
			msgTemplate: "弹幕模板",
		});
		expect(view.customSpecialUsersEnterTheRoom).toEqual({
			enable: true,
			specialUsersEnterTheRoom: ["222", "333"],
			msgTemplate: "进房模板",
		});
	});
});

describe("buildAiOverride", () => {
	it("无 per-UP AI 覆盖 → undefined(直播总结走 AI 引擎自身 config)", () => {
		expect(buildAiOverride(undefined)).toBeUndefined();
		expect(storeToSubItemView(makeSub(), makeConfig()).aiOverride).toBeUndefined();
	});

	it("preset='inherit' → undefined", () => {
		expect(buildAiOverride({ preset: "inherit" })).toBeUndefined();
	});

	it("per-UP custom persona → 翻译成 CommentaryCallOverride(preset 固定 custom)", () => {
		const ov = buildAiOverride({
			preset: "custom",
			persona: {
				name: "凛子",
				addressUser: "笨蛋",
				addressSelf: "本小姐",
				traits: "傲娇",
				catchphrase: "哼",
				baseRole: "傲娇 AI",
				extraSystemPrompt: "毒舌",
			},
			temperature: 1.2,
		});
		expect(ov?.persona?.preset).toBe("custom");
		expect(ov?.persona?.name).toBe("凛子");
		expect(ov?.persona?.customBase).toBe("傲娇 AI"); // baseRole → customBase
		expect(ov?.persona?.extraPrompt).toBe("毒舌"); // extraSystemPrompt → extraPrompt
		expect(ov?.temperature).toBe(1.2);
		expect(ov?.dynamicPrompt).toBeUndefined(); // 未填 → 不带,由引擎 config 兜底
	});

	it("custom 但无 persona → override 不含 persona(persona 字段省略)", () => {
		// AIOverride.persona 是 optional;preset='custom' 但 persona 缺失时
		// 只产出 prompt / temperature 字段,persona 走引擎 config 兜底。
		const ov = buildAiOverride({ preset: "custom", dynamicPrompt: "动态提示" });
		expect(ov).toBeDefined();
		expect(ov?.persona).toBeUndefined();
		expect(ov?.dynamicPrompt).toBe("动态提示");
	});

	it("dynamicPrompt / liveSummaryPrompt 显式填值 → 原样带上", () => {
		const ov = buildAiOverride({
			preset: "custom",
			dynamicPrompt: "动态",
			liveSummaryPrompt: "总结",
		});
		expect(ov?.dynamicPrompt).toBe("动态");
		expect(ov?.liveSummaryPrompt).toBe("总结");
	});

	it("dynamicPrompt 显式为空字符串 → 仍带上(空串 !== undefined,不被吃掉)", () => {
		// `aiOv.dynamicPrompt !== undefined` 守卫 —— 空字符串是显式值,应保留。
		const ov = buildAiOverride({ preset: "custom", dynamicPrompt: "" });
		expect(ov?.dynamicPrompt).toBe("");
	});

	it("preset 取任意具名 preset.id(非 inherit/custom)→ 仍翻译产出 override", () => {
		// koishi 端 convert.ts 恒写 preset:"custom",但 schema 允许任意字符串;
		// buildAiOverride 只对 'inherit' 短路,其余一律产出 override。
		const ov = buildAiOverride({ preset: "tsundere", temperature: 0.8 });
		expect(ov).toBeDefined();
		expect(ov?.temperature).toBe(0.8);
	});
});

describe("storeToLiveView", () => {
	it("跳过 disabled 订阅,只折算 enabled 的", () => {
		const a = makeSub();
		a.uid = "1";
		const b = makeSub();
		b.uid = "2";
		b.enabled = false;
		const view = storeToLiveView({ list: () => [a, b] }, makeConfig());
		expect(Object.keys(view)).toEqual(["1"]);
	});
});
