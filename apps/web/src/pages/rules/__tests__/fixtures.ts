/**
 * Rules 页测试共享 fixture —— 完整 GlobalDefaults 字面量(类型要求齐全,但测试
 * 通常只读其中一两个 slice)。非 .test. 文件,vitest 不当测试收集。
 */

import { DEFAULT_FEATURE_FLAGS } from "../../../types/domain";
import type { GlobalDefaults } from "../../../types/globals";

export function makeDefaults(): GlobalDefaults {
	const guard = { imageUrl: "", template: "" };
	const persona = {
		name: "",
		addressUser: "",
		addressSelf: "",
		traits: "",
		catchphrase: "",
		baseRole: "",
		extraSystemPrompt: "",
	};
	return {
		features: { ...DEFAULT_FEATURE_FLAGS },
		filters: {
			blockForward: false,
			blockArticle: false,
			blockDraw: false,
			blockAv: false,
			blockKeywords: [],
			blockRegex: [],
			whitelistKeywords: [],
			whitelistRegex: [],
			minScPrice: 0,
			minGuardLevel: 3,
		},
		schedule: { pushTime: 0, restartPush: false, quietHours: [] },
		templates: {
			liveStart: "",
			liveOngoing: "",
			liveEnd: "",
			liveSummary: "",
			dynamic: "",
			dynamicVideo: "",
			wordcloudStopWords: "",
			specialDanmaku: "",
			specialUserEnter: "",
			guardBuy: { enable: false, captain: guard, commander: guard, governor: guard },
		},
		ai: {
			enabled: false,
			model: "",
			temperature: 0.7,
			persona,
			dynamicPrompt: "",
			liveSummaryPrompt: "",
			presets: [],
		},
		cardStyle: {
			enabled: true,
			cardColorStart: "#000000",
			cardColorEnd: "#ffffff",
			font: "",
			hideDesc: false,
			hideFollower: false,
		},
		imageGroup: { enable: true, forward: false },
	};
}
