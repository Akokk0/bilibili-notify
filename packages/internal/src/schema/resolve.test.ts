import { describe, expect, it } from "vite-plus/test";
import { resolveAIProfile } from "../constants";
import { DEFAULT_CARD_LAYOUT } from "./card-layout";
import { makeDefaultGlobalConfig } from "./globals";
import { DEFAULT_MESSAGE_LAYOUT } from "./message-layout";
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
		expect(eff.ai.model).toBe(resolveAIProfile(globals.defaults.ai).model);
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

	it("inherits global live-end grace settings when no per-UP override", () => {
		const globals = makeDefaultGlobalConfig();
		globals.defaults.schedule.liveEndGrace = true;
		globals.defaults.schedule.liveEndGraceMinutes = 5;
		const eff = resolve(SUB_BASE, globals.defaults);
		expect(eff.schedule.liveEndGrace).toBe(true);
		expect(eff.schedule.liveEndGraceMinutes).toBe(5);
	});

	it("per-UP schedule override flips live-end grace independently", () => {
		const globals = makeDefaultGlobalConfig();
		const sub: Subscription = {
			...SUB_BASE,
			overrides: { schedule: { liveEndGrace: true, liveEndGraceMinutes: 3 } },
		};
		const eff = resolve(sub, globals.defaults);
		expect(eff.schedule.liveEndGrace).toBe(true);
		expect(eff.schedule.liveEndGraceMinutes).toBe(3);
		// 未覆盖的 schedule 字段仍继承全局。
		expect(eff.schedule.pushTime).toBe(globals.defaults.schedule.pushTime);
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

	it("inherits global cardLayout when no per-UP override", () => {
		const globals = makeDefaultGlobalConfig();
		const eff = resolve(SUB_BASE, globals.defaults);
		expect(eff.cardLayout).toEqual(globals.defaults.cardLayout);
	});

	it("replaces cardLayout wholesale on per-UP override and normalizes it", () => {
		const globals = makeDefaultGlobalConfig();
		const sub: Subscription = {
			...SUB_BASE,
			overrides: {
				cardLayout: {
					...DEFAULT_CARD_LAYOUT,
					live: [
						{ id: "title", type: "title", visible: true },
						{ id: "cover", type: "cover", visible: false },
					],
				},
			},
		};
		const eff = resolve(sub, globals.defaults);
		// 整份覆盖:override 的 live 顺序生效
		expect(eff.cardLayout.live.slice(0, 2).map((b) => b.id)).toEqual(["title", "cover"]);
		expect(eff.cardLayout.live.find((b) => b.id === "cover")?.visible).toBe(false);
		// normalize:缺失的已知块仍被追加(向前兼容;data 为合并后的数据区块)
		expect(eff.cardLayout.live.map((b) => b.id)).toContain("data");
	});

	it("inherits global messageLayout when no per-UP override", () => {
		const globals = makeDefaultGlobalConfig();
		const eff = resolve(SUB_BASE, globals.defaults);
		expect(eff.messageLayout).toEqual(globals.defaults.messageLayout);
	});

	it("replaces messageLayout wholesale on per-UP override and normalizes it", () => {
		const globals = makeDefaultGlobalConfig();
		const sub: Subscription = {
			...SUB_BASE,
			overrides: {
				messageLayout: {
					...DEFAULT_MESSAGE_LAYOUT,
					dynamic: {
						blocks: [
							{ id: "text", type: "text", visible: true },
							{ id: "card", type: "card", visible: false },
						],
						separator: " | ",
					},
				},
			},
		};
		const eff = resolve(sub, globals.defaults);
		// 整份覆盖:override 的 dynamic 块序与分隔符生效
		expect(eff.messageLayout.dynamic.blocks.slice(0, 2).map((b) => b.id)).toEqual(["text", "card"]);
		expect(eff.messageLayout.dynamic.separator).toBe(" | ");
		// normalize:缺失的已知块(link)被追加(向前兼容)
		expect(eff.messageLayout.dynamic.blocks.map((b) => b.id)).toContain("link");
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

/**
 * 全局启用哪一份人格 —— `ai.activePreset` 指针。
 *
 * 加这个字段是为了让设置页的「全局人格选择」成为**真正的选择器**:不填 = 用
 * `ai.persona`(老行为,不需要迁移),填了就用那份预设。关键在于它**不改写**
 * `ai.persona` —— 切回「默认」时主人手写的那份原封不动地回来。
 *
 * 旧界面是靠「把预设复制进 ai.persona」来表达选中的,那一下就把主人手写的覆盖了、
 * 且换不回来;想显示「现在选的是哪份」还得拿 persona 去逐字段比对猜。两个毛病
 * 都由这个指针一并解决。
 */
describe("ai.activePreset —— 全局用哪一份人格", () => {
	const TSUNDERE = {
		name: "傲娇",
		addressUser: "笨蛋",
		addressSelf: "本喵",
		traits: "毒舌",
		catchphrase: "哼",
		baseRole: "",
		extraSystemPrompt: "",
	};

	it("不填 → 回落 ai.persona。这是**安全网**,不是常态", () => {
		// schema 保证 parse 出来的配置恒带指针(见 ai-persona-pointer.test.ts),所以这条
		// 路只在指针被就地抹掉时走到 —— 它存在的意义是「无论如何都得有份人格」,
		// 而不是让人靠改 ai.persona 来换全局人格(那条路已经没有界面入口了)。
		const globals = makeDefaultGlobalConfig();
		globals.defaults.ai.activePreset = undefined;
		globals.defaults.ai.persona.name = "梦梦";
		expect(resolve(SUB_BASE, globals.defaults).ai.persona.name).toBe("梦梦");
	});

	it("默认配置指向第一份「温柔女仆」", () => {
		const globals = makeDefaultGlobalConfig();
		expect(globals.defaults.ai.activePreset).toBe("gentle-maid");
		expect(resolve(SUB_BASE, globals.defaults).ai.persona.name).toBe("小绫");
	});

	it("填了 → 全局改用那份预设的人格与它写了的 prompt", () => {
		const globals = makeDefaultGlobalConfig();
		globals.defaults.ai.persona.name = "梦梦";
		globals.defaults.ai.presets = [
			{ id: "tsundere", label: "傲娇", persona: TSUNDERE, dynamicPrompt: "傲娇动态" },
		];
		globals.defaults.ai.activePreset = "tsundere";
		const eff = resolve(SUB_BASE, globals.defaults);
		expect(eff.ai.persona).toEqual(TSUNDERE);
		expect(eff.ai.dynamicPrompt).toBe("傲娇动态");
	});

	it("预设没写的那段 prompt 仍回落全局 —— undefined 的意思本就是「跟全局一样」", () => {
		const globals = makeDefaultGlobalConfig();
		globals.defaults.ai.liveSummaryPrompt = "全局总结";
		globals.defaults.ai.presets = [{ id: "tsundere", label: "傲娇", persona: TSUNDERE }];
		globals.defaults.ai.activePreset = "tsundere";
		expect(resolve(SUB_BASE, globals.defaults).ai.liveSummaryPrompt).toBe("全局总结");
	});

	it("**不改写 ai.persona** —— 切回「默认」时主人手写的那份还在", () => {
		const globals = makeDefaultGlobalConfig();
		globals.defaults.ai.persona.name = "梦梦";
		globals.defaults.ai.presets = [{ id: "tsundere", label: "傲娇", persona: TSUNDERE }];
		globals.defaults.ai.activePreset = "tsundere";
		resolve(SUB_BASE, globals.defaults);
		expect(globals.defaults.ai.persona.name).toBe("梦梦");
	});

	it("指向一份已不存在的预设 → 回落 ai.persona,不炸也不留空人格", () => {
		// 主人可能刚把那份删掉,或者备份导入换了一批预设。
		const globals = makeDefaultGlobalConfig();
		globals.defaults.ai.persona.name = "梦梦";
		globals.defaults.ai.activePreset = "gone";
		expect(resolve(SUB_BASE, globals.defaults).ai.persona.name).toBe("梦梦");
	});

	it("per-UP 覆盖仍然压过全局指针 —— per-UP 的语义一点没变", () => {
		const globals = makeDefaultGlobalConfig();
		globals.defaults.ai.presets = [
			{ id: "tsundere", label: "傲娇", persona: TSUNDERE },
			{ id: "critic", label: "评论家", persona: { ...TSUNDERE, name: "评论家" } },
		];
		globals.defaults.ai.activePreset = "tsundere";
		const sub: Subscription = { ...SUB_BASE, overrides: { ai: { preset: "critic" } } };
		expect(resolve(sub, globals.defaults).ai.persona.name).toBe("评论家");
	});

	it("per-UP 显式 inherit → 继承的是**全局指针指的那份**,不是 ai.persona", () => {
		// inherit 的意思是「跟全局一样」,而全局此刻用的正是那份预设。
		const globals = makeDefaultGlobalConfig();
		globals.defaults.ai.persona.name = "梦梦";
		globals.defaults.ai.presets = [{ id: "tsundere", label: "傲娇", persona: TSUNDERE }];
		globals.defaults.ai.activePreset = "tsundere";
		const sub: Subscription = { ...SUB_BASE, overrides: { ai: { preset: "inherit" } } };
		expect(resolve(sub, globals.defaults).ai.persona.name).toBe("傲娇");
	});
});
