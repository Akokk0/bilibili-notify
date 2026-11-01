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

import type { SourceEntry } from "@bilibili-notify/contract";
import { DEFAULT_FEATURE_FLAGS, FEATURE_KEYS } from "../../../types/domain";

/** Public source response used by page tests that exercise every built-in capability. */
export function makeSource(over: Partial<SourceEntry> = {}): SourceEntry {
	return {
		key: "bilibili",
		status: "running",
		has: { auth: true, liveStatus: true, preview: true },
		descriptor: {
			label: "B 站",
			externalIdNoun: "UID",
			postNoun: "动态",
			creatorNoun: "UP 主",
			supportedFeatures: [...FEATURE_KEYS],
			supportedExtras: ["atAllPost", "atAllLiveStart", "wordcloud", "liveSummary"],
			membershipPrograms: [
				{
					id: "guard",
					name: "大航海",
					tiers: [
						{ key: "captain", name: "舰长", rank: 1 },
						{ key: "commander", name: "提督", rank: 2 },
						{ key: "governor", name: "总督", rank: 3 },
					],
				},
			],
		},
		...over,
	};
}

import type { GlobalConfig, GlobalDefaults } from "../../../types/globals";

/** AI 设置的 fixture(3a-38 ④:AI 在核心设置的顶层,不在 `defaults` 里)。 */
export function makeAi(): GlobalConfig["ai"] {
	return {
		enabled: false,
		// 一份实例都没添加 = 全新配置。连接与生成参数都住在实例桶里。
		activeProfile: "",
		providers: {},
		chat: {},
		search: {
			backend: "bocha",
			keys: { bocha: "", tavily: "" },
			scenes: { post: false, live: false, roast: false },
		},
		writing: {
			post: { isOnByDefault: true, byTarget: {} },
			liveSummary: { isOnByDefault: true, byTarget: {} },
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
