/**
 * 联网搜索配置段(`ai.search`)—— 搜索后端与 AI 服务商是两个正交的选择。
 *
 * key 按后端**各存一格**(换后端不丢另一家的 key,对齐实例桶「换来换去不必
 * 重敲 key」的纪律);引擎侧三个独立开关**默认全关** —— 搜索按次付费,自动
 * 路径(点评/总结)一旦开了,每条推送都可能烧额度,必须主人亲手点亮。
 */

import { describe, expect, it } from "vite-plus/test";
import { AISettingsSchema } from "../common";

const BASE = {
	enabled: true,
	persona: {
		name: "",
		addressUser: "",
		addressSelf: "",
		traits: "",
		catchphrase: "",
		baseRole: "",
		extraSystemPrompt: "",
	},
	dynamicPrompt: "",
	liveSummaryPrompt: "",
	presets: [],
};

describe("schema:ai.search", () => {
	it("老配置没有 search 段 → 全套默认:博查在前、key 全空、引擎全关", () => {
		const ai = AISettingsSchema.parse(BASE);
		expect(ai.search).toEqual({
			backend: "bocha",
			keys: { bocha: "", tavily: "" },
			scenes: { post: false, live: false, roast: false },
		});
	});

	it("半截的 search 段也补齐 —— 只写 backend,keys/scenes 照样有", () => {
		const ai = AISettingsSchema.parse({ ...BASE, search: { backend: "tavily" } });
		expect(ai.search.backend).toBe("tavily");
		expect(ai.search.keys).toEqual({ bocha: "", tavily: "" });
		expect(ai.search.scenes.post).toBe(false);
	});

	it("写入值原样往返:换到 Tavily 后博查的 key 还在", () => {
		const ai = AISettingsSchema.parse({
			...BASE,
			search: {
				backend: "tavily",
				keys: { bocha: "sk-bocha", tavily: "tvly-x" },
				scenes: { post: true, live: false, roast: true },
			},
		});
		expect(ai.search.keys.bocha).toBe("sk-bocha");
		expect(ai.search.keys.tavily).toBe("tvly-x");
		expect(ai.search.scenes).toEqual({ post: true, live: false, roast: true });
	});

	it("未知后端拒收 —— 宁可报错也不猜一家替主人发 key", () => {
		const r = AISettingsSchema.safeParse({ ...BASE, search: { backend: "bing" } });
		expect(r.success).toBe(false);
	});
});

describe("search scenes", () => {
	it("defaults to independent post, live and roast scenes without legacy keys", () => {
		expect(AISettingsSchema.parse(BASE).search).toEqual({
			backend: "bocha",
			keys: { bocha: "", tavily: "" },
			scenes: { post: false, live: false, roast: false },
		});
	});
});

describe("search scene validation", () => {
	it.each([
		[{}, { post: false, live: false, roast: false }],
		[{ scenes: {} }, { post: false, live: false, roast: false }],
		[{ scenes: { post: true } }, { post: true, live: false, roast: false }],
	])("fills only missing switches for %j", (search, expected) => {
		expect(AISettingsSchema.parse({ ...BASE, search }).search.scenes).toEqual(expected);
	});
	it.each([null, [], false, "false", 7])("does not coerce an invalid scene bag: %j", (scenes) => {
		expect(AISettingsSchema.safeParse({ ...BASE, search: { scenes } }).success).toBe(false);
	});
	it.each([null, "false", 0])("does not coerce an invalid switch: %j", (post) => {
		expect(AISettingsSchema.safeParse({ ...BASE, search: { scenes: { post } } }).success).toBe(
			false,
		);
	});
	it("strips unknown keys and never reads the old bag", () => {
		expect(
			AISettingsSchema.parse({
				...BASE,
				search: {
					extra: 1,
					engines: { dynamic: true, live: true, roast: true },
					scenes: { post: false, live: true, dynamic: true, other: true },
				},
			}).search,
		).toEqual({
			backend: "bocha",
			keys: { bocha: "", tavily: "" },
			scenes: { post: false, live: true, roast: false },
		});
	});
});
