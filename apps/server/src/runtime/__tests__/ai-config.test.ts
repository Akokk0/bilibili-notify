/**
 * `toGeneratorConfig` 是 AISettings → 引擎配置的**唯一一处翻译**(常驻 generator、
 * 试一句、锐评三条路共用)。这里钉「接口风味跟桶走」:漏了这一行的症状是
 * 设置页选了 responses、引擎却仍打 chat completions —— 选得动、存得住、就是
 * 不生效,正是 [[pointer-field-orphan-readers]] 那类坑,所以单独钉死。
 */

import { makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { toGeneratorConfig } from "../ai-config";

function aiWith(flavor?: "chat" | "responses") {
	const g = makeDefaultGlobalConfig();
	g.defaults.ai.activeProfile = "p1";
	g.defaults.ai.providers = {
		p1: {
			provider: "deepseek",
			label: "",
			apiKey: "sk-x",
			baseUrl: "https://api.deepseek.com",
			model: "deepseek-v4-pro",
			apiFlavor: flavor ?? "chat",
			temperature: 0.7,
			enableThinking: false,
			thinkingLevel: "medium",
			extraParams: "",
			enableVision: false,
			vision: { baseUrl: "", apiKey: "", model: "" },
		},
	};
	return g.defaults.ai;
}

describe("toGeneratorConfig:接口风味", () => {
	it("桶里选了 responses → 原样递进引擎配置", () => {
		expect(toGeneratorConfig(aiWith("responses")).apiFlavor).toBe("responses");
	});

	it("默认桶(chat)→ 引擎照旧走 chat completions", () => {
		expect(toGeneratorConfig(aiWith()).apiFlavor).toBe("chat");
	});
});
