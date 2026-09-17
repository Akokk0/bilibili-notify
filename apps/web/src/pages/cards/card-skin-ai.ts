/**
 * CSS 框旁那颗「请女仆帮忙写」按不按得动(ADR-0015 决策 10 与它的 🔗)。
 *
 * 判据与服务端建 AI 实例那一条同源(`runtime/engines.ts` 的 `!p.apiKey || !p.baseUrl`):
 * 当前实例的 key 与地址都填了。GET 回来的 key 是脱敏占位,但「非空 = 配了」照常成立。
 * 「智能女仆」总开关不管这颗钮 —— 那是聊天的闸,dashboard 的「让女仆改」也不看它。
 *
 * 按不动时必须说得出为什么:让人填完需求、等一圈、再被 503 拒绝是最气人的那一种。
 */

import type { GlobalConfig } from "@bilibili-notify/internal";
import { resolveAIProfile } from "@bilibili-notify/internal/constants";

export type CardSkinAiReadiness = { ready: true } | { ready: false; reason: string };

export function cardSkinAiReadiness(input: {
	globals: GlobalConfig | undefined;
	/** 内置的默认皮肤:草稿改得动但存不下来。 */
	readOnly: boolean;
}): CardSkinAiReadiness {
	if (input.readOnly) {
		return {
			ready: false,
			reason: "内置的默认皮肤改不了 —— 先回卡片页「复制一份」,再请女仆写",
		};
	}
	if (!input.globals) return { ready: false, reason: "正在读取模型配置…" };
	// 编辑器的测试里 globals 常是个空对象;真配置里 ai 那一段也可能整个缺席。
	const ai = input.globals.defaults?.ai;
	const profile = ai ? resolveAIProfile(ai) : undefined;
	if (!profile?.apiKey || !profile.baseUrl) {
		return {
			ready: false,
			reason: "还没配好模型 —— 到「智能女仆」页把当前服务商的 API Key 与接口地址填上",
		};
	}
	return { ready: true };
}
