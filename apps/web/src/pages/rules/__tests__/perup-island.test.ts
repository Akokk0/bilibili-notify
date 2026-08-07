import { DEFAULT_ROAST_SCHEDULE } from "@bilibili-notify/internal/constants";
import { describe, expect, it } from "vite-plus/test";
import type { OverridesShape, SpecialUser, Subscription } from "../../../types/domain";
import { sectionOf } from "../../../utils/groupDiffs";
import { walkTreeDiff } from "../../../utils/walkTreeDiff";
import { projectPerUpIsland } from "../perup-island";

const NO_USERS: SpecialUser[] = [];
const NO_ROAST: Subscription["roastSchedule"] = { ...DEFAULT_ROAST_SCHEDULE };

/** 投影两份 overrides 再 diff,返回 code 列表(灵动岛实际消费路径)。 */
function diffCodes(
	before: OverridesShape,
	after: OverridesShape,
	beforeUsers: SpecialUser[] = NO_USERS,
	afterUsers: SpecialUser[] = NO_USERS,
	beforeRoast: Subscription["roastSchedule"] = NO_ROAST,
	afterRoast: Subscription["roastSchedule"] = NO_ROAST,
): string[] {
	const diff = walkTreeDiff(
		projectPerUpIsland(before, beforeUsers, beforeRoast),
		projectPerUpIsland(after, afterUsers, afterRoast),
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

describe("projectPerUpIsland — imageGroup 打平 + specialUsers 叶子", () => {
	it("cardStyle 不再投影 —— 卡片覆盖已迁到 /cards,改它不进 Rules per-UP 灵动岛", () => {
		const codes = diffCodes(
			{ cardStyle: { cardColorStart: "#111111" } },
			{ cardStyle: { cardColorStart: "#222222" } },
		);
		expect(codes).not.toContain("cardColorStart");
		expect(codes).toEqual([]);
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

describe("projectPerUpIsland — roastSchedule 保 nested", () => {
	// 这位 UP 自己的一条排程,不是 override。它同样得进灵动岛 —— 不进的话开了
	// 「定时锐评」却按不亮保存,改动就那么丢了(这一版里同类问题已经复发过)。
	it("改 roastSchedule.cron → 'roastSchedule.cron',section 对得上 FIELD_LABELS", () => {
		const codes = diffCodes({}, {}, NO_USERS, NO_USERS, NO_ROAST, {
			...NO_ROAST,
			cron: "0 8 * * 2",
		});
		expect(codes).toContain("roastSchedule.cron");
		expect(sectionOf("roastSchedule.cron")).toBe("schedule");
	});

	it("开启这位 UP 的定时锐评 → 检出 dirty", () => {
		const codes = diffCodes({}, {}, NO_USERS, NO_USERS, NO_ROAST, {
			...NO_ROAST,
			enabled: true,
		});
		expect(codes).toContain("roastSchedule.enabled");
	});

	it("两侧一样 → 无 diff(别让它天天喊有改动)", () => {
		expect(diffCodes({}, {}, NO_USERS, NO_USERS, NO_ROAST, { ...NO_ROAST })).toEqual([]);
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
