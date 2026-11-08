import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { getFieldLabel } from "../../config/field-labels";
import { i18n } from "../../i18n";
import { groupDiffsBySection, sectionOf } from "../groupDiffs";
import type { FieldDiff } from "../walkTreeDiff";

// This scenario uses Chinese UI; it must not depend on untranslated fallbacks.
beforeEach(() => {
	i18n.set({ locale: "zh-CN", voice: "plain" });
});

const D = (code: string, oldV: unknown = 0, newV: unknown = 1): FieldDiff => ({
	code,
	oldValue: oldV,
	newValue: newV,
});

describe("动态会员字段", () => {
	it("合法的任意体系与档路径有中性元数据且不告警", () => {
		for (const code of [
			"membership.minRank.readers",
			"templates.membership.readers.enabled",
			"templates.membership.readers.default.template",
			"templates.membership.readers.tiers.unknown.imageUrl",
		]) {
			expect(getFieldLabel(code)?.section).toBe(
				code.startsWith("templates.") ? "templates" : "interaction",
			);
		}
		expect(getFieldLabel("templatesSeen.membership.readers.default.template")?.label).toBe(
			"readers · 体系默认文案 · 默认更新提示",
		);
	});

	it("未知体系与档位保留原始键，合法动态路径不告警", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(getFieldLabel("membership.minRank.retired")?.label).toBe("retired · 会员最低档位");
			expect(getFieldLabel("templates.membership.retired.tiers.unknown.imageUrl")?.label).toBe(
				"retired · unknown · 会员档位图片",
			);
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});
});

describe("sectionOf", () => {
	it("任意日志归属键的草稿都归日志组并保留完整键", () => {
		for (const key of ["onebot", "acme.dual", "retired.source"]) {
			expect(sectionOf(`core.logging.levels.${key}`)).toBe("logging");
			expect(getFieldLabel(`core.logging.levels.${key}`)?.label).toBe(`${key} · 日志等级`);
		}
	});
	it("已知 code → 字典里的 section", () => {
		expect(sectionOf("ai.apiKey")).toBe("ai");
		expect(sectionOf("liveCoverImageIds")).toBe("cardStyle");
		expect(sectionOf("core.logging.level")).toBe("logging");
	});

	// B 站的两格住在它自己的设置里(`bilibili` 块),不在核心的 `logging` 下 —— 字典的 code 跟着搬了家。
	it("B 站设置的两格 → 都认得,归「通用」", () => {
		for (const code of ["bilibili.dynamicCron", "bilibili.healthCheckMinutes"]) {
			expect(sectionOf(code), code).toBe("general");
		}
	});

	it("未知 code → other", () => {
		expect(sectionOf("__nope__")).toBe("other");
	});

	it("已删的 bilibili.userAgent 不在字典里(自定义 UA 没了,灵动岛上不该再有它的行)", () => {
		expect(sectionOf("bilibili.userAgent")).toBe("other");
	});
});

describe("groupDiffsBySection", () => {
	it("空 diff → 空 array", () => {
		expect(groupDiffsBySection([])).toEqual([]);
	});

	it("单 section diff → 1 个 section", () => {
		const out = groupDiffsBySection([D("ai.apiKey")]);
		expect(out).toHaveLength(1);
		expect(out[0].section).toBe("ai");
		expect(out[0].label).toBe("AI 模型");
	});

	it("section 内多行按 code 字母序", () => {
		const out = groupDiffsBySection([D("ai.thinkingLevel"), D("ai.apiKey"), D("ai.model")]);
		expect(out[0].rows.map((r) => r.code)).toEqual(["ai.apiKey", "ai.model", "ai.thinkingLevel"]);
	});

	it("多 section → 按 SECTION_ORDER 顺序(general/master/ai/persona/cardStyle/.../other)", () => {
		const out = groupDiffsBySection([
			D("liveCoverImageIds"),
			D("ai.apiKey"),
			D("blockKeywords"),
			D("bilibili.dynamicCron"),
		]);
		expect(out.map((s) => s.section)).toEqual(["general", "ai", "cardStyle", "filter"]);
	});

	it("未知 code → other section,排在最后", () => {
		const out = groupDiffsBySection([D("ai.apiKey"), D("__nope__")]);
		expect(out.map((s) => s.section)).toEqual(["ai", "other"]);
		expect(out.at(-1)?.label).toBe("其他");
	});

	it("不就地改 caller 的数组", () => {
		const input: FieldDiff[] = [D("ai.thinkingLevel"), D("ai.apiKey")];
		const before = input.map((d) => d.code);
		groupDiffsBySection(input);
		expect(input.map((d) => d.code)).toEqual(before);
	});

	it("section label 完整(每个 section 的 label 非空)", () => {
		const out = groupDiffsBySection([
			D("bilibili.dynamicCron"),
			D("core.master.targetId"),
			D("ai.apiKey"),
			D("persona.name"),
			D("liveCoverImageIds"),
			D("roomId"),
			D("blockKeywords"),
			D("templates.liveStart"),
			D("liveStreaming.streamingIntervalHours"),
			D("superchat.minAmount"),
			D("specialViewers"),
			D("imageGroup.enabled"),
			D("targetId"),
			D("connection.platform"),
			D("settings.transport"),
			D("session.userId"),
			D("core.logging.level"),
		]);
		for (const s of out) {
			expect(s.label.length).toBeGreaterThan(0);
		}
	});

	describe("默认更新提示的账本", () => {
		// 账本的 code 是**动态**的(templatesSeen.<任意模板路径>),没法逐条
		// 登记进 FIELD_LABELS,不特判就会掉进「其他」兜底组 —— 用户看到一行
		// `templatesSeen.liveSummary  (未设置) → 1hxy5zb`,完全不知所云。
		it("归到「消息模板」组,而不是掉进「其他」", () => {
			const [sec] = groupDiffsBySection([
				{ code: "templatesSeen.liveSummary", oldValue: undefined, newValue: "1hxy5zb" },
			]);
			expect(sec?.section).toBe("templates");
		});

		it("label 借对应模板字段的名字,读得出是哪条文案", () => {
			// `templates.liveSummary` 在字典里叫「总结正文」,账本这条就该跟着它走 ——
			// 硬写一份新名字的话,哪天模板改名两边就对不上了。
			expect(getFieldLabel("templatesSeen.liveSummary")?.label).toBe("总结正文 · 默认更新提示");
		});

		it("嵌套路径的账本条目也认得出来:上舰体系默认文案那条借的是它自己的名字(㉓d)", () => {
			expect(getFieldLabel("templatesSeen.membership.guard.default.template")?.label).toBe(
				"guard · 体系默认文案 · 默认更新提示",
			);
		});
	});

	describe("逐家服务商的桶", () => {
		// 连接与生成参数住在 `ai.providers.<家>.*` 里,一家一套。code 因此是**动态**的
		// (家数 × 十来个字段),逐条登记进字典不现实。
		it("归到「AI 模型」组,而不是掉进「其他」", () => {
			const [sec] = groupDiffsBySection([D("ai.providers.deepseek.model", "a", "b")]);
			expect(sec?.section).toBe("ai");
		});

		it("label 带上是哪一家 —— 否则两家都改了 API Key 会出现两行一模一样的", () => {
			expect(getFieldLabel("ai.providers.deepseek.apiKey")?.label).toBe("DeepSeek · API Key");
			expect(getFieldLabel("ai.providers.openrouter.apiKey")?.label).toBe("OpenRouter · API Key");
		});

		it("视觉副模型那几格(路径再深一层)也认得出来", () => {
			expect(getFieldLabel("ai.providers.siliconflow.vision.apiKey")?.label).toBe(
				"硅基流动 · 视觉 API Key",
			);
		});

		it("字段名不认识 → 老实说不认识,不硬造一个半截标签", () => {
			expect(getFieldLabel("ai.providers.deepseek.__nope__")).toBeNull();
		});

		// providers 已是 z.record(z.string()):手改配置/备份恢复出的任意桶 id
		// (「my-deepseek」)是合法可加载的。认不出形状就返回 null 的话,继承的
		// secret 标志跟着丢 —— 灵动岛 diff 面板会把刚输入的 API Key 按明文摊开。
		// 桶 id 本身就是主人写的,拿它当显示名毫不含糊,而 secret 一位都不能丢。
		it("非常规桶 id → 用原样 id 当显示名,secret 标志必须继承", () => {
			const entry = getFieldLabel("ai.providers.my-deepseek.apiKey");
			expect(entry?.secret).toBe(true);
			expect(entry?.label).toBe("my-deepseek · API Key");
			expect(getFieldLabel("ai.providers.my-deepseek.vision.apiKey")?.secret).toBe(true);
		});

		it("非常规桶 id 的普通字段照样归进 AI 组,不掉「其他」", () => {
			const entry = getFieldLabel("ai.providers.notAProvider.model");
			expect(entry).not.toBeNull();
			expect(entry?.section).toBe("ai");
			expect(entry?.label).toContain("notAProvider");
		});
	});
});
