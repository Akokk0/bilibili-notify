import { describe, expect, it } from "vite-plus/test";
import type { OverridesShape, SpecialUser } from "../../../types/domain";
import { sectionOf } from "../../../utils/groupDiffs";
import { walkTreeDiff } from "../../../utils/walkTreeDiff";
import { projectPerUpIsland } from "../perup-island";

const NO_USERS: SpecialUser[] = [];

/** 投影两份 overrides 再 diff,返回 code 列表(灵动岛实际消费路径)。 */
function diffCodes(
	before: OverridesShape,
	after: OverridesShape,
	beforeUsers: SpecialUser[] = NO_USERS,
	afterUsers: SpecialUser[] = NO_USERS,
): string[] {
	const diff = walkTreeDiff(
		projectPerUpIsland(before, beforeUsers),
		projectPerUpIsland(after, afterUsers),
	);
	return diff.map((d) => d.code);
}

describe("projectPerUpIsland — filters 打平", () => {
	it("改 filters.blockKeywords → diff code 'blockKeywords'(无前缀),section=filter", () => {
		const before: OverridesShape = { filters: { blockKeywords: ["a"] } };
		const after: OverridesShape = { filters: { blockKeywords: ["a", "b"] } };
		const codes = diffCodes(before, after);
		expect(codes).toContain("blockKeywords");
		expect(codes).not.toContain("overrides.filters.blockKeywords");
		expect(sectionOf("blockKeywords")).toBe("filter");
	});
});

describe("projectPerUpIsland — schedule/templates/ai 保 nested", () => {
	it("改 schedule.pushTime → 'schedule.pushTime',section=schedule", () => {
		const codes = diffCodes({ schedule: { pushTime: 1 } }, { schedule: { pushTime: 2 } });
		expect(codes).toContain("schedule.pushTime");
		expect(sectionOf("schedule.pushTime")).toBe("schedule");
	});

	it("改 templates.liveSummary → 'templates.liveSummary',section=templates", () => {
		const codes = diffCodes(
			{ templates: { liveSummary: "a" } },
			{ templates: { liveSummary: "b" } },
		);
		expect(codes).toContain("templates.liveSummary");
		expect(sectionOf("templates.liveSummary")).toBe("templates");
	});

	it("改 ai.preset → 'ai.preset',section=ai", () => {
		const codes = diffCodes({ ai: { preset: "inherit" } }, { ai: { preset: "custom" } });
		expect(codes).toContain("ai.preset");
		expect(sectionOf("ai.preset")).toBe("ai");
	});

	it("两侧 persona 都在、改 name → 'ai.persona.name',section=persona", () => {
		// custom 模式下 persona 已 seed 成对象,逐字段编辑 → 递归出 ai.persona.X。
		const persona = {
			name: "喵",
			addressUser: "主人",
			addressSelf: "我",
			traits: "",
			catchphrase: "",
			baseRole: "",
			extraSystemPrompt: "",
		};
		const codes = diffCodes(
			{ ai: { preset: "custom", persona } },
			{ ai: { preset: "custom", persona: { ...persona, name: "汪" } } },
		);
		expect(codes).toContain("ai.persona.name");
		expect(sectionOf("ai.persona.name")).toBe("persona");
	});
});

describe("projectPerUpIsland — cardStyle/imageGroup 打平 + specialUsers 叶子", () => {
	it("改 cardStyle.cardColorStart → 'cardColorStart',section=cardStyle", () => {
		const codes = diffCodes(
			{ cardStyle: { cardColorStart: "#111111" } },
			{ cardStyle: { cardColorStart: "#222222" } },
		);
		expect(codes).toContain("cardColorStart");
		expect(sectionOf("cardColorStart")).toBe("cardStyle");
	});

	it("改 imageGroup.enable → 'enable',section=imageGroup", () => {
		const codes = diffCodes({ imageGroup: { enable: false } }, { imageGroup: { enable: true } });
		expect(codes).toContain("enable");
		expect(sectionOf("enable")).toBe("imageGroup");
	});

	it("改 specialUsers(整数组叶子)→ 'specialUsers',section=specialUsers", () => {
		const codes = diffCodes({}, {}, [], [{ uid: "1", kinds: ["danmaku"] }]);
		expect(codes).toContain("specialUsers");
		expect(sectionOf("specialUsers")).toBe("specialUsers");
	});
});

describe("projectPerUpIsland — 继承 vs 开启覆盖", () => {
	it("两侧都继承(slice undefined)→ 无 diff", () => {
		expect(diffCodes({}, {})).toEqual([]);
	});

	it("开启某覆盖(undefined → seeded 对象)→ 检出 dirty(diff 非空)", () => {
		const codes = diffCodes({}, { filters: { blockKeywords: ["x"], minScPrice: 30 } });
		expect(codes.length).toBeGreaterThan(0);
		expect(codes).toContain("blockKeywords");
	});
});
