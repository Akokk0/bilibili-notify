import { i18n } from "../../i18n";
/**
 * CSS 框旁那颗「请女仆帮忙写」按不按得动(ADR-0015 决策 10 与它的 🔗)。
 *
 * 判据与服务端建 AI 实例那一条同源(`runtime/pipeline.ts` 的 `!p.apiKey || !p.baseUrl`):
 * 当前实例的 key 与地址都填了。GET 回来的 key 是遮挡(`{ masked }`),没配是空串:「有值 = 配了」照常成立。
 * 「智能女仆」总开关不管这颗钮 —— 那是聊天的闸,dashboard 的「让女仆改」也不看它。
 *
 * 按不动时必须说得出为什么:让人填完需求、等一圈、再被服务端拒绝(没配模型是 `not_configured`)是最气人的那一种。
 */

import type { GlobalSettingsView } from "@bilibili-notify/contract";
import { resolveAIProfile } from "@bilibili-notify/internal/ai";

export type CardSkinAiReadiness = { ready: true } | { ready: false; reason: string };

export function cardSkinAiReadiness(input: {
	globals: GlobalSettingsView | undefined;
	/** 内置的默认皮肤:草稿改得动但存不下来。 */
	readOnly: boolean;
}): CardSkinAiReadiness {
	if (input.readOnly) {
		return {
			ready: false,
			reason: i18n.t("skinUi.card-skin-ai.1"),
		};
	}
	if (!input.globals) return { ready: false, reason: i18n.t("skinUi.card-skin-ai.2") };
	// 编辑器的测试里 globals 常是个空对象;真配置里 ai 那一段也可能整个缺席。
	const ai = input.globals.ai;
	const profile = ai ? resolveAIProfile(ai) : undefined;
	if (!profile?.apiKey || !profile.baseUrl) {
		return {
			ready: false,
			reason: i18n.t("skinUi.card-skin-ai.3"),
		};
	}
	return { ready: true };
}
