/**
 * 「选了哪家就只显哪家的选项」的分支依据。
 *
 * **刻意不 import koishi** —— 这个文件是给 `ai.ts` 里那圈 `Schema.union` 喂数据的,
 * 同时也是这套分支唯一能自动验证的部分:本仓测试跑不了 koishi 的运行时导入(既有
 * koishi 测试清一色只 `import type`),所以把「读哪个能力位、哪家该少哪项」这个真会
 * 写错的决定挪到这里,`ai.ts` 那边只剩把清单摊进 `Schema.object` 的几行字面映射。
 */

import { type AIProviderId, providerMeta } from "@bilibili-notify/internal";

/** 某家在通用字段之外还该显示的那些。顺序即控制台里的先后。 */
export type ProviderExtraField = "flavor" | "thinking" | "vision";

/**
 * 这家该多出哪几项。
 *
 * - `flavor` —— 「接口风味」(chat / responses)。只给确认有 Responses API 的家:
 *   未确认支持的家不开放,免得选出必然 404 的组合。
 * - `thinking` —— 深度思考开关 + 思考等级。兜底档(自定义)没有:那一档女仆不发任何
 *   服务商专属参数,开关摆着也是死的。
 * - `vision` —— 「主模型支持看图」。DeepSeek 没有:它官方接口里一个视觉模型都没有,
 *   摆出来只会让人勾了发现没用(该走「看图专用模型」那条路)。
 */
export function providerExtraFields(id: AIProviderId): ProviderExtraField[] {
	const meta = providerMeta(id);
	const out: ProviderExtraField[] = [];
	if (meta.supportsResponses) out.push("flavor");
	if (meta.supportsThinking) out.push("thinking");
	if (meta.supportsVision) out.push("vision");
	return out;
}

/**
 * 这家是不是「选了 responses 风味才解禁思考」—— 即常规清单里没有思考两项、但
 * 风味选项在。Responses 协议里思考是标准字段(`reasoning.effort`),不再依赖各家
 * 方言适配,所以自定义档在这条路上例外地能开思考(OpenAI 官方正是经此接入)。
 * `ai.ts` 用它决定要不要给这家多铺一条「responses 分支带思考两项」的 union。
 */
export function flavorUnlocksThinking(id: AIProviderId): boolean {
	const meta = providerMeta(id);
	return !meta.supportsThinking && meta.supportsResponses;
}
