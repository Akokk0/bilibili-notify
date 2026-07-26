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
export type ProviderExtraField = "thinking" | "vision";

/**
 * 这家该多出哪几项。
 *
 * - `thinking` —— 深度思考开关 + 思考等级。兜底档(自定义)没有:那一档女仆不发任何
 *   服务商专属参数,开关摆着也是死的。
 * - `vision` —— 「主模型支持看图」。DeepSeek 没有:它官方接口里一个视觉模型都没有,
 *   摆出来只会让人勾了发现没用(该走「看图专用模型」那条路)。
 */
export function providerExtraFields(id: AIProviderId): ProviderExtraField[] {
	const meta = providerMeta(id);
	const out: ProviderExtraField[] = [];
	if (meta.supportsThinking) out.push("thinking");
	if (meta.supportsVision) out.push("vision");
	return out;
}
