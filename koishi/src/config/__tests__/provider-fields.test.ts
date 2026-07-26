/**
 * koishi 控制台里「选了哪家就只显哪家的选项」——分支依据。
 *
 * 为什么这个决定要单独住在一个不依赖 koishi 的模块里:`AIConfigSchema` 要
 * `import { Schema } from "koishi"`,而**本仓的测试跑不了 koishi 的运行时导入**
 * (既有 koishi 测试清一色只 `import type`;真去 import 会在 cordis/cosmokit 的
 * CJS interop 上炸,开全局 `deps.inline` 又正撞 vite.config.ts 里记着的 vite5/vite6
 * 雷区)。于是把**会写错的那部分**——读哪个能力位、哪家该少哪项——挪到这里钉住,
 * 剩下的只是把这份清单摊进 `Schema.object` 的几行字面映射。
 *
 * 控制台的真实渲染仍然只能手工看,那条在 docs/agents/ai-page-redesign.md 里。
 */

import { AI_PROVIDER_IDS } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { providerExtraFields } from "../provider-fields";

describe("providerExtraFields", () => {
	it("自定义:不给思考两项 —— 那一档女仆什么方言参数都不发,开关摆着也是死的", () => {
		expect(providerExtraFields("custom")).toEqual(["vision"]);
	});

	it("DeepSeek:不给「主模型支持看图」—— 它官方接口里一个视觉模型都没有", () => {
		expect(providerExtraFields("deepseek")).toEqual(["thinking"]);
	});

	it("OpenRouter / 火山 / 硅基:两样都有", () => {
		for (const id of ["openrouter", "volcengine", "siliconflow"] as const) {
			expect(providerExtraFields(id)).toEqual(["thinking", "vision"]);
		}
	});

	it("每一家都至少多出一项 —— 否则那家的分支是个空壳,白占一条 union 分支", () => {
		for (const id of AI_PROVIDER_IDS) {
			expect(providerExtraFields(id).length).toBeGreaterThan(0);
		}
	});

	it("顺序稳定 —— 控制台里字段的先后不该随注册表改动跳动", () => {
		expect(providerExtraFields("openrouter")).toEqual(["thinking", "vision"]);
		expect(providerExtraFields("volcengine")).toEqual(["thinking", "vision"]);
	});
});
