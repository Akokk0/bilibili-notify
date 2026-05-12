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

/**
 * Mirror of DEFAULT_FEATURE_FLAGS from packages/internal/src/schema/common.ts.
 * Used by the UP dialog as the inherit-fallback when a subscription's
 * overrides.features[k] is unset. Keep in sync with the server side.
 */
export const DEFAULT_FEATURE_FLAGS: Record<FeatureKey, boolean> = {
	dynamic: true,
	dynamicAtAll: false,
	live: true,
	liveAtAll: true,
	liveEnd: true,
	liveGuardBuy: false,
	superchat: false,
	wordcloud: true,
	liveSummary: true,
	specialDanmaku: false,
	specialUserEnter: false,
};

// ---- PushAdapter (connection level) --------------------------------------

export type PushTargetScope = "group" | "private" | "channel";

export interface OnebotAdapterConfig {
	baseUrl: string;
	accessToken?: string;
	protocolVersion?: "v11";
	headers: Record<string, string>;
	timeoutMs: number;
	retryTimes: number;
	retryIntervalMs: number;
}

export interface WebhookAdapterConfig {
	url: string;
	secret?: string;
	headers: Record<string, string>;
}

// no connection-level config (the dashboard itself is the bridge)
export type WebDashboardAdapterConfig = Record<string, never>;

export interface PushAdapterTestStatus {
	ok: boolean;
	lastCheckedAt: string;
	latencyMs?: number;
	err?: string;
}

interface PushAdapterCommon {
	id: string;
	name: string;
	enabled: boolean;
	testStatus?: PushAdapterTestStatus;
}

export type PushAdapter =
	| (PushAdapterCommon & { platform: "onebot"; config: OnebotAdapterConfig })
	| (PushAdapterCommon & { platform: "webhook"; config: WebhookAdapterConfig })
	| (PushAdapterCommon & { platform: "web-dashboard"; config: WebDashboardAdapterConfig });

// ---- PushTarget (session level — references an adapter) ------------------

export interface OnebotSession {
	groupId?: string;
	userId?: string;
}

// no session-level config (the webhook URL is the endpoint)
export type WebhookSession = Record<string, never>;

export interface WebDashboardSession {
	dashboardUser?: string;
}

interface PushTargetCommon {
	id: string;
	name: string;
	adapterId: string;
	scope: PushTargetScope;
	enabled: boolean;
}

export type PushTarget =
	| (PushTargetCommon & { platform: "onebot"; session: OnebotSession })
	| (PushTargetCommon & { platform: "webhook"; session: WebhookSession })
	| (PushTargetCommon & { platform: "web-dashboard"; session: WebDashboardSession });

export type PushTargetPlatform = "onebot" | "webhook" | "web-dashboard";

export const KNOWN_PLATFORMS: ReadonlyArray<{ value: PushTargetPlatform; label: string }> = [
	{ value: "onebot", label: "OneBot v11" },
	{ value: "webhook", label: "Webhook" },
	{ value: "web-dashboard", label: "Web Dashboard 通知" },
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

export interface AIPersonaShape {
	name: string;
	addressUser: string;
	addressSelf: string;
	traits: string;
	catchphrase: string;
	/** 基础角色描述,system prompt 起手段。 */
	baseRole: string;
	/** 追加到 system prompt 末尾的微调内容。 */
	extraSystemPrompt: string;
}

export interface AIOverride {
	preset: string;
	persona?: AIPersonaShape;
	dynamicPrompt?: string;
	liveSummaryPrompt?: string;
	temperature?: number;
}

export type GuardLevel = 1 | 2 | 3;
export interface TimeRange {
	start: number;
	end: number;
}

export interface ContentFiltersFull {
	blockForward: boolean;
	blockArticle: boolean;
	blockKeywords: string[];
	blockRegex: string[];
	whitelistKeywords: string[];
	whitelistRegex: string[];
	minScPrice: number;
	minGuardLevel: GuardLevel;
}
export type ContentFiltersOverride = Partial<ContentFiltersFull>;

export interface ScheduleFull {
	pushTime: number;
	restartPush: boolean;
	quietHours: TimeRange[];
}
export type ScheduleOverride = Partial<ScheduleFull>;

export interface GuardEntryShape {
	imageUrl: string;
	template: string;
}
export interface GuardBundleShape {
	enable: boolean;
	captain: GuardEntryShape;
	commander: GuardEntryShape;
	governor: GuardEntryShape;
}

export interface TemplateBundleFull {
	liveStart: string;
	liveOngoing: string;
	liveEnd: string;
	liveMsgEnabled: boolean;
	liveSummary: string;
	specialDanmaku: string;
	specialUserEnter: string;
	guardBuy: GuardBundleShape;
}
export type TemplateOverride = Partial<TemplateBundleFull>;

export interface CardStyleFull {
	cardColorStart: string;
	cardColorEnd: string;
}
export type CardStyleOverride = Partial<CardStyleFull>;

export interface OverridesShape {
	features?: Partial<Record<FeatureKey, boolean>>;
	filters?: ContentFiltersOverride;
	schedule?: ScheduleOverride;
	templates?: TemplateOverride;
	ai?: AIOverride;
	cardStyle?: CardStyleOverride;
}
export type SubscriptionOverrides = OverridesShape;

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

export function makeEmptyAdapter(platform: PushTargetPlatform, name: string): PushAdapter {
	const base = { id: newId(), name, enabled: true } as const;
	if (platform === "onebot") {
		return {
			...base,
			platform: "onebot",
			config: {
				baseUrl: "http://127.0.0.1:3000",
				protocolVersion: "v11",
				headers: {},
				timeoutMs: 15_000,
				retryTimes: 0,
				retryIntervalMs: 1_000,
			},
		};
	}
	if (platform === "webhook") {
		return {
			...base,
			platform: "webhook",
			config: { url: "https://example.com/hook", headers: {} },
		};
	}
	return {
		...base,
		platform: "web-dashboard",
		config: {},
	};
}

export function makeEmptyTarget(adapter: PushAdapter, name: string): PushTarget {
	const base = { id: newId(), name, adapterId: adapter.id, enabled: true } as const;
	if (adapter.platform === "onebot") {
		return { ...base, platform: "onebot", scope: "group", session: {} };
	}
	if (adapter.platform === "webhook") {
		return { ...base, platform: "webhook", scope: "channel", session: {} };
	}
	return { ...base, platform: "web-dashboard", scope: "channel", session: {} };
}

export function platformLabel(platform: string): string {
	const known = KNOWN_PLATFORMS.find((p) => p.value === platform);
	return known?.label ?? platform;
}
