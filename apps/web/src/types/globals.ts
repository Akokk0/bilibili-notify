/**
 * Local mirror of GlobalConfig from packages/internal/src/schema/globals.ts.
 * web/ is JSON-only against the business core — this file kept in sync by hand.
 */

import type { FeatureKey } from "./domain";

export type LogLevel = "error" | "warn" | "info" | "debug";

export type ModuleName = "core" | "dynamic" | "live" | "image" | "ai";

export type ModuleLogLevels = Partial<Record<ModuleName, LogLevel>>;

export interface AppConfig {
	logLevel: LogLevel;
	/**
	 * Per-module level overrides — missing key falls back to `logLevel`. On the
	 * standalone end maps to engine modules (core / dynamic / live / image / ai);
	 * on Koishi端 maps to the same-named sub-plugins. Standalone runtime hot-pushes
	 * the new level onto each module's pino instance on config-changed, so edits
	 * take effect immediately without a server restart.
	 */
	logLevels?: ModuleLogLevels;
	userAgent?: string;
	dynamicCron: string;
	healthCheckMinutes: number;
	historyRetentionDays: number;
	/** 日志归档保留天数(standalone-only;startLogRetention 按此删旧 day 文件)。 */
	logRetentionDays: number;
}

export interface MasterConfig {
	targetId?: string;
}

export type FeatureFlags = Record<FeatureKey, boolean>;

export type GuardLevel = 1 | 2 | 3;

export interface TimeRange {
	start: number;
	end: number;
}

export interface ContentFilters {
	blockForward: boolean;
	blockArticle: boolean;
	blockDraw: boolean;
	blockAv: boolean;
	blockKeywords: string[];
	blockRegex: string[];
	whitelistKeywords: string[];
	whitelistRegex: string[];
	minScPrice: number;
	minGuardLevel: GuardLevel;
}

export interface ScheduleConfig {
	pushTime: number;
	restartPush: boolean;
	quietHours: TimeRange[];
	/** 断流接续:下播先等待 N 分钟,期间重开则接续为同一场,超时未重开才判定真下播。 */
	liveEndGrace: boolean;
	/** 断流接续等待时长(分钟,1–10);仅 liveEndGrace=true 生效。 */
	liveEndGraceMinutes: number;
}

export interface GuardEntry {
	imageUrl: string;
	template: string;
}

export interface GuardBundle {
	/** false = 默认上舰图;true = 用下方三档自定义 template + imageUrl。 */
	enable: boolean;
	captain: GuardEntry;
	commander: GuardEntry;
	governor: GuardEntry;
}

export interface TemplateBundle {
	liveStart: string;
	liveOngoing: string;
	liveEnd: string;
	liveSummary: string;
	/** 非视频动态推送文案模板。变量 {name} / {url}。 */
	dynamic: string;
	/** 视频投稿推送文案模板。变量 {name} / {url}。 */
	dynamicVideo: string;
	/** 弹幕词云额外停用词,英文逗号分隔,追加到内置中文停用词表后再分词。 */
	wordcloudStopWords: string;
	specialDanmaku: string;
	specialUserEnter: string;
	guardBuy: GuardBundle;
}

export interface AIPersona {
	name: string;
	addressUser: string;
	addressSelf: string;
	traits: string;
	catchphrase: string;
	baseRole: string;
	extraSystemPrompt: string;
}

export interface AIPreset {
	id: string;
	label: string;
	persona: AIPersona;
	dynamicPrompt?: string;
	liveSummaryPrompt?: string;
}

export interface AISettings {
	enabled: boolean;
	baseUrl?: string;
	apiKey?: string;
	model: string;
	temperature: number;
	persona: AIPersona;
	dynamicPrompt: string;
	liveSummaryPrompt: string;
	presets: AIPreset[];
}

export interface CardStyle {
	enabled: boolean;
	cardColorStart: string;
	cardColorEnd: string;
	font: string;
	hideDesc: boolean;
	hideFollower: boolean;
}

/**
 * DYNAMIC_TYPE_DRAW 图集图片推送行为。`enable` 决定是否在文本/卡片之后附加一组
 * 原图;`forward` 在 `enable=true` 时决定走「合并转发卡片」还是「普通多图」(单图
 * 永远不走合并转发,engine 端守卫)。两个字段都可 per-UP 覆盖。
 */
export interface ImageGroupSettings {
	enable: boolean;
	forward: boolean;
}

export interface GlobalDefaults {
	features: FeatureFlags;
	filters: ContentFilters;
	schedule: ScheduleConfig;
	templates: TemplateBundle;
	ai: AISettings;
	cardStyle: CardStyle;
	imageGroup: ImageGroupSettings;
}

export interface GlobalConfig {
	app: AppConfig;
	master: MasterConfig;
	defaults: GlobalDefaults;
}

/** Patch payload for /api/globals — deeply partial; server merges + revalidates. */
type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;
export type GlobalConfigPatch = DeepPartial<GlobalConfig>;
