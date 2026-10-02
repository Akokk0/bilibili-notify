/**
 * 迁移测试的 0.x 夹具 —— 冻住的字面量,**不取 internal 的活工厂**。
 *
 * 迁移器的输入是 0.x 盘上的形状。这些夹具从前由 internal 的活工厂现造(`makeDefaultGlobalConfig` /
 * `makeEmptySubscription` / `FEATURE_KEYS`),活词表一改名,「0.x 的输入」就悄悄变成 1.0 的键,测试照绿、
 * 迁移器却再没被 0.x 的形状考过。所以这里把 0.12 的形状抄成字面量(值以 tag `v0.12.0` 的出厂配置与空订阅为准核过)。
 * 迁移测试要造 0.x 输入就从这里取,别回头去 import 活工厂。**期望值**要钉的若是「迁完、经配置仓 / 活 schema 装载出来的东西」,
 * 那是 1.0 侧的期望,照旧用活 schema。
 *
 * ⚠️ 冻住的是 0.x 的历史事实,不随 1.0 改名。
 */

/** 0.12 的特性键(全局 features 与 routing 共用)。 */
type ZeroFeatureKey =
	| "dynamic"
	| "live"
	| "liveEnd"
	| "liveGuardBuy"
	| "superchat"
	| "specialDanmaku"
	| "specialUserEnter";

/** 0.12 的附加项键。 */
type ZeroExtraKeyName = "atAllDynamic" | "atAllLive" | "wordcloud" | "liveSummary";

/** 0.12 的全局 `defaults.features`:七把特性开关 + 四把附加项。 */
export type ZeroFeatureFlags = Record<ZeroFeatureKey, boolean> & {
	extras: Record<ZeroExtraKeyName, boolean>;
};

/** 0.12 的 `defaults.templates`。 */
export interface ZeroTemplates {
	liveStart: string;
	liveOngoing: string;
	liveEnd: string;
	liveSummary: string;
	dynamic: string;
	dynamicVideo: string;
	wordcloudStopWords: string;
	specialDanmaku: string;
	specialUserEnter: string;
	guardBuy: {
		enable: boolean;
		captain: { imageUrl: string; template: string };
		commander: { imageUrl: string; template: string };
		governor: { imageUrl: string; template: string };
	};
}

/** 0.12 的整份 globals(`state/globals.json`)。只把迁移测试要伸手进去改的那几格写成类型,其余按字面量放着。 */
export interface ZeroGlobals {
	app: Record<string, unknown>;
	defaults: {
		features: ZeroFeatureFlags;
		/** 0.12 的 `schedule`:`pushTime`(0 = 关,1–24 小时)与 `restartPush` 在 1.0 拆进了 `liveStreaming` / `liveStart`。 */
		schedule: {
			pushTime: number;
			restartPush: boolean;
			quietHours: unknown[];
			liveEndGrace: boolean;
			liveEndGraceMinutes: number;
		};
		templates: ZeroTemplates;
		ai: Record<string, unknown>;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

/**
 * 0.12 出厂的整份 globals —— 全新装 0.12 写下的那一份(`makeDefaultGlobalConfig()` 在 `v0.12.0` 的输出)。
 * `app` 里带着 B 站那三格里的两格(`dynamicCron` / `healthCheckMinutes`;1.0 把它们搬进了 settings/bilibili.json)。
 */
const ZERO_DEFAULT_GLOBALS: ZeroGlobals = {
	app: {
		logLevel: "info",
		dynamicCron: "30 */2 * * * *",
		fansCron: "*/10 * * * *",
		healthCheckMinutes: 30,
		historyRetentionDays: 30,
		logRetentionDays: 7,
		memoryLog: false,
	},
	master: {},
	defaults: {
		features: {
			dynamic: true,
			live: true,
			liveEnd: true,
			liveGuardBuy: false,
			superchat: false,
			specialDanmaku: false,
			specialUserEnter: false,
			extras: {
				atAllDynamic: false,
				atAllLive: true,
				wordcloud: true,
				liveSummary: true,
			},
		},
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
			liveStart: "{name} 开播啦，当前粉丝数：{follower}",
			liveOngoing: "{name} 正在直播，已播 {time}，累计观看：{watched}",
			liveEnd: "{name} 下播啦，本次直播了 {time}，粉丝变化 {follower_change}",
			liveSummary:
				"🔍【弹幕情报站】本场直播数据如下：\n🧍‍♂️ 总共 {dmc} 位{mdn}上线\n💬 共计 {dca} 条弹幕飞驰而过\n📊 热词云图已生成，快来看看你有没有上榜！\n👑 本场顶级输出选手：\n🥇 {un1} - 弹幕输出 {dc1} 条\n🥈 {un2} - 弹幕 {dc2} 条，萌力惊人\n🥉 {un3} - {dc3} 条精准狙击\n🎖️ 特别嘉奖：{un4} & {un5}\n你们的弹幕，我们都记录在案！🕵️‍♀️",
			dynamic: "{name}发布了一条动态",
			dynamicVideo: "{name}发布了新视频",
			wordcloudStopWords: "",
			specialDanmaku: "{mastername} 的关注用户 {uname} 发送弹幕：{msg}",
			specialUserEnter: "{uname} 进入了 {mastername} 的直播间",
			guardBuy: {
				enable: false,
				captain: {
					imageUrl: "",
					template: "{uname} 成为了 {mname} 的舰长！",
				},
				commander: {
					imageUrl: "",
					template: "{uname} 成为了 {mname} 的提督！",
				},
				governor: {
					imageUrl: "",
					template: "{uname} 成为了 {mname} 的总督！",
				},
			},
		},
		ai: {
			enabled: false,
			persona: {
				name: "小绫",
				addressUser: "主人",
				addressSelf: "小绫",
				traits: "温柔、体贴、说话轻声细语",
				catchphrase: "请主人慢用~",
				baseRole: "你是主人贴身的小女仆,语气温柔、耐心、关心主人,把每一次汇报都当成对主人的服务。",
				extraSystemPrompt: "回复保持礼貌,可以用 (*´ω`*) 之类的颜文字点缀,不要过分卖萌。",
			},
			dynamicPrompt:
				"主人订阅的 UP 主刚刚更新了动态,请用温柔的语气向主人转述核心内容,并补一两句你的看法。",
			liveSummaryPrompt:
				"用温柔的语气向主人讲讲直播主要发生了什么(150-200 字),从弹幕和氛围中提炼亮点。",
			activeProfile: "",
			providers: {},
			chat: {},
			search: {
				backend: "bocha",
				keys: {
					bocha: "",
					tavily: "",
				},
				engines: {
					dynamic: false,
					live: false,
					roast: false,
				},
			},
			activePreset: "gentle-maid",
			presets: [
				{
					id: "gentle-maid",
					label: "温柔女仆",
					persona: {
						name: "小绫",
						addressUser: "主人",
						addressSelf: "小绫",
						traits: "温柔、体贴、说话轻声细语",
						catchphrase: "请主人慢用~",
						baseRole:
							"你是主人贴身的小女仆,语气温柔、耐心、关心主人,把每一次汇报都当成对主人的服务。",
						extraSystemPrompt: "回复保持礼貌,可以用 (*´ω`*) 之类的颜文字点缀,不要过分卖萌。",
					},
					dynamicPrompt:
						"主人订阅的 UP 主刚刚更新了动态,请用温柔的语气向主人转述核心内容,并补一两句你的看法。",
					liveSummaryPrompt:
						"用温柔的语气向主人讲讲直播主要发生了什么(150-200 字),从弹幕和氛围中提炼亮点。",
				},
				{
					id: "tsundere",
					label: "傲娇毒舌",
					persona: {
						name: "凛子",
						addressUser: "笨蛋",
						addressSelf: "本小姐",
						traits: "嘴硬心软、毒舌、爱用反问",
						catchphrase: "哼,才不是为了你才看的呢!",
						baseRole:
							"你是一个嘴硬心软的傲娇 AI,虽然嘴上不饶人,但实际上还是认真在帮主人盯 UP 主动态。",
						extraSystemPrompt:
							"可以毒舌但避免人身攻击,关键信息一定要说清楚。不要把每句话都加'哼'。",
					},
					dynamicPrompt:
						"主人让你看的 UP 主又更新动态了,用傲娇的语气吐槽一下,但内容核心要讲清楚,不要光吐槽不汇报。",
					liveSummaryPrompt:
						"主人非要让你帮他看一整场直播,用傲娇的语气把这场直播总结一下,允许适当吐槽,但关键点要交代到。",
				},
				{
					id: "analyst",
					label: "理性女仆",
					persona: {
						name: "理子",
						addressUser: "主人",
						addressSelf: "理子",
						traits: "冷静、条理清晰、言简意赅",
						catchphrase: "以上,请主人过目。",
						baseRole:
							"你是主人身边最干练的那位女仆,负责把 UP 主的动态与直播整理成一份清楚的简报。你依然恭敬有礼,但不寒暄、不铺垫,信息优先。",
						extraSystemPrompt:
							"保持敬语,但不用颜文字、不堆感叹号、不做情绪渲染。结构化输出:亮点 / 关键信息 / 简评 三段式,简评不超过两句。事实与你的判断要分得开。",
					},
					dynamicPrompt:
						"主人订阅的 UP 主更新了动态。按「亮点 / 关键信息 / 简评」三段式向主人汇报,语言简洁克制,简评不超过两句,不做情绪渲染。",
					liveSummaryPrompt:
						"向主人汇报这场直播:涉及话题、互动热点、整体氛围。控制在 200 字内,保持敬语但不用颜文字与感叹号。",
				},
				{
					id: "genki",
					label: "元气少女",
					persona: {
						name: "小阳",
						addressUser: "你",
						addressSelf: "我",
						traits: "活泼、热情、爱用感叹号",
						catchphrase: "诶嘿~",
						baseRole: "你是一个超级元气的助手,充满活力、热情地分享 UP 主的最新动态和直播!",
						extraSystemPrompt:
							"语气活泼但不要刷感叹号刷到刺眼,一两个就够。可以用「!!」、「~」、「诶嘿」之类。",
					},
					dynamicPrompt:
						"用元气满满的语气把 UP 主新动态讲给用户听,内容核心要说出来,语气活泼但别过头。",
					liveSummaryPrompt:
						"用元气满满的语气帮用户回顾这场直播的重点(200 字内),保持热情但抓住关键点。",
				},
			],
		},
		cardStyle: {
			enabled: true,
			liveCoverImages: [],
		},
		cardStyleByKind: {},
		cardSkin: "default",
		cardSkinKnobs: {},
		messageLayout: {
			version: 1,
			dynamic: {
				blocks: [
					{
						id: "card",
						type: "card",
						visible: true,
					},
					{
						id: "text",
						type: "text",
						visible: true,
					},
					{
						id: "link",
						type: "link",
						visible: true,
					},
				],
				separator: "\n",
			},
			live: {
				blocks: [
					{
						id: "card",
						type: "card",
						visible: true,
					},
					{
						id: "text",
						type: "text",
						visible: true,
					},
					{
						id: "link",
						type: "link",
						visible: true,
					},
				],
				separator: "\n",
			},
		},
		imageGroup: {
			enable: true,
			forward: false,
		},
		templateDefaultsSeen: {
			liveStart: "1nkgnb7",
			liveOngoing: "oopixp",
			liveEnd: "1mtqdty",
			liveSummary: "1hxy5zb",
			dynamic: "7uw5nq",
			dynamicVideo: "1omlggn",
			wordcloudStopWords: "ztntfp",
			specialDanmaku: "t4zkxd",
			specialUserEnter: "1qh1423",
			"guardBuy.captain.imageUrl": "ztntfp",
			"guardBuy.captain.template": "1n2b5zl",
			"guardBuy.commander.imageUrl": "ztntfp",
			"guardBuy.commander.template": "c2qled",
			"guardBuy.governor.imageUrl": "ztntfp",
			"guardBuy.governor.template": "1qek1pk",
		},
	},
	roastSchedule: {
		enabled: false,
		cron: "0 9 * * 1",
		days: 7,
		targets: [],
		approval: false,
		notifyOnError: true,
	},
	mutedUntil: 0,
	commands: {
		enabled: true,
		prefix: "/",
		aliases: {},
	},
	linkParsing: {
		enabled: false,
		cooldownSeconds: 60,
		defaults: {
			parse: true,
			form: "image",
		},
		groups: {},
	},
	onboarding: {},
	update: {
		channel: "stable",
		autoDownload: true,
		mirrors: [],
	},
	extensions: {},
	marketplace: {
		sources: [],
	},
};

/** 一份新的 0.12 出厂 globals(深拷贝:用例会就地改它)。 */
export function makeZeroGlobals(): ZeroGlobals {
	return structuredClone(ZERO_DEFAULT_GLOBALS);
}

/**
 * 去掉 `app` 里 B 站那三格(`userAgent` / `dynamicCron` / `healthCheckMinutes`)的 globals:这三格 1.0 搬进了 settings/bilibili.json,
 * 去掉之后 0.x 的设置里就没有它们要搬 —— 要一份「设置迁移器无事可做」的 globals(用例断言新代里还是搬过来的那个文件)就用这个。
 */
export function withoutZeroBilibiliApp(globals: ZeroGlobals): ZeroGlobals {
	const { userAgent: _u, dynamicCron: _c, healthCheckMinutes: _h, ...app } = globals.app;
	return { ...globals, app };
}

// ── 订阅 ─────────────────────────────────────────────────────────────────────────

/** 0.12 的空 routing:七把特性键各一份空目标表。 */
export function zeroEmptyRouting(): Record<ZeroFeatureKey, string[]> {
	return {
		dynamic: [],
		live: [],
		liveEnd: [],
		liveGuardBuy: [],
		superchat: [],
		specialDanmaku: [],
		specialUserEnter: [],
	};
}

/** 0.12 的空附加项目标表:四把键各一份空表。 */
export function zeroEmptyExtras(): Record<ZeroExtraKeyName, Record<string, boolean>> {
	return { atAllDynamic: {}, atAllLive: {}, wordcloud: {}, liveSummary: {} };
}

function zeroEmptyRoastSchedule() {
	return {
		enabled: false,
		cron: "0 9 * * 1",
		days: 7,
		targets: [] as string[],
		approval: false,
		notifyOnError: true,
	};
}

/**
 * 一条空订阅,身份已经收进 `identity`(`makeEmptySubscription` 的形状),**键用 0.12 的**:routing / extras / overrides /
 * roastSchedule / specialUsers 这几格与 `v0.12.0` 的空订阅一致,只有身份与分组的位置是后来的。
 * 行级迁移函数的用例拿它当基线(这一步不碰身份格,见 `features.test.ts` 头注)。
 */
export function zeroEmptySubscription(opts: {
	id: string;
	identity: { sourceKey: string; externalId: string };
}) {
	return {
		id: opts.id,
		identity: { ...opts.identity },
		enabled: true,
		tagIds: [] as string[],
		routing: zeroEmptyRouting(),
		extras: zeroEmptyExtras(),
		overrides: {} as Record<string, unknown>,
		roastSchedule: zeroEmptyRoastSchedule(),
		specialUsers: [] as unknown[],
	};
}

/**
 * 0.x 盘上的 B 站订阅(`state/subscriptions.json` 里的一行):身份在**顶层 `uid`**,没有 `kind`、没有 `identity`;
 * 0.x 的分组是一串名字 `groups`,不是 1.0 的 `tagIds`(ADR-0034)。往第 0 代摆夹具用它 —— 那是迁移器的**输入**,
 * 得是 0.x 的样子。`over` 盖在整行上(整格替换)。
 */
export function zeroBiliRow(
	opts: { id: string; uid: string; groups?: string[] },
	over: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id: opts.id,
		uid: opts.uid,
		groups: opts.groups ?? [],
		enabled: true,
		routing: zeroEmptyRouting(),
		extras: zeroEmptyExtras(),
		overrides: {},
		roastSchedule: zeroEmptyRoastSchedule(),
		specialUsers: [],
		...over,
	};
}

/**
 * 0.x 盘上的拓展订阅(`state/extension-subscriptions.json` 里的一行):`kind: "extension"`,身份是顶层的
 * `extensionId` + `externalId`,没有 `identity`。同样是迁移器的输入。
 */
export function zeroExtensionRow(
	opts: { id: string; extensionId: string; externalId: string; groups?: string[] },
	over: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		kind: "extension",
		id: opts.id,
		extensionId: opts.extensionId,
		externalId: opts.externalId,
		groups: opts.groups ?? [],
		enabled: true,
		routing: zeroEmptyRouting(),
		extras: zeroEmptyExtras(),
		overrides: {},
		roastSchedule: zeroEmptyRoastSchedule(),
		specialUsers: [],
		...over,
	};
}
