import { describe, expect, it } from "vitest";
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
});
