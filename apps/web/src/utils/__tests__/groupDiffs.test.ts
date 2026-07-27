import { describe, expect, it } from "vite-plus/test";
import { getFieldLabel } from "../../config/field-labels";
import { groupDiffsBySection, sectionOf } from "../groupDiffs";
import type { FieldDiff } from "../walkTreeDiff";

const D = (code: string, oldV: unknown = 0, newV: unknown = 1): FieldDiff => ({
	code,
	oldValue: oldV,
	newValue: newV,
});

describe("sectionOf", () => {
	it("已知 code → 字典里的 section", () => {
		expect(sectionOf("ai.apiKey")).toBe("ai");
		expect(sectionOf("cardColorStart")).toBe("cardStyle");
		expect(sectionOf("app.logLevel")).toBe("logging");
	});

	it("未知 code → other", () => {
		expect(sectionOf("__nope__")).toBe("other");
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
		const out = groupDiffsBySection([D("ai.temperature"), D("ai.apiKey"), D("ai.model")]);
		expect(out[0].rows.map((r) => r.code)).toEqual(["ai.apiKey", "ai.model", "ai.temperature"]);
	});

	it("多 section → 按 SECTION_ORDER 顺序(general/master/ai/persona/cardStyle/.../other)", () => {
		const out = groupDiffsBySection([
			D("cardColorStart"),
			D("ai.apiKey"),
			D("blockKeywords"),
			D("app.dynamicCron"),
		]);
		expect(out.map((s) => s.section)).toEqual(["general", "ai", "cardStyle", "filter"]);
	});

	it("未知 code → other section,排在最后", () => {
		const out = groupDiffsBySection([D("ai.apiKey"), D("__nope__")]);
		expect(out.map((s) => s.section)).toEqual(["ai", "other"]);
		expect(out.at(-1)?.label).toBe("其他");
	});

	it("不就地改 caller 的数组", () => {
		const input: FieldDiff[] = [D("ai.temperature"), D("ai.apiKey")];
		const before = input.map((d) => d.code);
		groupDiffsBySection(input);
		expect(input.map((d) => d.code)).toEqual(before);
	});

	it("section label 完整(每个 section 的 label 非空)", () => {
		const out = groupDiffsBySection([
			D("app.dynamicCron"),
			D("master.targetId"),
			D("ai.apiKey"),
			D("persona.name"),
			D("cardColorStart"),
			D("showFans"),
			D("roomId"),
			D("blockKeywords"),
			D("templates.liveStart"),
			D("schedule.pushTime"),
			D("minScPrice"),
			D("specialUsers"),
			D("enable"),
			D("targetId"),
			D("adapter.platform"),
			D("config.transport"),
			D("session.userId"),
			D("app.logLevel"),
		]);
		for (const s of out) {
			expect(s.label.length).toBeGreaterThan(0);
		}
	});

	describe("默认更新提示的账本", () => {
		// 账本的 code 是**动态**的(templateDefaultsSeen.<任意模板路径>),没法逐条
		// 登记进 FIELD_LABELS,不特判就会掉进「其他」兜底组 —— 用户看到一行
		// `templateDefaultsSeen.liveSummary  (未设置) → 1hxy5zb`,完全不知所云。
		it("归到「消息模板」组,而不是掉进「其他」", () => {
			const [sec] = groupDiffsBySection([
				{ code: "templateDefaultsSeen.liveSummary", oldValue: undefined, newValue: "1hxy5zb" },
			]);
			expect(sec?.section).toBe("templates");
		});

		it("label 借对应模板字段的名字,读得出是哪条文案", () => {
			// `templates.liveSummary` 在字典里叫「总结正文」,账本这条就该跟着它走 ——
			// 硬写一份新名字的话,哪天模板改名两边就对不上了。
			expect(getFieldLabel("templateDefaultsSeen.liveSummary")?.label).toBe(
				"总结正文 · 默认更新提示",
			);
		});

		it("嵌套路径的账本条目也认得出来", () => {
			expect(getFieldLabel("templateDefaultsSeen.guardBuy.captain.template")).not.toBeNull();
		});
	});
});
