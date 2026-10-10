import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_CARD_SKIN_ID } from "../card-skin";
import { GlobalConfigSchema, makeDefaultGlobalConfig } from "../globals";
import { DEFAULT_MESSAGE_LAYOUT } from "../message-layout";
import { resolve, resolveSubscriptionPersona } from "../resolve";
import { type AIOverride, makeEmptySubscription, type Subscription } from "../subscriptions";

const SUB_BASE: Subscription = makeEmptySubscription({
	id: "11111111-1111-1111-1111-111111111111",
	identity: { sourceKey: "bilibili", externalId: "12345" },
});

describe("resolve()", () => {
	it("inherits all defaults when overrides are empty", () => {
		const globals = makeDefaultGlobalConfig();
		const eff = resolve(SUB_BASE, globals.defaults);

		expect(eff.features).toEqual(globals.defaults.features);
		expect(eff.filters).toEqual(globals.defaults.filters);
		expect(eff.schedule).toEqual(globals.defaults.schedule);
		expect(eff.liveStart).toEqual(globals.defaults.liveStart);
		expect(eff.liveStreaming).toEqual(globals.defaults.liveStreaming);
		expect(eff.cards).toEqual(globals.defaults.cards);
		// AI 不在折叠里:这条订阅生效的人格由 `resolveSubscriptionPersona` 单独给。
		expect("ai" in eff).toBe(false);
		expect(resolveSubscriptionPersona(globals.defaults.ai, undefined).persona).toEqual(
			globals.defaults.ai.persona,
		);
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
		expect(eff.schedule.quietHours).toEqual(globals.defaults.schedule.quietHours);
	});

	it("直播拆键:开播补报与周期间隔各是一段设置,per-UP 只覆盖写了的那一格,别的继承全局", () => {
		const globals = makeDefaultGlobalConfig();
		globals.defaults.liveStart.catchUpOnBoot = true;
		globals.defaults.liveStreaming.streamingIntervalHours = 3;

		// 只覆盖间隔:补报继承全局的 true。
		const onlyInterval = resolve(
			{ ...SUB_BASE, overrides: { liveStreaming: { streamingIntervalHours: 5 } } },
			globals.defaults,
		);
		expect(onlyInterval.liveStreaming).toEqual({ streamingIntervalHours: 5 });
		expect(onlyInterval.liveStart).toEqual({ catchUpOnBoot: true });

		// 只覆盖补报:间隔继承全局的 3。
		const onlyCatchUp = resolve(
			{ ...SUB_BASE, overrides: { liveStart: { catchUpOnBoot: false } } },
			globals.defaults,
		);
		expect(onlyCatchUp.liveStart).toEqual({ catchUpOnBoot: false });
		expect(onlyCatchUp.liveStreaming).toEqual({ streamingIntervalHours: 3 });
	});

	it("直播拆键:liveStreaming 开关与别的特性开关同一套继承,出厂是关的", () => {
		const globals = makeDefaultGlobalConfig();
		expect(resolve(SUB_BASE, globals.defaults).features.liveStreaming).toBe(false);
		const on = resolve(
			{ ...SUB_BASE, overrides: { features: { liveStreaming: true } } },
			globals.defaults,
		);
		expect(on.features.liveStreaming).toBe(true);
		// 开了周期不连带动开播那一把。
		expect(on.features.liveStart).toBe(globals.defaults.features.liveStart);
	});

	it("merges partial features override on top of defaults", () => {
		const globals = makeDefaultGlobalConfig();
		const sub: Subscription = {
			...SUB_BASE,
			overrides: {
				features: { liveStart: false, liveEnd: true },
			},
		};
		const eff = resolve(sub, globals.defaults);

		expect(eff.features.liveStart).toBe(false);
		expect(eff.features.liveEnd).toBe(true);
		expect(eff.features.post).toBe(globals.defaults.features.post);
	});

	it("AI override 'inherit' returns base ai unchanged", () => {
		const globals = makeDefaultGlobalConfig();
		const sub: Subscription = {
			...SUB_BASE,
			overrides: { ai: { preset: "inherit" } },
		};
		const eff = resolveSubscriptionPersona(globals.defaults.ai, sub.overrides.ai);
		expect(eff.persona).toEqual(globals.defaults.ai.persona);
		expect(eff.dynamicPrompt).toBe(globals.defaults.ai.dynamicPrompt);
	});

	it("老的 'custom' 人格就地失效 —— per-UP 只能挑一份已有人格,写不了自己的", () => {
		// 设置页曾经给过一档「完全自定义」,能就地写一套只属于这个 UP 的人设。
		// 那一档撤掉了(人格一律在「智能女仆」页里写,per-UP 只负责挑一份),盘上
		// 却还留着当年写下的字段。**它们不再参与解析** —— 留着继续生效的话就成了
		// 界面上看不见、实际仍在起作用的鬼配置,日后排查起来最费劲。
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
				// persona / 两段 prompt 已不在 schema 里 —— 这里模拟的是盘上残留的旧字段。
				ai: {
					preset: "custom",
					persona: customPersona,
					dynamicPrompt: "老的动态模板",
					liveSummaryPrompt: "老的总结模板",
					temperature: 1.5,
				} as unknown as AIOverride,
			},
		};
		const eff = resolveSubscriptionPersona(globals.defaults.ai, sub.overrides.ai);

		expect(eff.persona).toEqual(globals.defaults.ai.persona);
		expect(eff.dynamicPrompt).toBe(globals.defaults.ai.dynamicPrompt);
		expect(eff.liveSummaryPrompt).toBe(globals.defaults.ai.liveSummaryPrompt);
		// temperature 也已退役(请求里一律不发),残留值同样不参与解析。
		expect("temperature" in eff).toBe(false);
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
		const eff = resolveSubscriptionPersona(globals.defaults.ai, sub.overrides.ai);
		expect(eff.persona).toEqual(presetPersona);
		expect(eff.dynamicPrompt).toBe("X 模板");

		// 未知 preset id 时回退到 base
		const sub2: Subscription = {
			...SUB_BASE,
			overrides: { ai: { preset: "non-existent-id" } },
		};
		const eff2 = resolveSubscriptionPersona(globals.defaults.ai, sub2.overrides.ai);
		expect(eff2.persona).toEqual(globals.defaults.ai.persona);
		expect(eff2.dynamicPrompt).toBe(globals.defaults.ai.dynamicPrompt);
	});

	it("订阅挑的那份人格没写的那段 prompt 回落全局 —— 缺席是「跟全局一样」,不是空串", () => {
		const globals = makeDefaultGlobalConfig();
		globals.defaults.ai.dynamicPrompt = "全局动态";
		globals.defaults.ai.liveSummaryPrompt = "全局总结";
		globals.defaults.ai.presets = [
			{
				id: "tsundere",
				label: "傲娇",
				persona: { ...globals.defaults.ai.persona, name: "傲娇" },
				liveSummaryPrompt: "傲娇总结",
			},
		];
		const eff = resolveSubscriptionPersona(globals.defaults.ai, { preset: "tsundere" });
		expect(eff.persona.name).toBe("傲娇");
		expect(eff.liveSummaryPrompt).toBe("傲娇总结");
		expect(eff.dynamicPrompt).toBe("全局动态");
	});

	it("挑了具名人格时,盘上残留的 persona / prompt 一概不参与 —— 挑哪份就是哪份", () => {
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
			overrides: {
				// 同上:模拟盘上残留的旧字段。
				ai: {
					preset: "tsundere",
					persona: overridePersona,
					dynamicPrompt: "残留模板",
				} as unknown as AIOverride,
			},
		};
		const eff = resolveSubscriptionPersona(globals.defaults.ai, sub.overrides.ai);
		// 选中的那份人格说了算。残留的 persona 曾经压过它 —— 那时「完全自定义」还在,
		// 两者能同时存在;现在挑一份就是挑一份,不该被看不见的旧字段改写。
		expect(eff.persona).toEqual(presetPersona);
		expect(eff.dynamicPrompt).toBe("P 模板");
	});

	it("inherits the global card skin when the UP has no override", () => {
		const globals = makeDefaultGlobalConfig();
		expect(globals.defaults.cardSkin).toBe(DEFAULT_CARD_SKIN_ID);
		const eff = resolve(SUB_BASE, globals.defaults);
		expect(eff.cardSkin).toBe(DEFAULT_CARD_SKIN_ID);
	});

	it("a per-UP card skin replaces the global one outright", () => {
		const globals = makeDefaultGlobalConfig();
		globals.defaults.cardSkin = "k1abc-deadbeef";
		const sub: Subscription = {
			...SUB_BASE,
			overrides: { ...SUB_BASE.overrides, cardSkin: "k2xyz-cafebabe" },
		};
		expect(resolve(sub, globals.defaults).cardSkin).toBe("k2xyz-cafebabe");
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
					post: {
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
		// 整份覆盖:override 的 post 块序与分隔符生效
		expect(eff.messageLayout.post.blocks.slice(0, 2).map((b) => b.id)).toEqual(["text", "card"]);
		expect(eff.messageLayout.post.separator).toBe(" | ");
		// normalize:缺失的已知块(link)被追加(向前兼容)
		expect(eff.messageLayout.post.blocks.map((b) => b.id)).toContain("link");
	});

	// 回归守护 — P2:resolve() 必须深隔离,消费方就地改不得污染 defaults / sub。
	describe("深隔离 (P2)", () => {
		it("改 EffectiveSubscription 的嵌套数组/对象不污染 globals.defaults", () => {
			const globals = makeDefaultGlobalConfig();
			const eff = resolve(SUB_BASE, globals.defaults);
			eff.filters.blockKeywords.push("x");
			eff.features.liveStart = !eff.features.liveStart;
			expect(globals.defaults.filters.blockKeywords).not.toContain("x");
		});

		it("改 EffectiveSubscription.routing 不污染原始 sub", () => {
			const globals = makeDefaultGlobalConfig();
			const eff = resolve(SUB_BASE, globals.defaults);
			eff.routing.post.push("550e8400-e29b-41d4-a716-446655440000");
			expect(SUB_BASE.routing.post).toHaveLength(0);
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
		// 出厂默认值自带指针(`DEFAULT_AI.activePreset`),存量配置的指针由迁移器补上
		// (`apps/server/src/migration/ai.ts`),所以这条路只在指针被就地抹掉时走到 —— 它存在的意义是「无论如何都得有份人格」,
		// 而不是让人靠改 ai.persona 来换全局人格(那条路已经没有界面入口了)。
		const globals = makeDefaultGlobalConfig();
		globals.defaults.ai.activePreset = undefined;
		globals.defaults.ai.persona.name = "梦梦";
		expect(resolveSubscriptionPersona(globals.defaults.ai, undefined).persona.name).toBe("梦梦");
	});

	it("默认配置指向第一份「温柔女仆」", () => {
		const globals = makeDefaultGlobalConfig();
		expect(globals.defaults.ai.activePreset).toBe("gentle-maid");
		expect(resolveSubscriptionPersona(globals.defaults.ai, undefined).persona.name).toBe("小绫");
	});

	it("填了 → 全局改用那份预设的人格与它写了的 prompt", () => {
		const globals = makeDefaultGlobalConfig();
		globals.defaults.ai.persona.name = "梦梦";
		globals.defaults.ai.presets = [
			{ id: "tsundere", label: "傲娇", persona: TSUNDERE, dynamicPrompt: "傲娇动态" },
		];
		globals.defaults.ai.activePreset = "tsundere";
		const eff = resolveSubscriptionPersona(globals.defaults.ai, undefined);
		expect(eff.persona).toEqual(TSUNDERE);
		expect(eff.dynamicPrompt).toBe("傲娇动态");
	});

	it("预设没写的那段 prompt 仍回落全局 —— undefined 的意思本就是「跟全局一样」", () => {
		const globals = makeDefaultGlobalConfig();
		globals.defaults.ai.liveSummaryPrompt = "全局总结";
		globals.defaults.ai.presets = [{ id: "tsundere", label: "傲娇", persona: TSUNDERE }];
		globals.defaults.ai.activePreset = "tsundere";
		expect(resolveSubscriptionPersona(globals.defaults.ai, undefined).liveSummaryPrompt).toBe(
			"全局总结",
		);
	});

	it("**不改写 ai.persona** —— 切回「默认」时主人手写的那份还在", () => {
		const globals = makeDefaultGlobalConfig();
		globals.defaults.ai.persona.name = "梦梦";
		globals.defaults.ai.presets = [{ id: "tsundere", label: "傲娇", persona: TSUNDERE }];
		globals.defaults.ai.activePreset = "tsundere";
		resolveSubscriptionPersona(globals.defaults.ai, undefined);
		expect(globals.defaults.ai.persona.name).toBe("梦梦");
	});

	it("指向一份已不存在的预设 → 回落 ai.persona,不炸也不留空人格", () => {
		// 主人可能刚把那份删掉,或者备份导入换了一批预设。
		const globals = makeDefaultGlobalConfig();
		globals.defaults.ai.persona.name = "梦梦";
		globals.defaults.ai.activePreset = "gone";
		expect(resolveSubscriptionPersona(globals.defaults.ai, undefined).persona.name).toBe("梦梦");
	});

	it("per-UP 覆盖仍然压过全局指针 —— per-UP 的语义一点没变", () => {
		const globals = makeDefaultGlobalConfig();
		globals.defaults.ai.presets = [
			{ id: "tsundere", label: "傲娇", persona: TSUNDERE },
			{ id: "critic", label: "评论家", persona: { ...TSUNDERE, name: "评论家" } },
		];
		globals.defaults.ai.activePreset = "tsundere";
		const sub: Subscription = { ...SUB_BASE, overrides: { ai: { preset: "critic" } } };
		expect(resolveSubscriptionPersona(globals.defaults.ai, sub.overrides.ai).persona.name).toBe(
			"评论家",
		);
	});

	it("per-UP 显式 inherit → 继承的是**全局指针指的那份**,不是 ai.persona", () => {
		// inherit 的意思是「跟全局一样」,而全局此刻用的正是那份预设。
		const globals = makeDefaultGlobalConfig();
		globals.defaults.ai.persona.name = "梦梦";
		globals.defaults.ai.presets = [{ id: "tsundere", label: "傲娇", persona: TSUNDERE }];
		globals.defaults.ai.activePreset = "tsundere";
		const sub: Subscription = { ...SUB_BASE, overrides: { ai: { preset: "inherit" } } };
		expect(resolveSubscriptionPersona(globals.defaults.ai, sub.overrides.ai).persona.name).toBe(
			"傲娇",
		);
	});
});

describe("直播拆键(⑬d):全局的出厂值与范围", () => {
	it("出厂:周期「正在直播」关、间隔 1 小时、启动补报关(与拆键前的出厂行为一致)", () => {
		const { defaults } = makeDefaultGlobalConfig();
		expect(defaults.features.liveStreaming).toBe(false);
		expect(defaults.liveStreaming).toEqual({ streamingIntervalHours: 1 });
		expect(defaults.liveStart).toEqual({ catchUpOnBoot: false });
		// schedule 只拿走这两格:静音时段与断流接续原样留着(随 3a)。
		expect(Object.keys(defaults.schedule)).toEqual([
			"quietHours",
			"liveEndGrace",
			"liveEndGraceMinutes",
		]);
	});

	it("间隔是 1–24 的整数:0(旧的「关」)、25、小数都拒收,关的意思交给开关", () => {
		const withInterval = (hours: number) => {
			const g = structuredClone(makeDefaultGlobalConfig());
			g.defaults.liveStreaming.streamingIntervalHours = hours;
			return GlobalConfigSchema.safeParse(g).success;
		};
		expect([0, 25, 1.5, -1].map(withInterval)).toEqual([false, false, false, false]);
		expect([1, 12, 24].map(withInterval)).toEqual([true, true, true]);
	});
});
