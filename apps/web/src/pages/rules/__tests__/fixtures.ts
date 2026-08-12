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
		cardStyleByKind: {},
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
		schedule: {
			pushTime: 0,
			restartPush: false,
			quietHours: [],
			liveEndGrace: false,
			liveEndGraceMinutes: 2,
		},
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
			persona,
			dynamicPrompt: "",
			liveSummaryPrompt: "",
			// 一份实例都没添加 = 全新配置。连接与生成参数都住在实例桶里。
			activeProfile: "",
			providers: {},
			chat: {},
			presets: [],
		},
		cardStyle: {
			enabled: true,
			cardColorStart: "#000000",
			cardColorEnd: "#ffffff",
			font: "",
			showPopularity: true,
			showArea: true,
			showFans: true,
			backgroundImages: [],
			liveCoverImages: [],
			glassClear: false,
		},
		imageGroup: { enable: true, forward: false },
		cardLayout: {
			version: 2,
			live: ["cover", "header", "title", "stats", "follower", "desc"].map((id) => ({
				id,
				type: id,
				visible: true,
			})),
			dynamic: ["header", "topic", "content", "stats"].map((id) => ({
				id,
				type: id,
				visible: true,
			})),
			sc: ["amount", "sender", "message"].map((id) => ({ id, type: id, visible: true })),
			guard: {
				badgeSide: "right",
				blocks: ["name", "text"].map((id) => ({ id, type: id, visible: true })),
			},
		},
		messageLayout: {
			version: 1,
			dynamic: {
				blocks: ["card", "text", "link"].map((id) => ({ id, type: id, visible: true })),
				separator: "\n",
			},
			live: {
				blocks: ["card", "text", "link"].map((id) => ({ id, type: id, visible: true })),
				separator: "\n",
			},
		},
		// 空账本 = 刚从老版本升上来的形态(该字段引入前写的 globals.json)。
		// 要测「默认文案有更新」的提示,拿它当基线正合适。
		templateDefaultsSeen: {},
	};
}
