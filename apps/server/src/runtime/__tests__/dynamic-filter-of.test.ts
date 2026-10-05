/**
 * `dynamicFilterOf`:配置里的内容过滤(1.0 的键名)→ 动态过滤引擎吃的 `DynamicFilterConfig`(引擎自己的字段名这一步没改:
 * `forward` / `article` / `draw` / `av` / `whitelist*`)。
 *
 * 这是配置键改名(㉑a)里唯一一处「两边名字对不上」的接线:改名时抄错一格(把 `blockImages` 接到 `article` 上之类),
 * 类型照过、各自的单元测试照绿,只有推送时该挡的动态没被挡。所以一个类型开关一条,钉死「哪个键接到引擎的哪一格」。
 */

import { type ContentFilters, DEFAULT_CONTENT_FILTERS } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { dynamicFilterOf } from "../engines.js";

function filters(over: Partial<ContentFilters> = {}): ContentFilters {
	return { ...DEFAULT_CONTENT_FILTERS, ...over };
}

describe("dynamicFilterOf —— 配置键接到引擎的哪一格", () => {
	it("出厂的过滤:什么都不挡、白名单不启用", () => {
		expect(dynamicFilterOf(filters())).toEqual({
			enable: false,
			notify: false,
			regex: "",
			keywords: [],
			forward: false,
			article: false,
			draw: false,
			av: false,
			whitelistEnable: false,
			whitelistRegex: "",
			whitelistKeywords: [],
		});
	});

	it.each([
		["blockReposts", "forward"],
		["blockArticles", "article"],
		["blockImages", "draw"],
		["blockVideos", "av"],
	] as const)("类型开关 %s 只接到引擎的 %s,并让屏蔽整体生效", (key, engineField) => {
		const out = dynamicFilterOf(filters({ [key]: true }));
		const engineSwitches = { forward: false, article: false, draw: false, av: false };
		expect({
			forward: out.forward,
			article: out.article,
			draw: out.draw,
			av: out.av,
		}).toEqual({ ...engineSwitches, [engineField]: true });
		expect(out.enable).toBe(true);
		expect(out.whitelistEnable).toBe(false);
	});

	it("屏蔽的关键词与正则:正则数组用 | 合并,有内容就让屏蔽整体生效", () => {
		const out = dynamicFilterOf(
			filters({ blockKeywords: ["广告"], blockRegex: ["^抽奖", "福利$"] }),
		);
		expect(out.keywords).toEqual(["广告"]);
		expect(out.regex).toBe("^抽奖|福利$");
		expect(out.enable).toBe(true);
	});

	it("白名单 allowKeywords / allowRegex 接到引擎的 whitelistKeywords / whitelistRegex,有内容就启用白名单,不连带屏蔽", () => {
		const out = dynamicFilterOf(
			filters({ allowKeywords: ["新歌"], allowRegex: ["^上新", "首发$"] }),
		);
		expect(out.whitelistKeywords).toEqual(["新歌"]);
		expect(out.whitelistRegex).toBe("^上新|首发$");
		expect(out.whitelistEnable).toBe(true);
		expect(out.enable).toBe(false);
	});

	it("只写了一种白名单(只有关键词、或只有正则)也启用", () => {
		expect(dynamicFilterOf(filters({ allowKeywords: ["新歌"] })).whitelistEnable).toBe(true);
		expect(dynamicFilterOf(filters({ allowRegex: ["^上新"] })).whitelistEnable).toBe(true);
	});
});
