import { z } from "zod";
import { BUILTIN_AI_PRESETS, DEFAULT_TEMPLATES } from "../constants";
import { allTemplateFingerprints } from "../template-defaults";

// 模板默认值住在零依赖的 `constants.ts` —— 前端要拿它跟盘上的值比对(「默认文案有
// 更新」那套),从这里(带 zod)拿会把 zod 拽进浏览器 bundle。同 BUILTIN_AI_PRESETS。
export { DEFAULT_TEMPLATES } from "../constants";

import { CardLayoutSchema, DEFAULT_CARD_LAYOUT } from "./card-layout";
import {
	AISettingsSchema,
	CardStyleByKindSchema,
	CardStyleSchema,
	ContentFiltersSchema,
	DEFAULT_CONTENT_FILTERS,
	DEFAULT_FEATURE_FLAGS,
	DEFAULT_IMAGE_GROUP,
	DEFAULT_SCHEDULE,
	FeatureFlagsSchema,
	ImageGroupSettingsSchema,
	ScheduleConfigSchema,
	TemplateBundleSchema,
} from "./common";
import { DEFAULT_MESSAGE_LAYOUT, MessageLayoutSchema } from "./message-layout";
import { DEFAULT_ROAST_SCHEDULE, RoastScheduleSchema } from "./roast-schedule";

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

export const LogLevelSchema = z.enum(["error", "warn", "info", "debug"]);
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

/**
 * Koishi/standalone 共享的 dynamic 轮询 cron 默认值。对齐 `AppConfigSchema.dynamicCron`。
 *
 * **六字段**(秒 分 时 日 月 周),秒位是 `30` —— 每 2 分钟的第 30 秒拉,而不是整分。
 * 整分是全网默认节拍:一堆客户端(以及本项目此前的所有实例)都卡在 `:00` 同时打
 * B 站接口,人为堆出一个流量尖峰。错开半分钟不改变频率、不多花一个请求,只是把
 * 自己从那个尖峰里挪出来,降低撞上限流(-509)的面。
 *
 * 秒字段是 `cron` 包的可选首字段(3.x 起支持,已实测),标准五字段表达式仍然合法 ——
 * 用户在 dashboard/koishi 配置里填五字段照常工作,这里只是默认值换了形态。
 */
export const DEFAULT_DYNAMIC_CRON = "30 */2 * * * *";

/**
 * 粉丝数轮询 cron 默认值(独立端 FansPoller)。粉丝曲线要不了动态那样的 2min
 * 精度,独立成一档更慢的节奏 —— 每 UP 一个请求,拉长间隔直接降低风控面。
 * 对齐 `AppConfigSchema.fansCron`;koishi 端携带但不消费(standalone-only)。
 */
export const DEFAULT_FANS_CRON = "*/10 * * * *";

/** 登录健康检查间隔(分钟)默认值。对齐 `AppConfigSchema.healthCheckMinutes`。 */
export const DEFAULT_HEALTH_CHECK_MINUTES = 30;

export const AppConfigSchema = z.object({
	logLevel: LogLevelSchema.default("info"),
	logLevels: ModuleLogLevelsSchema,
	userAgent: z.string().optional(),
	dynamicCron: z.string().default(DEFAULT_DYNAMIC_CRON),
	/** 粉丝数轮询 cron(独立端 FansPoller);从 dynamicCron 解耦,默认更慢降风控。 */
	fansCron: z.string().default(DEFAULT_FANS_CRON),
	healthCheckMinutes: z.number().int().min(5).max(180).default(DEFAULT_HEALTH_CHECK_MINUTES),
	historyRetentionDays: z.number().int().min(1).max(365).default(30),
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
	// 按卡片类型的样式覆盖(渐变/字体/玻璃片/背景图);缺该字段的老 globals.json 自动补 {}
	// (= 所有卡片跟随 cardStyle 基准,复刻现状)。生效解析见 resolveCardStyleForKind。
	cardStyleByKind: CardStyleByKindSchema.default({}),
	// `.default(DEFAULT_CARD_LAYOUT)` 让缺 cardLayout 字段的老 globals.json(在加该
	// 字段前持久化的)load 时自动补全为默认版式,与 imageGroup 同源的迁移友好策略。
	cardLayout: CardLayoutSchema.default(DEFAULT_CARD_LAYOUT),
	// 消息版式(发送侧结构):与 cardLayout 同款迁移友好策略,缺字段的老 globals.json
	// load 时自动补默认(= 复刻现状:卡片+文本+链接合并一条)。
	messageLayout: MessageLayoutSchema.default(DEFAULT_MESSAGE_LAYOUT),
	// `.default(...)` 让缺 imageGroup 字段的老 globals.json(在加 imageGroup 子段
	// 之前持久化的)load 时被 zod 自动补全 —— 否则 ConfigValidationError 让独立端
	// 启动直接挂。新字段加 GlobalDefaults 时都该带 default,保留迁移友好性。
	imageGroup: ImageGroupSettingsSchema.default(DEFAULT_IMAGE_GROUP),
	/**
	 * 「这一版默认文案我已经知道了」的账本:点路径 → 当时那版默认的指纹。
	 *
	 * 主人改了某条模板的默认,已装好的用户拿不到 —— 他们盘上写的是当初那一版。
	 * 判定「要不要提示他更新」靠的就是这本账:**指纹对不上 = 这版默认他没见过**。
	 * 于是不必再去猜「他到底改没改过」,那条路要维护一张历代默认表,而那张表
	 * 没人守得住(`liveSummary` 已经漏过一次)。判定见 `../template-defaults.ts`。
	 *
	 * `.default({})` 是老配置兜底(同 imageGroup);全新安装由
	 * `makeDefaultGlobalConfig` 一次填满 —— 理由见
	 * `./template-defaults-seen.test.ts` 里那条「改了自己的文案不该立刻被提示」。
	 */
	templateDefaultsSeen: z.record(z.string(), z.string()).default({}),
});
export type GlobalDefaults = z.infer<typeof GlobalDefaultsSchema>;

export const GlobalConfigSchema = z.object({
	app: AppConfigSchema,
	master: MasterConfigSchema,
	defaults: GlobalDefaultsSchema,
	/**
	 * 榜单周报的定时推送 —— 全局唯一一条。
	 *
	 * 放顶层而非 `defaults`:`defaults` 的语义是「per-UP overrides 缺字段时回退到
	 * 这里」,而榜单周报压根不是 per-UP 的东西,单人锐评那条(挂在 Subscription
	 * 顶层)也不该继承它 —— 两者内容根本不同。
	 *
	 * `.default(...)` 同 imageGroup / cardLayout:缺这个字段的老 globals.json 在
	 * 独立端启动时被 `parse` 自动补全,否则直接 ConfigValidationError 开不了机。
	 */
	roastSchedule: RoastScheduleSchema.default(DEFAULT_ROAST_SCHEDULE),
	/**
	 * 全局静音到哪一刻(epoch ms)。`0` = 没在静音。
	 *
	 * 放顶层的理由同 `roastSchedule`:`defaults` 的语义是「per-UP overrides 缺字段时
	 * 回退到这里」,而静音压根不是 per-UP 的东西 —— 它是「现在别推给我」这一个开关。
	 *
	 * 存**到期时刻**而不是「剩余多久」,判定就永远是 `now < mutedUntil` 一个比较:
	 * 重启、时钟跳变、进程睡过去都不影响它,不需要任何定时器或恢复逻辑。落在 globals
	 * 里则顺带拿到两件事 —— 重启不解除静音,以及网页上看得见(指令能做的事,面板上
	 * 都得有一份)。
	 */
	mutedUntil: z.number().int().min(0).default(0),
	bootstrap: BootstrapConfigSchema.optional(),
});
export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

export const DEFAULT_AI = {
	enabled: false,
	// 默认 AI 配置 = 首个预设「温柔女仆」:persona 与两个 prompt 都取自 PRESET_GENTLE_MAID。
	persona: BUILTIN_AI_PRESETS[0].persona,
	dynamicPrompt: BUILTIN_AI_PRESETS[0].dynamicPrompt,
	liveSummaryPrompt: BUILTIN_AI_PRESETS[0].liveSummaryPrompt,
	// 全新安装一家服务商都没添加 —— 设置页左栏是空的,引擎按「还没配齐」停用。
	// provider 指针先停在兜底档,主人添加第一家时会跟着切过去。
	provider: "custom",
	providers: {},
	presets: BUILTIN_AI_PRESETS,
} as const;

export const DEFAULT_CARD_STYLE = {
	enabled: true,
	cardColorStart: "#e0c3fc",
	cardColorEnd: "#8ec5fc",
	font: "PingFang SC, sans-serif",
	// 数据区三项默认全显示 = 复刻现状(简介显隐已交由版式 desc 块)。
	showPopularity: true,
	showArea: true,
	showFans: true,
	// 空列表 = 沿用渐变背景;glassOpacity 留空 = 各卡用内置基线(见 CardStyleSchema)。
	backgroundImages: [] as string[],
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
			imageGroup: DEFAULT_IMAGE_GROUP,
			// 全新安装把账本一次填满:他拿到的就是当前默认,没什么可更新的。
			// 空着的话,他一动手改文案就会被提示「默认文案有更新」—— 更新到哪去?
			templateDefaultsSeen: allTemplateFingerprints(DEFAULT_TEMPLATES),
		},
	});
}
