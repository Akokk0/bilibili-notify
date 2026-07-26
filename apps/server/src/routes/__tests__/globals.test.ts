import { makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { shouldRunAiEnableCheck } from "../globals.js";

/** 默认 globals + AI 启用 + 连接字段齐备。 */
function enabledAiGlobals() {
	const g = makeDefaultGlobalConfig();
	g.defaults.ai.enabled = true;
	// 连接字段住在服务商桶里(各家一套配置)。
	g.defaults.ai.provider = "deepseek";
	g.defaults.ai.providers = {
		deepseek: {
			apiKey: "k",
			baseUrl: "https://api.example.com",
			model: "gpt-4o-mini",
			temperature: 0.7,
			enableThinking: false,
			thinkingLevel: "medium",
			extraParams: "",
			enableVision: false,
			vision: { baseUrl: "", apiKey: "", model: "" },
		},
	};
	return g;
}

/** 把桶内字段包成 patch 形状。 */
function aiPatch(bucket: Record<string, unknown>, id = "deepseek") {
	return { defaults: { ai: { providers: { [id]: bucket } } } };
}

describe("shouldRunAiEnableCheck", () => {
	it("改 persona 不触发探活", () => {
		const cur = enabledAiGlobals();
		expect(shouldRunAiEnableCheck(cur, { defaults: { ai: { persona: { name: "恶魔兔" } } } })).toBe(
			false,
		);
	});

	it("改 temperature / prompt 不触发探活", () => {
		const cur = enabledAiGlobals();
		expect(shouldRunAiEnableCheck(cur, { defaults: { ai: { temperature: 0.9 } } })).toBe(false);
		expect(shouldRunAiEnableCheck(cur, { defaults: { ai: { dynamicPrompt: "x" } } })).toBe(false);
	});

	it("改连接字段 apiKey / baseUrl / model 触发探活", () => {
		const cur = enabledAiGlobals();
		expect(shouldRunAiEnableCheck(cur, aiPatch({ apiKey: "k2" }))).toBe(true);
		expect(shouldRunAiEnableCheck(cur, aiPatch({ baseUrl: "https://x" }))).toBe(true);
		expect(shouldRunAiEnableCheck(cur, aiPatch({ model: "m2" }))).toBe(true);
	});

	it("换服务商就触发探活 —— 换家等于换连接,新那家的 key 还没验过", () => {
		const cur = enabledAiGlobals(); // 当前是 deepseek
		expect(shouldRunAiEnableCheck(cur, { defaults: { ai: { provider: "openrouter" } } })).toBe(
			true,
		);
	});

	it("改的是**别家**桶里的连接字段 → 不触发探活(那家现在没在用)", () => {
		// 探活会真打一次请求。为一个不生效的桶去打,既慢又可能报出让人困惑的错。
		const cur = enabledAiGlobals();
		expect(shouldRunAiEnableCheck(cur, aiPatch({ apiKey: "k2" }, "openrouter"))).toBe(false);
	});

	it("enabled 由 false→true 触发探活(即使本次没带连接字段)", () => {
		const cur = enabledAiGlobals();
		cur.defaults.ai.enabled = false;
		expect(shouldRunAiEnableCheck(cur, { defaults: { ai: { enabled: true } } })).toBe(true);
	});

	it("AI 最终为禁用态:改任何字段都不探活", () => {
		const cur = makeDefaultGlobalConfig(); // disabled
		expect(shouldRunAiEnableCheck(cur, { defaults: { ai: { persona: { name: "x" } } } })).toBe(
			false,
		);
		expect(shouldRunAiEnableCheck(cur, aiPatch({ apiKey: "k2" }))).toBe(false);
	});

	it("已启用态重复保存 persona(enabled 维持 true)不触发探活", () => {
		const cur = enabledAiGlobals();
		expect(
			shouldRunAiEnableCheck(cur, { defaults: { ai: { enabled: true, persona: { name: "x" } } } }),
		).toBe(false);
	});

	it("patch 含连接字段但值跟 current 相同 → 不触发探活(前端整段 patch 兼容)", () => {
		const cur = enabledAiGlobals();
		// 模拟 Ai.tsx 现状:用户只改 persona,但前端把整段 defaults.ai 送上,
		// baseUrl/model 跟 current 完全一致(apiKey 经 stripRedactedSecrets 已剔除)。
		const p = cur.defaults.ai.providers.deepseek;
		expect(
			shouldRunAiEnableCheck(cur, {
				defaults: {
					ai: {
						providers: { deepseek: { baseUrl: p?.baseUrl, model: p?.model } },
						persona: { name: "恶魔兔" },
					},
				},
			}),
		).toBe(false);
	});

	it("patch 含连接字段且 baseUrl 真改了 → 触发探活", () => {
		const cur = enabledAiGlobals();
		expect(
			shouldRunAiEnableCheck(cur, {
				defaults: {
					ai: {
						providers: {
							deepseek: {
								baseUrl: "https://api.example.com/v2", // changed
								model: cur.defaults.ai.providers.deepseek?.model, // unchanged
							},
						},
					},
				},
			}),
		).toBe(true);
	});

	it("patch 含连接字段且 model 真改了 → 触发探活", () => {
		const cur = enabledAiGlobals();
		expect(
			shouldRunAiEnableCheck(cur, {
				defaults: {
					ai: {
						providers: {
							deepseek: {
								baseUrl: cur.defaults.ai.providers.deepseek?.baseUrl, // unchanged
								model: "gpt-4o", // changed
							},
						},
					},
				},
			}),
		).toBe(true);
	});
});
