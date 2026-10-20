/**
 * 「模板变量可满足性」的静态一半:默认文案里的变量都在表里,表里的字段都来自中立类型。
 *
 * 表是给面板提示条与运行时探针共用的规格:`TEMPLATE_VARIABLES` 每条文案 → 它能用的变量 →
 * 变量取的中立字段。这里只验表与默认文案、字段命名的一致性;真正跑渲染入口的探针在
 * `apps/server/src/__tests__/template-variables-satisfiable.test.ts`。
 */

import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_TEMPLATES } from "../constants";
import { placeholdersOf } from "../i18n";
import { TEMPLATE_VARIABLES, type TemplateKey } from "../template-variables";

/**
 * 每条有出厂默认的文案。宣告语不是默认文案(由来源的档位表交来),单独留在表里,
 * 所以这里少一格;下面那条反向断言钉住「少的那一格只许是它」。
 */
const DEFAULT_TEXT_OF: Record<Exclude<TemplateKey, "membershipAnnouncement">, string> = {
	post: DEFAULT_TEMPLATES.post,
	postVideo: DEFAULT_TEMPLATES.postVideo,
	liveStart: DEFAULT_TEMPLATES.liveStart,
	liveStreaming: DEFAULT_TEMPLATES.liveStreaming,
	liveEnd: DEFAULT_TEMPLATES.liveEnd,
	liveSummary: DEFAULT_TEMPLATES.liveSummary,
	viewerChat: DEFAULT_TEMPLATES.viewerChat,
	viewerEnter: DEFAULT_TEMPLATES.viewerEnter,
	membership: DEFAULT_TEMPLATES.membership.guard.default.template,
};

describe("默认文案 ⊆ 模板变量表", () => {
	it("表里除宣告语外每条文案都有默认文案", () => {
		expect(Object.keys(DEFAULT_TEXT_OF).sort()).toEqual(
			Object.keys(TEMPLATE_VARIABLES)
				.filter((key) => key !== "membershipAnnouncement")
				.sort(),
		);
	});

	it.each(Object.entries(DEFAULT_TEXT_OF))("%s 的默认文案只用了表里登记过的变量", (key, text) => {
		const declared = new Set(Object.keys(TEMPLATE_VARIABLES[key as TemplateKey]));
		// `placeholdersOf` 认 `\{(\w+)\}`;运行时 `interpolate` 认 `[\w.]+`。模板里今天没有
		// 带点的变量,所以两者取出来的一样;真出现 `{a.b}` 时这里认不出来(这一条会漏检)。
		// 表里的变量名另由 (c) 钉成 `\w+`,所以带点的名字也不会进面板提示或运行时探针。
		expect(placeholdersOf(text).filter((name) => !declared.has(name))).toEqual([]);
	});
});

describe("表里的字段与变量名", () => {
	/**
	 * `field` 的第一段:允许的中立类型。名单照方案 §7:作品 / 资料 / 直播场次 / 观众事件 /
	 * 会员 / 回顾快照。只有这些类型填得出的变量才配进表,B 站专有的名字进不来。
	 */
	const NEUTRAL_FIELD_ROOTS = new Set([
		"Creator",
		"CreatorProfile",
		"LiveSession",
		"LiveDetails",
		"ViewerChatEvent",
		"ViewerEnterEvent",
		"RecapSnapshot",
		"MembershipEvent",
		"MembershipTier",
		"Post",
		"PostEvent",
		"SourceDescriptor",
	]);

	/** 这些是 0.x / B 站专有的变量名,或与体系键重名的旧写法;表里不许再出现。 */
	const FORBIDDEN_VARIABLE_NAMES = new Set([
		"mdn",
		"guard",
		"mastername",
		"uname",
		"mname",
		"medal",
	]);

	const variables = Object.entries(TEMPLATE_VARIABLES).flatMap(([key, entry]) =>
		Object.entries(entry).map(([variable, spec]) => [key, variable, spec.field] as const),
	);

	it.each(variables)("%s.%s 的字段以中立类型开头", (_key, _variable, field) => {
		const root = field.split(".")[0];
		expect(root).toBeDefined();
		expect(NEUTRAL_FIELD_ROOTS.has(root as string)).toBe(true);
	});

	it.each(variables)("%s.%s 是占位符语法认得的变量名", (_key, variable) => {
		expect(variable).toMatch(/^\w+$/);
	});

	it.each(variables)("%s.%s 不是 0.x / B 站专有的旧名", (_key, variable) => {
		expect(FORBIDDEN_VARIABLE_NAMES.has(variable)).toBe(false);
	});

	it.each(variables)("%s.%s 的字段非空", (_key, _variable, field) => {
		expect(field.trim()).not.toBe("");
	});
});
