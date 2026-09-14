/**
 * Rules 页测试共享 fixture —— 完整 GlobalDefaults 字面量(类型要求齐全,但测试
 * 通常只读其中一两个 slice)。非 .test. 文件,vitest 不当测试收集。
 *
 * **唯一的例外是旧卡片版式那一档**(ADR-0014 决策 15 已把它整个退役):服务端的
 * globals schema 还留着那个键、只为一次性迁移读一遍,面板从此一个字也不碰 ——
 * fixture 再构造它,就是在面板代码里给一个死字段留最后一处引用。`satisfies
 * Partial<GlobalDefaults>` 照旧钉住每个键的形状与拼写(写错 / 多打一个照样红),
 * 返回时用「这份 fixture 没写到的那些键」把类型补齐,不点那个键的名字。
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
	const defaults = {
		features: { ...DEFAULT_FEATURE_FLAGS },
		cardStyleByKind: {},
		cardSkin: "default",
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
			search: {
				backend: "bocha",
				keys: { bocha: "", tavily: "" },
				engines: { dynamic: false, live: false, roast: false },
			},
			presets: [],
		},
		cardStyle: {
			enabled: true,
			font: "",
			backgroundImages: [],
			liveCoverImages: [],
			glassClear: false,
		},
		imageGroup: { enable: true, forward: false },
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
	} satisfies Partial<GlobalDefaults>;
	return { ...defaults, ...({} as Omit<GlobalDefaults, keyof typeof defaults>) };
}
