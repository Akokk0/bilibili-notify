/**
 * 单元测试 — `filterDynamic` 纯函数。
 *
 * 业务正确性核心:用户在 advanced-subscription 配的 blockForward / blockArticle /
 * blockKeywords / blockRegex / whitelistKeywords / whitelistRegex 决定动态是否
 * 推送。任何一条逻辑被改坏 = 用户看到漏推 / 推了不该推的。
 *
 * 这是 packages/dynamic 的第一份测试,后续 dynamic-engine 测试可复用这里的 Dynamic
 * 工厂。
 */

import { describe, expect, it } from "vitest";
import { filterDynamic } from "../dynamic-filter";
import { type Dynamic, DynamicFilterReason } from "../types";

function makeDynamic(opts: {
	type?: string;
	text?: string;
	title?: string;
	origText?: string;
}): Dynamic {
	const richNodes = opts.text ? [{ text: opts.text, type: "RICH_TEXT_NODE_TYPE_TEXT" }] : [];
	const orig = opts.origText
		? ({
				modules: {
					module_dynamic: {
						desc: {
							rich_text_nodes: [{ text: opts.origText, type: "RICH_TEXT_NODE_TYPE_TEXT" }],
						},
					},
				},
			} as Dynamic)
		: undefined;
	return {
		type: opts.type ?? "DYNAMIC_TYPE_WORD",
		modules: {
			module_dynamic: {
				desc: { rich_text_nodes: richNodes },
				major: opts.title
					? {
							opus: { title: opts.title, summary: { rich_text_nodes: [] } },
						}
					: undefined,
			},
		},
		orig,
	} as unknown as Dynamic;
}

describe("filterDynamic — 纯函数过滤", () => {
	it("config.enable=false → 默认放行,即使有匹配的 keyword", () => {
		const dyn = makeDynamic({ text: "包含禁词 ABC" });
		expect(filterDynamic(dyn, { enable: false, keywords: ["ABC"] })).toEqual({ blocked: false });
	});

	it("blockForward:DYNAMIC_TYPE_FORWARD 命中阻断", () => {
		const dyn = makeDynamic({ type: "DYNAMIC_TYPE_FORWARD" });
		const result = filterDynamic(dyn, { enable: true, forward: true });
		expect(result.blocked).toBe(true);
		expect(result.reason).toBe(DynamicFilterReason.BlacklistForward);
	});

	it("blockArticle:DYNAMIC_TYPE_ARTICLE 命中阻断", () => {
		const dyn = makeDynamic({ type: "DYNAMIC_TYPE_ARTICLE" });
		const result = filterDynamic(dyn, { enable: true, article: true });
		expect(result.blocked).toBe(true);
		expect(result.reason).toBe(DynamicFilterReason.BlacklistArticle);
	});

	it("blockKeywords:keyword 出现在 text 中阻断", () => {
		const dyn = makeDynamic({ text: "这是包含敏感词的动态" });
		const result = filterDynamic(dyn, { enable: true, keywords: ["敏感词"] });
		expect(result.blocked).toBe(true);
		expect(result.reason).toBe(DynamicFilterReason.BlacklistKeyword);
	});

	it("blockRegex:正则命中阻断", () => {
		const dyn = makeDynamic({ text: "随机内容 12345 数字测试" });
		const result = filterDynamic(dyn, { enable: true, regex: "\\d{5}" });
		expect(result.blocked).toBe(true);
		expect(result.reason).toBe(DynamicFilterReason.BlacklistKeyword);
	});

	it("title / orig 文本也参与匹配(转发 / 专栏文本不漏)", () => {
		const dyn = makeDynamic({ text: "外层", title: "里层标题包含禁词" });
		const result = filterDynamic(dyn, { enable: true, keywords: ["禁词"] });
		expect(result.blocked).toBe(true);

		const dyn2 = makeDynamic({ text: "外层正常", origText: "原动态包含禁词" });
		const result2 = filterDynamic(dyn2, { enable: true, keywords: ["禁词"] });
		expect(result2.blocked).toBe(true);
	});

	it("无效正则:safeRegexTest 不抛错,只跳过该规则", () => {
		const dyn = makeDynamic({ text: "正常文本" });
		const result = filterDynamic(dyn, { enable: true, regex: "[invalid(" });
		expect(result.blocked).toBe(false);
	});

	it("whitelistEnable:无任何 whitelist 规则时不拦截(空规则放行)", () => {
		const dyn = makeDynamic({ text: "任何文本" });
		const result = filterDynamic(dyn, { whitelistEnable: true });
		expect(result.blocked).toBe(false);
	});

	it("whitelistKeywords:不命中任何白名单 → 阻断", () => {
		const dyn = makeDynamic({ text: "普通内容" });
		const result = filterDynamic(dyn, { whitelistEnable: true, whitelistKeywords: ["特定关键词"] });
		expect(result.blocked).toBe(true);
		expect(result.reason).toBe(DynamicFilterReason.WhitelistUnmatched);
	});

	it("whitelistKeywords:命中放行", () => {
		const dyn = makeDynamic({ text: "包含特定关键词的动态" });
		const result = filterDynamic(dyn, { whitelistEnable: true, whitelistKeywords: ["特定关键词"] });
		expect(result.blocked).toBe(false);
	});

	it("黑白名单组合:黑名单优先(命中黑名单即阻断,不考虑白名单)", () => {
		const dyn = makeDynamic({ text: "包含禁词也包含放行词" });
		const result = filterDynamic(dyn, {
			enable: true,
			keywords: ["禁词"],
			whitelistEnable: true,
			whitelistKeywords: ["放行词"],
		});
		expect(result.blocked).toBe(true);
		expect(result.reason).toBe(DynamicFilterReason.BlacklistKeyword);
	});
});
