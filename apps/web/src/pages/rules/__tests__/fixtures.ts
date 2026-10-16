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
import type { GlobalConfig, GlobalDefaults } from "../../../types/globals";

/** AI 设置的 fixture(3a-38 ④:AI 在核心设置的顶层,不在 `defaults` 里)。 */
export function makeAi(): GlobalConfig["ai"] {
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
		writing: {
			post: { enabled: true, byTarget: {} },
			liveSummary: { enabled: true, byTarget: {} },
		},
		presets: [],
	};
}

export function makeDefaults(): GlobalDefaults {
	const defaults = {
		features: { ...DEFAULT_FEATURE_FLAGS },
		cards: { enabled: true, liveCoverImageIds: [] },
		cardSkin: "default",
		filters: {
			blockReposts: false,
			blockArticles: false,
			blockImages: false,
			blockVideos: false,
			blockKeywords: [],
			blockRegex: [],
			allowKeywords: [],
			allowRegex: [],
		},
		schedule: {
			quietHours: [],
			liveEndGrace: false,
			liveEndGraceMinutes: 2,
		},
		liveStart: { catchUpOnBoot: false },
		liveStreaming: { streamingIntervalHours: 1 },
		// 醒目留言与会员的门槛(㉓d):没配 = 不设门槛。
		superchat: {},
		membership: {},
		templates: {
			liveStart: "",
			liveStreaming: "",
			liveEnd: "",
			liveSummary: "",
			post: "",
			postVideo: "",
			wordcloudStopWords: "",
			viewerChat: "",
			viewerEnter: "",
			// 上舰文案(㉓d):B 站的体系 `guard` 关着自定义,体系默认空,没有任何档的覆盖。
			membership: {
				guard: { enabled: false, default: { template: "", imageUrl: "" }, tiers: {} },
			},
		},
		imageGroup: { enabled: true, mergeForward: false },
		messageLayout: {
			version: 1,
			post: {
				blocks: ["card", "text", "link"].map((id) => ({ id, type: id, visible: true })),
				separator: "\n",
			},
			live: {
				blocks: ["card", "text", "link"].map((id) => ({ id, type: id, visible: true })),
				separator: "\n",
			},
		},
	} satisfies Partial<GlobalDefaults>;
	return { ...defaults, ...({} as Omit<GlobalDefaults, keyof typeof defaults>) };
}
