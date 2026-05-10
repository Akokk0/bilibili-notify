/**
 * Local mirror of GlobalConfig from packages/internal/src/schema/globals.ts.
 * web/ is JSON-only against the business core — this file kept in sync by hand.
 */

import type { FeatureKey } from "./domain";

export type LogLevel = "error" | "info" | "debug";

export type ModuleName = "core" | "dynamic" | "live" | "image" | "ai";

export type ModuleLogLevels = Partial<Record<ModuleName, LogLevel>>;

export interface AppConfig {
	logLevel: LogLevel;
	/**
	 * Per-module level overrides — missing key falls back to `logLevel`. On the
	 * standalone end maps to engine modules (core / dynamic / live / image / ai);
	 * on Koishi端 maps to the same-named sub-plugins. Pino level is fixed at
	 * server-construct time, so edits take effect on next restart.
	 */
	logLevels?: ModuleLogLevels;
	userAgent?: string;
	dynamicCron: string;
	healthCheckMinutes: number;
	historyRetentionDays: number;
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
	/** false = builtin 简短文案;true = 用上面三段 liveStart/liveOngoing/liveEnd 自定义模板。 */
	liveMsgEnabled: boolean;
	liveSummary: string;
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
	cardBasePlateColor: string;
	cardBasePlateBorder: string;
}

export interface GlobalDefaults {
	features: FeatureFlags;
	filters: ContentFilters;
	schedule: ScheduleConfig;
	templates: TemplateBundle;
	ai: AISettings;
	cardStyle: CardStyle;
}

export interface GlobalConfig {
	app: AppConfig;
	master: MasterConfig;
	defaults: GlobalDefaults;
}

/** Patch payload for /api/globals — deeply partial; server merges + revalidates. */
type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;
export type GlobalConfigPatch = DeepPartial<GlobalConfig>;
