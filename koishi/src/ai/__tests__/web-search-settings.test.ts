/**
 * koishi 配置 → 联网搜索设置的映射。执行器工厂(`webSearchExecutorFromSettings`)
 * 是三端共用的,koishi 这边只负责把自己的扁平字段(webSearchBackend / 两把 key)
 * 折成它认识的形状 —— 判据「当前后端 key 为空 = 未配置」在工厂里,这里不重写。
 */

import { describe, expect, it } from "vite-plus/test";
import type { AIConfig } from "../../config/ai";
import { webSearchSettingsOf } from "../../config/web-search";

const BASE = { enabled: true } as AIConfig;

describe("webSearchSettingsOf", () => {
	it("什么都没填 → 博查在前、key 全空(工厂那侧自然判成未配置)", () => {
		expect(webSearchSettingsOf(BASE)).toEqual({
			backend: "bocha",
			keys: { bocha: "", tavily: "" },
		});
	});

	it("填了后端与各自的 key → 原样折过去,两格互不串", () => {
		expect(
			webSearchSettingsOf({
				...BASE,
				webSearchBackend: "tavily",
				webSearchBochaKey: "sk-bocha",
				webSearchTavilyKey: "tvly-x",
			}),
		).toEqual({
			backend: "tavily",
			keys: { bocha: "sk-bocha", tavily: "tvly-x" },
		});
	});
});
