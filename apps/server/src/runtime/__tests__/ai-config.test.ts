/**
 * `toGeneratorConfig` 是 AISettings → 引擎配置的**唯一一处翻译**(常驻 generator、
 * 试一句、锐评三条路共用)。这里钉「接口风味跟桶走」:漏了这一行的症状是
 * 设置页选了 responses、引擎却仍打 chat completions —— 选得动、存得住、就是
 * 不生效,正是 [[pointer-field-orphan-readers]] 那类坑,所以单独钉死。
 */

import { makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { builtinPresetsFor } from "@bilibili-notify/internal/texts/builtin";
import { describe, expect, it } from "vite-plus/test";
import { toGeneratorConfig } from "../ai-config";

const BUILTINS = builtinPresetsFor("zh-CN");

function aiWith(flavor?: "chat" | "responses") {
	const g = makeDefaultGlobalConfig();
	g.ai.activeProfile = "p1";
	g.ai.providers = {
		p1: {
			provider: "deepseek",
			label: "",
			apiKey: "sk-x",
			baseUrl: "https://api.deepseek.com",
			model: "deepseek-v4-pro",
			apiFlavor: flavor ?? "chat",
			enableThinking: false,
			thinkingLevel: "medium",
			extraParams: "",
			enableVision: false,
			vision: { baseUrl: "", apiKey: "", model: "" },
		},
	};
	return g.ai;
}

describe("toGeneratorConfig:接口风味", () => {
	it("桶里选了 responses → 原样递进引擎配置", () => {
		expect(toGeneratorConfig(aiWith("responses"), BUILTINS).apiFlavor).toBe("responses");
	});

	it("默认桶(chat)→ 引擎照旧走 chat completions", () => {
		expect(toGeneratorConfig(aiWith(), BUILTINS).apiFlavor).toBe("chat");
	});
});

describe("toGeneratorConfig:temperature 已退役", () => {
	// 一律不发、走服务商默认(推理模型收到它直接 400)。引擎配置里连这一格都不该有 ——
	// 想调的主人从额外请求参数写,那一格照常递过去。
	it("引擎配置里没有 temperature,额外参数原样递过去", () => {
		const ai = aiWith();
		const p1 = ai.providers.p1;
		if (!p1) throw new Error("fixture 缺 p1");
		p1.extraParams = '{"temperature": 1.3}';
		const cfg = toGeneratorConfig(ai, BUILTINS);
		expect("temperature" in cfg).toBe(false);
		expect(cfg.extraParams).toBe('{"temperature": 1.3}');
	});
});

describe("toGeneratorConfig:人格", () => {
	it("指针指内置:人格取传进来的(当前语言)那份,不在设置里读", () => {
		const ai = aiWith();
		ai.activePreset = "tsundere";
		const swapped = BUILTINS.map((p) => ({
			...p,
			persona: { ...p.persona, name: `X-${p.persona.name}` },
		}));
		const cfg = toGeneratorConfig(ai, swapped);
		expect(cfg.persona.name).toBe("X-凛子");
		expect(cfg.dynamicPrompt).toBe(swapped[1]?.dynamicPrompt);
	});

	it("指针指主人自己的:取它", () => {
		const ai = aiWith();
		ai.presets = [
			{
				id: "mine",
				label: "我的",
				persona: { ...(BUILTINS[0]?.persona as object), name: "阿绫" } as never,
				dynamicPrompt: "就照这个说",
			},
		];
		ai.activePreset = "mine";
		const cfg = toGeneratorConfig(ai, BUILTINS);
		expect(cfg.persona.name).toBe("阿绫");
		expect(cfg.dynamicPrompt).toBe("就照这个说");
		expect(cfg.liveSummaryPrompt).toBe(BUILTINS[0]?.liveSummaryPrompt);
	});
});
