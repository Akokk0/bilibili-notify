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

export const AppConfigSchema = z.object({
	logLevel: z.enum(["error", "info", "debug"]).default("info"),
	userAgent: z.string().optional(),
	dynamicCron: z.string().default("*/2 * * * *"),
	healthCheckMinutes: z.number().int().min(5).max(180).default(30),
	historyRetentionDays: z.number().int().min(1).max(365).default(30),
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
	liveSummary: "本场直播总结：\n{summary}",
	specialDanmaku: "{mastername} 的关注用户 {uname} 发送弹幕：{msg}",
	specialUserEnter: "{uname} 进入了 {mastername} 的直播间",
	guardBuy: {
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
		name: "女仆",
		addressUser: "主人",
		addressSelf: "女仆",
		traits: "可爱、机灵、有礼貌",
		catchphrase: "",
	},
	dynamicPrompt:
		"请基于以下 UP 主动态，用简短自然的语气向主人汇报，并附上你的看法（1-2 句）：\n{content}",
	liveSummaryPrompt: "以下是一场直播的弹幕摘录，请总结直播主要内容（不超过 200 字）：\n{danmaku}",
	presets: [],
} as const;

const DEFAULT_CARD_STYLE = {
	cardColorStart: "#FB7299",
	cardColorEnd: "#23ADE5",
	cardBasePlateColor: "#FFFFFF",
	cardBasePlateBorder: "#E5E7EB",
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
