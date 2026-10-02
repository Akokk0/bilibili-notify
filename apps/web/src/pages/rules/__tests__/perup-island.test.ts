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

describe("projectPerUpIsland — schedule/liveStart/liveStreaming/templates/ai 保 nested", () => {
	it("改 schedule.liveEndGraceMinutes → 'schedule.liveEndGraceMinutes',section=schedule", () => {
		const codes = diffCodes(
			{ schedule: { liveEndGraceMinutes: 1 } },
			{ schedule: { liveEndGraceMinutes: 2 } },
		);
		expect(codes).toContain("schedule.liveEndGraceMinutes");
		expect(sectionOf("schedule.liveEndGraceMinutes")).toBe("schedule");
	});

	// 直播拆键(⑬d):周期间隔与启动补报从 schedule 里搬出来,各自成一段。
	it("改 liveStreaming.streamingIntervalHours → 'liveStreaming.streamingIntervalHours',section=schedule", () => {
		const codes = diffCodes(
			{ liveStreaming: { streamingIntervalHours: 1 } },
			{ liveStreaming: { streamingIntervalHours: 2 } },
		);
		expect(codes).toContain("liveStreaming.streamingIntervalHours");
		expect(sectionOf("liveStreaming.streamingIntervalHours")).toBe("schedule");
	});

	it("改 liveStart.catchUpOnBoot → 'liveStart.catchUpOnBoot',section=schedule", () => {
		const codes = diffCodes(
			{ liveStart: { catchUpOnBoot: false } },
			{ liveStart: { catchUpOnBoot: true } },
		);
		expect(codes).toContain("liveStart.catchUpOnBoot");
		expect(sectionOf("liveStart.catchUpOnBoot")).toBe("schedule");
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
});

describe("projectPerUpIsland — imageGroup 打平 + specialUsers 叶子", () => {
	it("cardStyle 不再投影 —— 卡片覆盖已迁到 /cards,改它不进 Rules per-UP 灵动岛", () => {
		const codes = diffCodes(
			{ cardStyle: { font: "One Sans" } },
			{ cardStyle: { font: "Two Sans" } },
		);
		expect(codes).not.toContain("font");
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
