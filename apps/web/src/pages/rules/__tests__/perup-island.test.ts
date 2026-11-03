import { describe, expect, it } from "vite-plus/test";
import { getFieldLabel } from "../../../config/field-labels";
import type { OverridesShape, SpecialViewer } from "../../../types/domain";
import { groupDiffsBySection, sectionOf } from "../../../utils/groupDiffs";
import { walkTreeDiff } from "../../../utils/walkTreeDiff";
import { projectPerUpIsland } from "../perup-island";

const NO_USERS: SpecialViewer[] = [];

/** 投影两份 overrides 再 diff,返回 code 列表(灵动岛实际消费路径)。 */
function diffCodes(
	before: OverridesShape,
	after: OverridesShape,
	beforeUsers: SpecialViewer[] = NO_USERS,
	afterUsers: SpecialViewer[] = NO_USERS,
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

describe("projectPerUpIsland — imageGroup 保 nested + specialViewers 叶子", () => {
	it("cards 不投影 —— 卡片覆盖在 /cards,改它不进 Rules per-UP 灵动岛", () => {
		const codes = diffCodes(
			{ cards: { liveCoverImageIds: ["one"] } },
			{ cards: { liveCoverImageIds: ["two"] } },
		);
		expect(codes).not.toContain("liveCoverImageIds");
		expect(codes).toEqual([]);
	});

	// 图集的总开关叫 `enabled`,打平成顶层键会和 AI 页的 `enabled`(「启用 / 通用」)撞:保存条里这一格会被认成别人。
	// 所以图集保 nested,code 带前缀;标签与分区和改名前一模一样。
	it("改图集的总开关 → code 'imageGroup.enabled',保存条里是「推送作品图集 / 作品图集」那一条", () => {
		const codes = diffCodes({ imageGroup: { enabled: false } }, { imageGroup: { enabled: true } });
		expect(codes).toEqual(["imageGroup.enabled"]);
		expect(getFieldLabel("imageGroup.enabled")?.label).toBe("推送作品图集");
		expect(sectionOf("imageGroup.enabled")).toBe("imageGroup");
		const [section] = groupDiffsBySection([
			{ code: "imageGroup.enabled", oldValue: false, newValue: true },
		]);
		expect(section?.label).toBe("作品图集");
	});

	it("改图集的合并转发 → code 'imageGroup.mergeForward',保存条里是「图集走合并转发 / 作品图集」那一条", () => {
		const codes = diffCodes(
			{ imageGroup: { enabled: true, mergeForward: false } },
			{ imageGroup: { enabled: true, mergeForward: true } },
		);
		expect(codes).toEqual(["imageGroup.mergeForward"]);
		expect(getFieldLabel("imageGroup.mergeForward")?.label).toBe("图集走合并转发");
		expect(sectionOf("imageGroup.mergeForward")).toBe("imageGroup");
	});

	it("开 / 关整段图集覆盖 → 两格各出一条带前缀的 code,不冒出顶层的 enabled", () => {
		const on: OverridesShape = { imageGroup: { enabled: true, mergeForward: false } };
		expect([...diffCodes({}, on)].sort()).toEqual([
			"imageGroup.enabled",
			"imageGroup.mergeForward",
		]);
		expect([...diffCodes(on, {})].sort()).toEqual([
			"imageGroup.enabled",
			"imageGroup.mergeForward",
		]);
		// 两边都没有图集覆盖:不脏。
		expect(diffCodes({}, {})).toEqual([]);
	});

	it("改 specialViewers(整数组叶子)→ 'specialViewers',section=specialViewers", () => {
		const codes = diffCodes({}, {}, [], [{ id: "1", features: ["viewerChat"] }]);
		expect(codes).toContain("specialViewers");
		expect(sectionOf("specialViewers")).toBe("specialViewers");
	});
});

describe("projectPerUpIsland — 继承 vs 开启覆盖", () => {
	it("两侧都继承(slice undefined)→ 无 diff", () => {
		expect(diffCodes({}, {})).toEqual([]);
	});

	it("开启某覆盖(undefined → seeded 对象)→ 检出 dirty(diff 非空)", () => {
		const codes = diffCodes({}, { filters: { blockKeywords: ["x"] } });
		expect(codes.length).toBeGreaterThan(0);
		expect(codes).toContain("blockKeywords");
	});
});

// 醒目留言与会员的门槛(㉓d)是 overrides 里自己的两个切片,投影时要带上 —— 漏了的话改了门槛灵动岛不会亮,保存条出不来。
describe("projectPerUpIsland — superchat / membership 保 nested(门槛)", () => {
	it("改 superchat.minAmount → 'superchat.minAmount',section=interaction", () => {
		const codes = diffCodes({ superchat: { minAmount: 30 } }, { superchat: { minAmount: 50 } });
		expect(codes).toEqual(["superchat.minAmount"]);
		expect(sectionOf("superchat.minAmount")).toBe("interaction");
	});

	it("改 membership.minRank.guard → 'membership.minRank.guard',section=interaction", () => {
		const codes = diffCodes(
			{ membership: { minRank: { guard: 1 } } },
			{ membership: { minRank: { guard: 3 } } },
		);
		expect(codes).toEqual(["membership.minRank.guard"]);
		expect(sectionOf("membership.minRank.guard")).toBe("interaction");
	});

	it("开启门槛覆盖(两段从无到有)→ 检出 dirty,按段报,两段都有名字、归「互动门槛」组", () => {
		const codes = diffCodes(
			{},
			{ superchat: { minAmount: 0 }, membership: { minRank: { guard: 1 } } },
		);
		expect(codes).toEqual(["superchat", "membership"]);
		expect(sectionOf("superchat")).toBe("interaction");
		expect(sectionOf("membership")).toBe("interaction");
		expect(sectionOf("membership.minRank")).toBe("interaction");
	});
});

describe("projectPerUpIsland — templates.membership(上舰文案)落在消息模板组", () => {
	const guard = (over: object) => ({
		enabled: true,
		default: { template: "默认", imageUrl: "" },
		tiers: {},
		...over,
	});

	it("改体系默认文案 / 某一档的文案与图片 / 开关 → 各自的 code,都归 templates 组(字典里有名字,不掉进「其他」)", () => {
		const base = { templates: { membership: { guard: guard({}) } } };
		const edited = {
			templates: {
				membership: {
					guard: guard({
						enabled: false,
						default: { template: "改了的默认", imageUrl: "d.png" },
						tiers: {
							captain: { template: "舰长", imageUrl: "c.png" },
							governor: { template: "总督" },
						},
					}),
				},
			},
		};
		const codes = diffCodes(base, edited);
		expect(codes.sort()).toEqual(
			[
				"templates.membership.guard.default.imageUrl",
				"templates.membership.guard.default.template",
				"templates.membership.guard.enabled",
				"templates.membership.guard.tiers.captain",
				"templates.membership.guard.tiers.governor",
			].sort(),
		);
		for (const code of [
			"templates.membership.guard.default.template",
			"templates.membership.guard.default.imageUrl",
			"templates.membership.guard.enabled",
			// 一档整个从无到有:按整档报,也有名字
			"templates.membership.guard.tiers.captain",
			"templates.membership.guard.tiers.commander",
			"templates.membership.guard.tiers.governor",
			"templates.membership.guard.tiers.captain.template",
			"templates.membership.guard.tiers.captain.imageUrl",
			"templates.membership.guard.tiers.commander.template",
			"templates.membership.guard.tiers.commander.imageUrl",
			"templates.membership.guard.tiers.governor.template",
			"templates.membership.guard.tiers.governor.imageUrl",
		]) {
			expect(sectionOf(code), code).toBe("templates");
		}
	});
});
