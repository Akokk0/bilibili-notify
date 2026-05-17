import { z } from "zod";
import {
	AISettingsSchema,
	CardStyleSchema,
	ContentFiltersSchema,
	DEFAULT_CONTENT_FILTERS,
	DEFAULT_FEATURE_FLAGS,
	DEFAULT_SCHEDULE,
	FeatureFlagsSchema,
	ScheduleConfigSchema,
	TemplateBundleSchema,
} from "./common";

/** 启动时注入、运行时只读的引导配置。Koishi 端为 undefined（Koishi 接管 lifecycle）。 */
export const BootstrapConfigSchema = z.object({
	server: z.object({
		host: z.string().default("0.0.0.0"),
		port: z.number().int().min(1).max(65535).default(8787),
	}),
	dataDir: z.string(),
	cookieEncryptionKey: z.string().min(16, "cookieEncryptionKey must be at least 16 chars"),
	dashboardAuth: z
		.object({
			username: z.string(),
			password: z.string(),
		})
		.optional(),
});
export type BootstrapConfig = z.infer<typeof BootstrapConfigSchema>;

export const LogLevelSchema = z.enum(["error", "info", "debug"]);
export type LogLevel = z.infer<typeof LogLevelSchema>;

/**
 * Per-module log-level overrides. Each key is a Subscription-engine module
 * name; a missing key falls back to `app.logLevel`. Independent of plugin
 * concept — Koishi端解释为 plugin 级,standalone 端为 engine module 级,
 * 接口 / 字段名共用。
 */
export const ModuleLogLevelsSchema = z
	.object({
		core: LogLevelSchema.optional(),
		dynamic: LogLevelSchema.optional(),
		live: LogLevelSchema.optional(),
		image: LogLevelSchema.optional(),
		ai: LogLevelSchema.optional(),
	})
	.optional();
export type ModuleLogLevels = z.infer<typeof ModuleLogLevelsSchema>;

export const AppConfigSchema = z.object({
	logLevel: LogLevelSchema.default("info"),
	logLevels: ModuleLogLevelsSchema,
	userAgent: z.string().optional(),
	dynamicCron: z.string().default("*/2 * * * *"),
	healthCheckMinutes: z.number().int().min(5).max(180).default(30),
	historyRetentionDays: z.number().int().min(1).max(365).default(30),
	/**
	 * 日志归档入档下限。standalone 端把 logger.<level> 调用旁路落盘
	 * `<dataDir>/logs/<YYYY-MM-DD>.jsonl`;级别严重度低于此下限的不写盘
	 * (仍走 WS `log` 频道实时 tail)。复用 `LogLevelSchema`(error|info|debug);
	 * `warn` 级条目在 floor=info 时按 rank 仍入档。Koishi 端不消费(无 LogStore)。
	 */
	logArchiveFloor: LogLevelSchema.default("info"),
	/**
	 * 日志归档保留天数。`startLogRetention` 每轮按此删除更旧的 day 文件。
	 * 与 `historyRetentionDays` 同模式但默认更短(日志量远高于推送历史、
	 * 长期价值低)。Koishi 端携带但不消费(standalone-only,同 historyRetentionDays)。
	 */
	logRetentionDays: z.number().int().min(1).max(365).default(7),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;

export const MasterConfigSchema = z.object({
	/** 用于错误私聊的 PushTarget.id；undefined 时不发私聊。 */
	targetId: z.uuid().optional(),
});
export type MasterConfig = z.infer<typeof MasterConfigSchema>;

/** 全局默认值；resolve(sub, globals) 在 per-UP overrides 缺字段时回退到这里。 */
export const GlobalDefaultsSchema = z.object({
	features: FeatureFlagsSchema,
	filters: ContentFiltersSchema,
	schedule: ScheduleConfigSchema,
	templates: TemplateBundleSchema,
	ai: AISettingsSchema,
	cardStyle: CardStyleSchema,
});
export type GlobalDefaults = z.infer<typeof GlobalDefaultsSchema>;

export const GlobalConfigSchema = z.object({
	app: AppConfigSchema,
	master: MasterConfigSchema,
	defaults: GlobalDefaultsSchema,
	bootstrap: BootstrapConfigSchema.optional(),
});
export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

/** 模板默认值（占位，可由 UI 编辑）。 */
const DEFAULT_TEMPLATES = {
	liveStart: "{name} 开播了！\n直播间标题：{title}\n直播间链接：{link}",
	liveOngoing: "{name} 仍在直播中（已直播 {duration}）\n标题：{title}\n看过：{watched}",
	liveEnd: "{name} 下播了，直播时长 {duration}",
	// false = builtin 简短文案；true = 启用上面三段自定义模板
	liveMsgEnabled: false,
	liveSummary: `🔍【弹幕情报站】本场直播数据如下：
🧍‍♂️ 总共 -dmc 位-mdn上线
💬 共计 -dca 条弹幕飞驰而过
📊 热词云图已生成，快来看看你有没有上榜！
👑 本场顶级输出选手：
🥇 -un1 - 弹幕输出 -dc1 条
🥈 -un2 - 弹幕 -dc2 条，萌力惊人
🥉 -un3 - -dc3 条精准狙击
🎖️ 特别嘉奖：-un4 & -un5
你们的弹幕，我们都记录在案！🕵️‍♀️`,
	specialDanmaku: "{mastername} 的关注用户 {uname} 发送弹幕：{msg}",
	specialUserEnter: "{uname} 进入了 {mastername} 的直播间",
	guardBuy: {
		// false = 默认上舰图 + 内置文案；true = 启用三档自定义文案/图片
		enable: false,
		captain: { imageUrl: "", template: "{user} 成为了 {mastername} 的舰长！" },
		commander: {
			imageUrl: "",
			template: "{user} 成为了 {mastername} 的提督！",
		},
		governor: {
			imageUrl: "",
			template: "{user} 成为了 {mastername} 的总督！",
		},
	},
} as const;

const DEFAULT_AI = {
	enabled: false,
	model: "gpt-4o-mini",
	temperature: 0.7,
	persona: {
		name: "小绫",
		addressUser: "主人",
		addressSelf: "小绫",
		traits: "温柔、体贴、说话轻声细语",
		catchphrase: "",
		baseRole: "你是主人贴身的小女仆,负责帮主人留意他订阅的 Bilibili UP 主的最新动态与直播。",
		extraSystemPrompt: "",
	},
	dynamicPrompt:
		"你将收到一条 B 站 UP 主动态(以 user 消息形式给出),请用简短自然的语气向主人汇报核心内容,并附上 1-2 句你的看法。",
	liveSummaryPrompt:
		"你将收到一场 B 站直播的弹幕摘录(以 user 消息形式给出),请客观总结直播主要内容,控制在 200 字内。",
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
				baseRole: "你是主人贴身的小女仆,语气温柔、耐心、关心主人,把每一次汇报都当成对主人的服务。",
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
				baseRole: "你是一个嘴硬心软的傲娇 AI,虽然嘴上不饶人,但实际上还是认真在帮主人盯 UP 主动态。",
				extraSystemPrompt: "可以毒舌但避免人身攻击,关键信息一定要说清楚。不要把每句话都加'哼'。",
			},
			dynamicPrompt:
				"主人让你看的 UP 主又更新动态了,用傲娇的语气吐槽一下,但内容核心要讲清楚,不要光吐槽不汇报。",
			liveSummaryPrompt:
				"主人非要让你帮他看一整场直播,用傲娇的语气把这场直播总结一下,允许适当吐槽,但关键点要交代到。",
		},
		{
			id: "analyst",
			label: "理性分析",
			persona: {
				name: "分析师",
				addressUser: "用户",
				addressSelf: "我",
				traits: "客观、专业、信息密度高",
				catchphrase: "",
				baseRole: "你是一名专业的内容分析师,用中立、客观、信息密度高的语气总结 UP 主动态与直播。",
				extraSystemPrompt:
					"避免感情色彩与颜文字。结构化输出:亮点 / 关键信息 / 简评 三段式,简评不超过两句。",
			},
			dynamicPrompt:
				"按「亮点 / 关键信息 / 简评」三段式输出,语言客观简洁,简评不超过两句,避免主观情感词。",
			liveSummaryPrompt:
				"客观总结直播:涉及话题、互动热点、整体氛围。控制在 200 字内,避免颜文字与感叹号堆叠。",
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
			dynamicPrompt: "用元气满满的语气把 UP 主新动态讲给用户听,内容核心要说出来,语气活泼但别过头。",
			liveSummaryPrompt:
				"用元气满满的语气帮用户回顾这场直播的重点(200 字内),保持热情但抓住关键点。",
		},
	],
} as const;

const DEFAULT_CARD_STYLE = {
	enabled: true,
	cardColorStart: "#e0c3fc",
	cardColorEnd: "#8ec5fc",
} as const;

/** 工厂：创建一份完整的默认 GlobalConfig（不含 bootstrap，供 Koishi 端用）。 */
export function makeDefaultGlobalConfig(): GlobalConfig {
	return GlobalConfigSchema.parse({
		app: {},
		master: {},
		defaults: {
			features: DEFAULT_FEATURE_FLAGS,
			filters: DEFAULT_CONTENT_FILTERS,
			schedule: DEFAULT_SCHEDULE,
			templates: DEFAULT_TEMPLATES,
			ai: DEFAULT_AI,
			cardStyle: DEFAULT_CARD_STYLE,
		},
	});
}
