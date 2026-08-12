/**
 * 联网搜索配置段(`ai.search`)—— 搜索后端与 AI 服务商是两个正交的选择。
 *
 * key 按后端**各存一格**(换后端不丢另一家的 key,对齐实例桶「换来换去不必
 * 重敲 key」的纪律);引擎侧三个独立开关**默认全关** —— 搜索按次付费,自动
 * 路径(点评/总结)一旦开了,每条推送都可能烧额度,必须主人亲手点亮。
 */

import { describe, expect, it } from "vite-plus/test";
import { AISettingsSchema } from "./common";

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
			engines: { dynamic: false, live: false, roast: false },
		});
	});

	it("半截的 search 段也补齐 —— 只写 backend,keys/engines 照样有", () => {
		const ai = AISettingsSchema.parse({ ...BASE, search: { backend: "tavily" } });
		expect(ai.search.backend).toBe("tavily");
		expect(ai.search.keys).toEqual({ bocha: "", tavily: "" });
		expect(ai.search.engines.dynamic).toBe(false);
	});

	it("写入值原样往返:换到 Tavily 后博查的 key 还在", () => {
		const ai = AISettingsSchema.parse({
			...BASE,
			search: {
				backend: "tavily",
				keys: { bocha: "sk-bocha", tavily: "tvly-x" },
				engines: { dynamic: true, live: false, roast: true },
			},
		});
		expect(ai.search.keys.bocha).toBe("sk-bocha");
		expect(ai.search.keys.tavily).toBe("tvly-x");
		expect(ai.search.engines).toEqual({ dynamic: true, live: false, roast: true });
	});

	it("未知后端拒收 —— 宁可报错也不猜一家替主人发 key", () => {
		const r = AISettingsSchema.safeParse({ ...BASE, search: { backend: "bing" } });
		expect(r.success).toBe(false);
	});

	it("走过 provider 迁移链的老配置同样补齐 search 段", () => {
		// 上一代「一家一桶」形状:桶键即服务商名,指针字段还叫 provider。
		const ai = AISettingsSchema.parse({
			...BASE,
			provider: "deepseek",
			providers: { deepseek: { apiKey: "k", baseUrl: "https://api.deepseek.com" } },
		});
		expect(ai.activeProfile).toBe("deepseek");
		expect(ai.search.backend).toBe("bocha");
	});
});
