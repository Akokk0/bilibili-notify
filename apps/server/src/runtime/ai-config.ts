/**
 * `AiSettings` → `CommentaryGeneratorSettings` —— **唯一一处翻译**。
 *
 * 三条路都要造这个对象:常驻 generator(`pipeline.ts`,聊天与推送都用它)、AI 页的
 * 「试一句」(吃页面草稿)、统计页的锐评与周报。此前它们各写了一份一模一样的映射,
 * 于是「人格该从哪儿读」这件事有三个答案 —— 修好一处另两处照旧,而类型、构建、
 * lint 全绿。合成一处之后,人格语义只能改一次。
 *
 * 两件事在这里定死:
 *
 * - **连接与生成参数按服务商分桶** —— 取 `provider` 指的那一桶(`resolveAIProfile`)。
 * - **人格看指针** —— 取 `activePreset` 指的那份(`resolveActivePersona`)。内置那几份
 *   不在设置里、内容按当前语言取,所以调用方要把当前语言的内置人格(`builtinPersonasOf`)传进来;
 *   谁绕开这一处自己翻 `presets`,就是「主人换了人格 / 语言,女仆开口还是原来那位」。
 *
 * 字段名映射:schema 用面向用户的 `baseRole` / `extraSystemPrompt`,AI 生成器的
 * `CommentaryPersonaSettings` 沿用 `customBase` / `extraPrompt` 历史命名,
 * 在这里做一次性翻译,推送链路不感知差异。
 */

import type { CommentaryCallOverride } from "@bilibili-notify/ai";
import {
	type ActivePersonaShape,
	type AIBuiltinPresetShape,
	type AiSettings,
	resolveActivePersona,
	resolveAIProfile,
	resolveSubscriptionPersona,
	type Subscription,
} from "@bilibili-notify/internal";
import { textSettingsOf } from "@bilibili-notify/internal/i18n";
import { builtinPresetsFor } from "@bilibili-notify/internal/texts/builtin";

/** 此刻(设置里的语言)的内置人格:设置里不存它们的内容,每次按当前语言取。 */
export function builtinPersonasOf(settings: Parameters<typeof textSettingsOf>[0]) {
	return builtinPresetsFor(textSettingsOf(settings).locale);
}

export function toGeneratorConfig(ai: AiSettings, builtins: readonly AIBuiltinPresetShape[]) {
	const p = resolveAIProfile(ai);
	const active = resolveActivePersona(ai, builtins);
	return {
		apiKey: p.apiKey,
		baseURL: p.baseUrl,
		model: p.model,
		persona: {
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

/**
 * 一条订阅的 per-UP AI 覆盖 —— 没配就是 `undefined`。留空时生成器走当前全局配置，
 * 所以这里不能把全局值折进来冻成快照。
 */
export function resolveAiOverride(
	sub: Subscription,
	ai: AiSettings,
	builtins: readonly AIBuiltinPresetShape[],
): CommentaryCallOverride | undefined {
	return sub.overrides.ai
		? buildAiOverride(resolveSubscriptionPersona(ai, sub.overrides.ai, builtins))
		: undefined;
}

function buildAiOverride(active: ActivePersonaShape): CommentaryCallOverride {
	return {
		persona: {
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
	};
}
