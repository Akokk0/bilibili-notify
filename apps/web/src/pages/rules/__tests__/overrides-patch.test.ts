import { describe, expect, it } from "vite-plus/test";
import type { OverridesShape } from "../../../types/domain";
import { buildOverridesPatch } from "../overrides-patch";

/**
 * 回归:关闭某 per-UP 覆盖框后保存不生效。setSlice 把整段 slice 从草稿删除,
 * 但若 PATCH body 只是「缺这个键」,store deepMerge 当「不改」→ 旧 slice 残留,
 * 灵动岛 diff 永不归零(刚报「已保存」又立刻跳「有改动」)。buildOverridesPatch
 * 必须对「baseline 有、draft 已删」的 slice 回填显式 null(SY1 清除哨兵)。
 */
describe("buildOverridesPatch", () => {
	it("回填 null 清除被关闭的覆盖 slice(imageGroup)", () => {
		const base: OverridesShape = { imageGroup: { enable: false, forward: false } };
		const draft: OverridesShape = {}; // 用户关闭覆盖框 → slice 已删
		const patch = buildOverridesPatch(draft, base);
		expect(patch.imageGroup).toBeNull();
		// JSON 线格式确实带上 null(不会被 JSON.stringify 丢弃)。
		expect(JSON.parse(JSON.stringify(patch))).toEqual({ imageGroup: null });
	});

	it("仍存在的 slice 原样保留、不被 null 化", () => {
		const base: OverridesShape = { imageGroup: { enable: true, forward: false } };
		const draft: OverridesShape = { imageGroup: { enable: false, forward: false } };
		const patch = buildOverridesPatch(draft, base);
		expect(patch.imageGroup).toEqual({ enable: false, forward: false });
	});

	it("baseline 没有的 slice 被关闭 → 不下发 null(无需清除)", () => {
		const patch = buildOverridesPatch({}, {});
		expect("imageGroup" in patch).toBe(false);
		expect(patch).toEqual({});
	});

	it("新开启的 slice 原样下发", () => {
		const patch = buildOverridesPatch({ superchat: { minAmount: 30 } }, {});
		expect(patch.superchat).toEqual({ minAmount: 30 });
	});

	it("清空全部覆盖(draft={}):每个现存 slice 都置 null", () => {
		// 「移除该 UP 个性化配置」走此路径 —— 发空对象不删任何键,须逐 slice null。
		const base: OverridesShape = {
			superchat: { minAmount: 30 },
			membership: { minRank: { guard: 2 } },
			imageGroup: { enable: true, forward: true },
			templates: { liveSummary: "x" },
		};
		const patch = buildOverridesPatch({}, base);
		expect(patch).toEqual({
			superchat: null,
			membership: null,
			imageGroup: null,
			templates: null,
		});
	});

	it("多 slice:一个保留、一个清除", () => {
		const base: OverridesShape = {
			superchat: { minAmount: 30 },
			imageGroup: { enable: true, forward: true },
		};
		const draft: OverridesShape = { superchat: { minAmount: 50 } };
		const patch = buildOverridesPatch(draft, base);
		expect(patch.superchat).toEqual({ minAmount: 50 });
		expect(patch.imageGroup).toBeNull();
	});

	/**
	 * 回归:同一个 slice 里有几个字段、只清掉其中一个而 slice 本身仍非空时,旧写法把
	 * draft.filters 整个原样下发 —— 被删的字段"不提"而非显式 null,服务端
	 * deepMerge 当"不改"→旧值残留,关闭的开关保存后又"复活"。
	 */
	it("slice 内单个字段被删、其余字段仍在 → 该字段回填 null,其余字段原样保留", () => {
		const base: OverridesShape = {
			filters: { blockKeywords: ["广告"], blockReposts: true },
		};
		const draft: OverridesShape = {
			filters: { blockReposts: true }, // blockKeywords 被删除
		};
		const patch = buildOverridesPatch(draft, base);
		expect(patch.filters).toEqual({ blockKeywords: null, blockReposts: true });
	});

	it("嵌套对象内单个字段被删(templates.membership 与 templates.liveStart 共享 templates)", () => {
		const guard = { enabled: true, default: { template: "", imageUrl: "" }, tiers: {} };
		const base: OverridesShape = {
			templates: { liveStart: "开播啦", membership: { guard } },
		};
		const draft: OverridesShape = {
			templates: { liveStart: "开播啦" }, // 会员文案覆盖被关闭
		};
		const patch = buildOverridesPatch(draft, base);
		expect(patch.templates).toEqual({ liveStart: "开播啦", membership: null });
	});

	// 醒目留言与会员的门槛(㉓d)是两个自己的 slice。清掉覆盖必须是显式 null —— 「不下发键」等于什么都没说,旧门槛残留,
	// 关掉的开关保存后又复活(这个仓里反复栽的「关不掉」)。
	it("门槛覆盖整段关掉:superchat 与 membership 各自显式 null,不牵连别的 slice", () => {
		const base: OverridesShape = {
			superchat: { minAmount: 0 },
			membership: { minRank: { guard: 1 } },
			filters: { blockKeywords: ["广告"] },
		};
		const patch = buildOverridesPatch({ filters: { blockKeywords: ["广告"] } }, base);
		expect(patch.superchat).toBeNull();
		expect(patch.membership).toBeNull();
		expect(patch.filters).toEqual({ blockKeywords: ["广告"] });
	});

	it("会员门槛只拿掉 B 站这一项、别的体系的门槛还在 → minRank.guard 回填 null,别的体系原样", () => {
		const base: OverridesShape = { membership: { minRank: { guard: 2, other: 3 } } };
		const draft: OverridesShape = { membership: { minRank: { other: 3 } } };
		expect(buildOverridesPatch(draft, base).membership).toEqual({
			minRank: { guard: null, other: 3 },
		});
	});

	it("门槛写成 0 / rank 1 是真值:原样下发,不当作「清空」", () => {
		const patch = buildOverridesPatch(
			{ superchat: { minAmount: 0 }, membership: { minRank: { guard: 1 } } },
			{ superchat: { minAmount: 30 }, membership: { minRank: { guard: 2 } } },
		);
		expect(patch.superchat).toEqual({ minAmount: 0 });
		expect(patch.membership).toEqual({ minRank: { guard: 1 } });
	});

	it("上舰文案某一档清空一格 → 那一格 null;整档拿掉 → 那一档 null;体系默认原样", () => {
		const guard = (tiers: Record<string, object>) => ({
			enabled: true,
			default: { template: "默认 {viewer}", imageUrl: "" },
			tiers,
		});
		const base: OverridesShape = {
			templates: {
				membership: {
					guard: guard({
						captain: { template: "舰长专属", imageUrl: "c.png" },
						governor: { template: "总督专属" },
					}),
				},
			},
		};
		const draft: OverridesShape = {
			templates: {
				membership: {
					guard: guard({ captain: { template: "舰长专属" } }),
				},
			},
		};
		const patch = buildOverridesPatch(draft, base);
		expect(patch.templates).toEqual({
			membership: {
				guard: {
					enabled: true,
					default: { template: "默认 {viewer}", imageUrl: "" },
					tiers: { captain: { template: "舰长专属", imageUrl: null }, governor: null },
				},
			},
		});
	});
});
