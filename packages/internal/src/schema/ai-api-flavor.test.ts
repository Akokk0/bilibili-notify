/**
 * 实例桶的「接口风味」(`apiFlavor`)—— 同一家服务商的两套 wire 协议:
 * chat completions(现状)与 responses(OpenAI 2025 起的接任者)。
 *
 * 默认 `"chat"`:老配置零迁移,谁都不会被静默换协议。哪些家能选 responses
 * 由 providerMeta 的 `supportsResponses` 说了算 —— 确认支持的三家 + custom,
 * 硅基/火山未确认前不开放(选不到必然 404 的组合)。
 */

import { describe, expect, it } from "vite-plus/test";
import { API_FLAVOR_IDS, providerMeta } from "../constants";
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

describe("schema:apiFlavor", () => {
	it("老配置的桶里没有 apiFlavor → 默认 chat,不被静默换协议", () => {
		const ai = AISettingsSchema.parse({
			...BASE,
			providers: { deepseek: { provider: "deepseek" } },
		});
		expect(ai.providers.deepseek?.apiFlavor).toBe("chat");
	});

	it("写明 responses → 原样保留", () => {
		const ai = AISettingsSchema.parse({
			...BASE,
			providers: { ds2: { provider: "deepseek", apiFlavor: "responses" } },
		});
		expect(ai.providers.ds2?.apiFlavor).toBe("responses");
	});

	it("未知风味 → 拒收,不猜", () => {
		const parsed = AISettingsSchema.safeParse({
			...BASE,
			providers: { x: { provider: "deepseek", apiFlavor: "assistants" } },
		});
		expect(parsed.success).toBe(false);
	});

	it("风味枚举封闭:chat 在前作默认位", () => {
		expect(API_FLAVOR_IDS).toEqual(["chat", "responses"]);
	});
});

describe("providerMeta.supportsResponses", () => {
	it("确认支持的三家 + custom 开放,硅基/火山未确认不开放", () => {
		expect(providerMeta("deepseek").supportsResponses).toBe(true);
		expect(providerMeta("bailian").supportsResponses).toBe(true);
		expect(providerMeta("openrouter").supportsResponses).toBe(true);
		expect(providerMeta("custom").supportsResponses).toBe(true);
		expect(providerMeta("siliconflow").supportsResponses).toBe(false);
		expect(providerMeta("volcengine").supportsResponses).toBe(false);
	});
});
