import { describe, expect, it } from "vite-plus/test";
import { makeEmptySubscription, type Subscription } from "../../../types/domain";
import { isSectionCustomized } from "../section-scope";

/**
 * 「动态过滤」(overrides.filters:block* / allow*)与「直播阈值」(overrides.superchat / membership 两个门槛切片,外加
 * schedule / liveStart / liveStreaming)互相独立:侧栏「已覆盖」小红点按各自域内的字段判定,开其中一个域不会让另一个
 * section 的小点也亮起来。㉓d 之前两个门槛(minScPrice / minGuardLevel)和过滤共用 overrides.filters 一个切片,
 * 那时若只判 `overrides.filters !== undefined` 就会串味;现在各是各的切片,这一组钉住「谁也不牵连谁」。
 */

function subWith(overrides: Subscription["overrides"]): Subscription {
	return { ...makeEmptySubscription({ sourceKey: "bilibili", externalId: "123456" }), overrides };
}

describe("isSectionCustomized filter / live 分域", () => {
	it("只有过滤域覆盖(blockKeywords)→ filter 小点亮、live 小点不亮", () => {
		const sub = subWith({ filters: { blockKeywords: ["广告"] } });
		expect(isSectionCustomized(sub, "filter")).toBe(true);
		expect(isSectionCustomized(sub, "live")).toBe(false);
	});

	it("只有醒目留言门槛覆盖(superchat.minAmount)→ live 小点亮、filter 小点不亮", () => {
		const sub = subWith({ superchat: { minAmount: 30 } });
		expect(isSectionCustomized(sub, "live")).toBe(true);
		expect(isSectionCustomized(sub, "filter")).toBe(false);
	});

	it("金额门槛覆盖写 0 也算覆盖(0 = 这个订阅不设门槛,盖掉全局的 30)", () => {
		expect(isSectionCustomized(subWith({ superchat: { minAmount: 0 } }), "live")).toBe(true);
	});

	it("只有上舰门槛覆盖(membership.minRank.guard)→ live 小点亮、filter 小点不亮;rank 1(全推)也算覆盖", () => {
		const sub = subWith({ membership: { minRank: { guard: 2 } } });
		expect(isSectionCustomized(sub, "live")).toBe(true);
		expect(isSectionCustomized(sub, "filter")).toBe(false);
		expect(isSectionCustomized(subWith({ membership: { minRank: { guard: 1 } } }), "live")).toBe(
			true,
		);
	});

	it("会员门槛里只有别的体系的(今天没有界面)→ 这一节不亮:面板只认 B 站那一项", () => {
		expect(isSectionCustomized(subWith({ membership: { minRank: { other: 2 } } }), "live")).toBe(
			false,
		);
		expect(isSectionCustomized(subWith({ membership: {} }), "live")).toBe(false);
	});

	it("只有 schedule 覆盖 → live 小点亮、filter 小点不亮", () => {
		const sub = subWith({ schedule: { liveEndGraceMinutes: 3 } });
		expect(isSectionCustomized(sub, "live")).toBe(true);
		expect(isSectionCustomized(sub, "filter")).toBe(false);
	});

	// 直播拆键(⑬d):周期间隔与启动补报搬出了 schedule,各自成一段;它们也属于「直播阈值」域,
	// 只覆盖了它们的订阅,侧栏小点照样亮、「推送时段」(拓展订阅那一节)也认。
	it("只有 liveStreaming(周期间隔)覆盖 → live 小点亮、filter 小点不亮;拓展订阅的 schedule 节也亮", () => {
		const sub = subWith({ liveStreaming: { streamingIntervalHours: 3 } });
		expect(isSectionCustomized(sub, "live")).toBe(true);
		expect(isSectionCustomized(sub, "schedule")).toBe(true);
		expect(isSectionCustomized(sub, "filter")).toBe(false);
	});

	it("只有 liveStart(启动补报)覆盖 → live 小点亮、schedule 节也亮", () => {
		const sub = subWith({ liveStart: { catchUpOnBoot: true } });
		expect(isSectionCustomized(sub, "live")).toBe(true);
		expect(isSectionCustomized(sub, "schedule")).toBe(true);
	});

	it("文案覆盖里只写了 liveStreaming(「直播中」那句)→ msg 小点亮", () => {
		expect(isSectionCustomized(subWith({ templates: { liveStreaming: "x" } }), "msg")).toBe(true);
	});

	it("两域都覆盖 → 两个小点都亮", () => {
		const sub = subWith({ filters: { blockKeywords: ["广告"] }, superchat: { minAmount: 30 } });
		expect(isSectionCustomized(sub, "filter")).toBe(true);
		expect(isSectionCustomized(sub, "live")).toBe(true);
	});

	it("无任何覆盖 → 两个小点都不亮", () => {
		const sub = subWith({});
		expect(isSectionCustomized(sub, "filter")).toBe(false);
		expect(isSectionCustomized(sub, "live")).toBe(false);
	});

	it("imageGroup 判定保持不变", () => {
		const sub = subWith({ imageGroup: { enabled: true, mergeForward: false } });
		expect(isSectionCustomized(sub, "imageGroup")).toBe(true);
		expect(isSectionCustomized(sub, "filter")).toBe(false);
	});
});

/**
 * 特别关注是订阅的公共格(不分来源),侧栏小点直接读 `specialUsers`:哪一类事件配了人,
 * 对应那一节的小点就亮,与 overrides 里有没有模板无关;来源不支持的订阅这一格恒空。
 */
describe("isSectionCustomized — 特别关注", () => {
	const withSpecialUsers = (
		identity: Subscription["identity"],
		specialUsers: Subscription["specialUsers"],
	): Subscription => ({ ...makeEmptySubscription(identity), specialUsers });
	const BILI = { sourceKey: "bilibili", externalId: "123456" };

	it("配了特别弹幕的人 → 特别弹幕小点亮、特别进场小点不亮", () => {
		const sub = withSpecialUsers(BILI, [{ uid: "7", kinds: ["danmaku"] }]);
		expect(isSectionCustomized(sub, "specialDanmaku")).toBe(true);
		expect(isSectionCustomized(sub, "specialEnter")).toBe(false);
	});

	it("配了特别进场的人 → 特别进场小点亮、特别弹幕小点不亮", () => {
		const sub = withSpecialUsers(BILI, [{ uid: "7", kinds: ["enter"] }]);
		expect(isSectionCustomized(sub, "specialEnter")).toBe(true);
		expect(isSectionCustomized(sub, "specialDanmaku")).toBe(false);
	});

	it("别的来源的订阅这一格是空的 → 两个小点都不亮", () => {
		const sub = withSpecialUsers({ sourceKey: "douyin", externalId: "sec-1" }, []);
		expect(isSectionCustomized(sub, "specialDanmaku")).toBe(false);
		expect(isSectionCustomized(sub, "specialEnter")).toBe(false);
	});
});

/**
 * AI 那一格判的是「**挑中的人格真实存在**」,而不是 `overrides.ai` 这个键在不在。
 *
 * 盘上有三种指不着人格的老值(当年那档「继承全局」/「完全自定义」、以及指向一份
 * 后来被删掉的人格),它们在 `resolveSubscriptionPersona` 眼里都是完整继承全局,`AiOverrideBox` 也
 * 照实显示成「关」。侧栏小点若只看键在不在,就会在一个明明写着「继承」的分类旁边
 * 亮起来 —— 两处口径打架,而这个文件存在的理由就是不让它们打架。
 */
describe("isSectionCustomized — AI 人格", () => {
	const PRESETS = [{ id: "gentle-maid" }, { id: "tsundere" }];

	it("挑中一份真实存在的人格 → 小点亮", () => {
		expect(isSectionCustomized(subWith({ ai: { preset: "tsundere" } }), "ai", PRESETS)).toBe(true);
	});

	for (const stale of ["inherit", "custom", "deleted-preset-id"]) {
		it(`指不着人格的老值 '${stale}' → 小点不亮(那一格显示的正是「继承」)`, () => {
			expect(isSectionCustomized(subWith({ ai: { preset: stale } }), "ai", PRESETS)).toBe(false);
		});
	}

	it("压根没有 ai 覆盖 → 小点不亮", () => {
		expect(isSectionCustomized(subWith({}), "ai", PRESETS)).toBe(false);
	});
});

describe("isSectionCustomized guard(上舰提示)", () => {
	const guard = (enabled: boolean) => ({
		enabled,
		default: { template: "{viewer} 来了", imageUrl: "" },
		tiers: {},
	});

	it("订阅自己开了 B 站体系的自定义文案(enabled: true)→ 亮", () => {
		const sub = subWith({ templates: { membership: { guard: guard(true) } } });
		expect(isSectionCustomized(sub, "guard")).toBe(true);
	});

	it("订阅里有那一份但没开(enabled: false)→ 不亮:没开就是继承全局", () => {
		const sub = subWith({ templates: { membership: { guard: guard(false) } } });
		expect(isSectionCustomized(sub, "guard")).toBe(false);
	});

	it("只覆盖了别的文案、或别的体系 → 不亮", () => {
		expect(isSectionCustomized(subWith({ templates: { liveStart: "x" } }), "guard")).toBe(false);
		expect(
			isSectionCustomized(subWith({ templates: { membership: { other: guard(true) } } }), "guard"),
		).toBe(false);
		expect(isSectionCustomized(subWith({}), "guard")).toBe(false);
	});
});
