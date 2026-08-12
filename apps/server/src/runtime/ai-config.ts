/**
 * `AISettings` → `CommentaryGeneratorConfig` —— **唯一一处翻译**。
 *
 * 三条路都要造这个对象:常驻 generator(`engines.ts`,聊天与推送都用它)、AI 页的
 * 「试一句」(吃页面草稿)、统计页的锐评与周报。此前它们各写了一份一模一样的映射,
 * 于是「人格该从哪儿读」这件事有三个答案 —— 修好一处另两处照旧,而类型、构建、
 * lint 全绿。合成一处之后,人格语义只能改一次。
 *
 * 两件事在这里定死:
 *
 * - **连接与生成参数按服务商分桶** —— 取 `provider` 指的那一桶(`resolveAIProfile`)。
 * - **人格看指针** —— 取 `activePreset` 指的那份(`resolveActivePersona`),
 *   **不是** `ai.persona`。后者自指针上线就没有界面入口、永远冻在老值上,直读它
 *   就是「主人换了人格,女仆开口还是原来那位」。
 *
 * 字段名映射:schema 用面向用户的 `baseRole` / `extraSystemPrompt`,引擎的
 * `PersonaConfig` 沿用 `customBase` / `extraPrompt` 历史命名(与 koishi 端一致),
 * 在这里做一次性翻译,引擎层不感知差异。`preset` 恒 `"custom"` —— 人格已在上游
 * 折叠成具体内容,引擎不必再走一次 preset 查表。
 */

import { type AISettings, resolveActivePersona, resolveAIProfile } from "@bilibili-notify/internal";

export function toGeneratorConfig(ai: AISettings) {
	const p = resolveAIProfile(ai);
	const active = resolveActivePersona(ai);
	return {
		apiKey: p.apiKey,
		baseURL: p.baseUrl,
		model: p.model,
		// `temperature` 是 CommentaryGeneratorConfig 的 optional 字段;dashboard 滑块
		// 改值后,config-changed 路径下的 `commentary.updateConfig(...)` 会把新值推到
		// 引擎,下次 chat.completions.create 即生效。
		temperature: p.temperature,
		persona: {
			preset: "custom" as const,
			name: active.persona.name,
			addressUser: active.persona.addressUser,
			addressSelf: active.persona.addressSelf,
			traits: active.persona.traits,
			catchphrase: active.persona.catchphrase,
			customBase: active.persona.baseRole,
			extraPrompt: active.persona.extraSystemPrompt,
		},
		dynamicPrompt: active.dynamicPrompt,
		liveSummaryPrompt: active.liveSummaryPrompt,
		enableConversation: false,
		maxHistory: 6,
		// 方言归属写在桶里 —— activeProfile 只是实例指针,同一家可以有多份实例。
		provider: p.provider,
		// 接口风味同样跟桶走:chat completions(现状)或 responses。
		apiFlavor: p.apiFlavor,
		enableThinking: p.enableThinking,
		thinkingLevel: p.thinkingLevel,
		extraParams: p.extraParams,
		// 主模型自己支持视觉时开它,图直接下挂,省一次往返也不掉保真度。
		// 配了视觉副模型则副模型优先(见 CommentaryGenerator#resolveImages)。
		enableVision: p.enableVision,
		vision: {
			baseURL: p.vision.baseUrl,
			apiKey: p.vision.apiKey,
			model: p.vision.model,
		},
	};
}
