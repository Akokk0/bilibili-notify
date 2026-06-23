import { describe, expect, it } from "vite-plus/test";
import { makeDefaultGlobalConfig } from "./globals";
import { resolve } from "./resolve";
import { makeEmptySubscription, type Subscription } from "./subscriptions";

const SUB_BASE: Subscription = makeEmptySubscription({
	id: "11111111-1111-1111-1111-111111111111",
	uid: "12345",
});

describe("resolve()", () => {
	it("inherits all defaults when overrides are empty", () => {
		const globals = makeDefaultGlobalConfig();
		const eff = resolve(SUB_BASE, globals.defaults);

		expect(eff.features).toEqual(globals.defaults.features);
		expect(eff.filters).toEqual(globals.defaults.filters);
		expect(eff.schedule).toEqual(globals.defaults.schedule);
		expect(eff.cardStyle).toEqual(globals.defaults.cardStyle);
		expect(eff.ai.model).toBe(globals.defaults.ai.model);
		expect(eff.ai.persona).toEqual(globals.defaults.ai.persona);
	});

	it("inherits global wordcloudStopWords when no per-UP override", () => {
		const globals = makeDefaultGlobalConfig();
		globals.defaults.templates.wordcloudStopWords = "全局,词";
		const eff = resolve(SUB_BASE, globals.defaults);
		expect(eff.templates.wordcloudStopWords).toBe("全局,词");
	});

	it("per-UP wordcloudStopWords override replaces global", () => {
		const globals = makeDefaultGlobalConfig();
		globals.defaults.templates.wordcloudStopWords = "全局,词";
		const sub: Subscription = {
			...SUB_BASE,
			overrides: { templates: { wordcloudStopWords: "仅本UP" } },
		};
		const eff = resolve(sub, globals.defaults);
		expect(eff.templates.wordcloudStopWords).toBe("仅本UP");
	});

	it("merges partial features override on top of defaults", () => {
		const globals = makeDefaultGlobalConfig();
		const sub: Subscription = {
			...SUB_BASE,
			overrides: {
				features: { live: false, liveEnd: true },
			},
		};
		const eff = resolve(sub, globals.defaults);

		expect(eff.features.live).toBe(false);
		expect(eff.features.liveEnd).toBe(true);
		expect(eff.features.dynamic).toBe(globals.defaults.features.dynamic);
	});

	it("AI override 'inherit' returns base ai unchanged", () => {
		const globals = makeDefaultGlobalConfig();
		const sub: Subscription = {
			...SUB_BASE,
			overrides: { ai: { preset: "inherit" } },
		};
		const eff = resolve(sub, globals.defaults);
		expect(eff.ai.persona).toEqual(globals.defaults.ai.persona);
		expect(eff.ai.dynamicPrompt).toBe(globals.defaults.ai.dynamicPrompt);
	});

	it("AI override 'custom' uses provided persona but inherits missing fields", () => {
		const globals = makeDefaultGlobalConfig();
		const customPersona = {
			name: "助手",
			addressUser: "您",
			addressSelf: "助手",
			traits: "专业",
			catchphrase: "请稍候",
			baseRole: "",
			extraSystemPrompt: "",
		};
		const sub: Subscription = {
			...SUB_BASE,
			overrides: {
				ai: {
					preset: "custom",
					persona: customPersona,
					temperature: 1.5,
				},
			},
		};
		const eff = resolve(sub, globals.defaults);

		expect(eff.ai.persona).toEqual(customPersona);
		expect(eff.ai.temperature).toBe(1.5);
		// dynamicPrompt 没显式覆盖 → 继承全局
		expect(eff.ai.dynamicPrompt).toBe(globals.defaults.ai.dynamicPrompt);
	});

	it("AI override personaId 直通(与 preset 无关,inherit 时也生效;AstrBot 端用,其它端忽略)", () => {
		const globals = makeDefaultGlobalConfig();

		// preset=inherit 时 personaId 仍直通(它不是 persona 字段,不受 inherit 早返回影响)
		const subInherit: Subscription = {
			...SUB_BASE,
			overrides: { ai: { preset: "inherit", personaId: "凛子" } },
		};
		expect(resolve(subInherit, globals.defaults).ai.personaId).toBe("凛子");

		// preset=custom 时也直通
		const subCustom: Subscription = {
			...SUB_BASE,
			overrides: { ai: { preset: "custom", personaId: "分析师" } },
		};
		expect(resolve(subCustom, globals.defaults).ai.personaId).toBe("分析师");

		// 不设 → undefined(继承全局,由 sidecar 兜到 --ai-persona-id)
		expect(resolve(SUB_BASE, globals.defaults).ai.personaId).toBeUndefined();
	});

	it("AI named preset takes priority over base; missing preset falls back gracefully", () => {
		const globals = makeDefaultGlobalConfig();
		const presetPersona = {
			name: "傲娇",
			addressUser: "笨蛋",
			addressSelf: "本喵",
			traits: "毒舌",
			catchphrase: "哼",
			baseRole: "",
			extraSystemPrompt: "",
		};
		globals.defaults.ai.presets = [
			{
				id: "tsundere",
				label: "傲娇",
				persona: presetPersona,
				dynamicPrompt: "X 模板",
			},
		];

		const sub: Subscription = {
			...SUB_BASE,
			overrides: { ai: { preset: "tsundere" } },
		};
		const eff = resolve(sub, globals.defaults);
		expect(eff.ai.persona).toEqual(presetPersona);
		expect(eff.ai.dynamicPrompt).toBe("X 模板");

		// 未知 preset id 时回退到 base
		const sub2: Subscription = {
			...SUB_BASE,
			overrides: { ai: { preset: "non-existent-id" } },
		};
		const eff2 = resolve(sub2, globals.defaults);
		expect(eff2.ai.persona).toEqual(globals.defaults.ai.persona);
		expect(eff2.ai.dynamicPrompt).toBe(globals.defaults.ai.dynamicPrompt);
	});

	it("R1: 显式 override.persona 优先于具名 preset.persona(与 prompt 字段同序)", () => {
		const globals = makeDefaultGlobalConfig();
		const presetPersona = {
			name: "preset名",
			addressUser: "preset你",
			addressSelf: "preset我",
			traits: "preset特征",
			catchphrase: "preset口头禅",
			baseRole: "",
			extraSystemPrompt: "",
		};
		globals.defaults.ai.presets = [
			{ id: "tsundere", label: "傲娇", persona: presetPersona, dynamicPrompt: "P 模板" },
		];
		const overridePersona = {
			name: "我的名",
			addressUser: "我的你",
			addressSelf: "我的我",
			traits: "我的特征",
			catchphrase: "我的口头禅",
			baseRole: "",
			extraSystemPrompt: "",
		};
		const sub: Subscription = {
			...SUB_BASE,
			overrides: { ai: { preset: "tsundere", persona: overridePersona } },
		};
		const eff = resolve(sub, globals.defaults);
		// 显式 per-UP persona 必须胜过 preset 的 persona(此前被静默丢弃)。
		expect(eff.ai.persona).toEqual(overridePersona);
		// 未被 override 覆盖的 dynamicPrompt 仍取 preset —— 既有语义不回归。
		expect(eff.ai.dynamicPrompt).toBe("P 模板");
	});

	// 回归守护 — P2:resolve() 必须深隔离,消费方就地改不得污染 defaults / sub。
	describe("深隔离 (P2)", () => {
		it("改 EffectiveSubscription 的嵌套数组/对象不污染 globals.defaults", () => {
			const globals = makeDefaultGlobalConfig();
			const eff = resolve(SUB_BASE, globals.defaults);
			eff.filters.blockKeywords.push("x");
			eff.features.live = !eff.features.live;
			eff.ai.persona.name = "MUT";
			expect(globals.defaults.filters.blockKeywords).not.toContain("x");
			expect(globals.defaults.ai.persona.name).not.toBe("MUT");
		});

		it("改 EffectiveSubscription.routing 不污染原始 sub", () => {
			const globals = makeDefaultGlobalConfig();
			const eff = resolve(SUB_BASE, globals.defaults);
			eff.routing.dynamic.push("550e8400-e29b-41d4-a716-446655440000");
			expect(SUB_BASE.routing.dynamic).toHaveLength(0);
		});
	});
});
