/**
 * Local mirror of the JSON shapes the standalone server expects on
 * /api/subs and /api/targets. The schemas of record live in
 * `packages/internal/src/schema/{subscriptions,targets}.ts`; this file
 * stays in sync by hand because the web app is a JSON-only consumer.
 *
 * Anything new added to the canonical schemas needs to appear here too,
 * otherwise PATCH bodies will silently drop fields.
 */

// ---- Features ----------------------------------------------------------

export const FEATURE_KEYS = [
	"dynamic",
	"dynamicAtAll",
	"live",
	"liveAtAll",
	"liveEnd",
	"liveGuardBuy",
	"superchat",
	"wordcloud",
	"liveSummary",
	"specialDanmaku",
	"specialUserEnter",
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

export const FEATURE_LABELS: Record<FeatureKey, string> = {
	dynamic: "动态",
	dynamicAtAll: "动态 @全体",
	live: "开播",
	liveAtAll: "开播 @全体",
	liveEnd: "下播",
	liveGuardBuy: "上舰",
	superchat: "SC",
	wordcloud: "词云",
	liveSummary: "直播总结",
	specialDanmaku: "特别弹幕",
	specialUserEnter: "特别用户进房",
};

// ---- PushTarget --------------------------------------------------------

export type PushTargetScope = "group" | "private" | "channel";

export interface OnebotConfig {
	baseUrl: string;
	accessToken?: string;
	groupId?: string;
	userId?: string;
	protocolVersion?: "v11";
}

export interface WebhookConfig {
	url: string;
	secret?: string;
	headers: Record<string, string>;
}

export interface WebDashboardConfig {
	dashboardUser?: string;
}

export interface KoishiTargetConfig {
	botPlatform: string;
	selfId?: string;
	channelId?: string;
	guildId?: string;
	userId?: string;
}

export interface PushTargetTestStatus {
	ok: boolean;
	lastCheckedAt: string;
	latencyMs?: number;
	err?: string;
}

interface PushTargetCommon {
	id: string;
	name: string;
	scope: PushTargetScope;
	enabled: boolean;
	testStatus?: PushTargetTestStatus;
}

export type PushTarget =
	| (PushTargetCommon & { platform: "onebot"; config: OnebotConfig })
	| (PushTargetCommon & { platform: "webhook"; config: WebhookConfig })
	| (PushTargetCommon & { platform: "web-dashboard"; config: WebDashboardConfig })
	| (PushTargetCommon & { platform: `koishi-${string}`; config: KoishiTargetConfig });

export type PushTargetPlatform = "onebot" | "webhook" | "web-dashboard" | `koishi-${string}`;

export const KNOWN_PLATFORMS: ReadonlyArray<{ value: string; label: string }> = [
	{ value: "onebot", label: "OneBot v11" },
	{ value: "webhook", label: "Webhook" },
	{ value: "web-dashboard", label: "Web Dashboard 通知" },
	{ value: "koishi-onebot", label: "Koishi · OneBot" },
	{ value: "koishi-discord", label: "Koishi · Discord" },
	{ value: "koishi-telegram", label: "Koishi · Telegram" },
];

// ---- Subscription -----------------------------------------------------

export type SubscriptionRouting = Record<FeatureKey, string[]>;

export interface CachedProfile {
	name: string;
	avatar: string;
	sign: string;
	fans: number;
	lastRefreshedAt: string;
}

export interface SpecialUser {
	uid: string;
	kinds: ("enter" | "danmaku")[];
	template?: string;
}

export interface AIOverride {
	preset: string;
	persona?: unknown;
	dynamicPrompt?: string;
	liveSummaryPrompt?: string;
	temperature?: number;
}

export interface SubscriptionOverrides {
	features?: Partial<Record<FeatureKey, boolean>>;
	filters?: Record<string, unknown>;
	schedule?: Record<string, unknown>;
	templates?: Record<string, unknown>;
	ai?: AIOverride;
	cardStyle?: Record<string, unknown>;
}

export interface SubscriptionState {
	lastDynamicId?: string;
	lastPushedAt: { dynamic?: string; live?: string };
	liveStatus: "idle" | "live" | "unknown";
}

export interface Subscription {
	id: string;
	uid: string;
	enabled: boolean;
	groups: string[];
	notes?: string;
	cachedProfile?: CachedProfile;
	routing: SubscriptionRouting;
	overrides: SubscriptionOverrides;
	specialUsers: SpecialUser[];
	state: SubscriptionState;
}

// ---- Factories --------------------------------------------------------

export function newId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	// Vite dev + modern browsers always have crypto.randomUUID; this branch is
	// only a defensive fallback for ancient runtimes.
	const rand = () => Math.floor(Math.random() * 0xff_ff_ff_ff).toString(16);
	return `${rand()}-${rand()}-${rand()}-${rand()}`;
}

function emptyRouting(): SubscriptionRouting {
	const out: Partial<SubscriptionRouting> = {};
	for (const k of FEATURE_KEYS) out[k] = [];
	return out as SubscriptionRouting;
}

export function makeEmptySubscription(uid: string): Subscription {
	return {
		id: newId(),
		uid,
		enabled: true,
		groups: [],
		notes: undefined,
		cachedProfile: undefined,
		routing: emptyRouting(),
		overrides: {},
		specialUsers: [],
		state: {
			lastDynamicId: undefined,
			lastPushedAt: {},
			liveStatus: "unknown",
		},
	};
}

export function makeEmptyTarget(platform: string, name: string): PushTarget {
	const base = { id: newId(), name, enabled: true } as const;
	if (platform === "onebot") {
		return {
			...base,
			platform: "onebot",
			scope: "group",
			config: { baseUrl: "http://127.0.0.1:3000", protocolVersion: "v11" },
		};
	}
	if (platform === "webhook") {
		return {
			...base,
			platform: "webhook",
			scope: "channel",
			config: { url: "https://example.com/hook", headers: {} },
		};
	}
	if (platform === "web-dashboard") {
		return {
			...base,
			platform: "web-dashboard",
			scope: "channel",
			config: {},
		};
	}
	// koishi-* — caller chose the platform suffix already
	const koishiPlatform = (
		platform.startsWith("koishi-") ? platform : `koishi-${platform}`
	) as `koishi-${string}`;
	const botPlatform = koishiPlatform.slice("koishi-".length);
	return {
		...base,
		platform: koishiPlatform,
		scope: "group",
		config: { botPlatform },
	};
}

export function platformLabel(platform: string): string {
	const known = KNOWN_PLATFORMS.find((p) => p.value === platform);
	if (known) return known.label;
	if (platform.startsWith("koishi-")) return `Koishi · ${platform.slice("koishi-".length)}`;
	return platform;
}
