import type {
	AstrBotPushTarget,
	DeliveryResult,
	FeatureKey,
	GlobalConfig,
	LoginSnapshot,
	PushAdapter,
	Subscription,
	SubscriptionOverrides,
	SubscriptionRouting,
} from "@bilibili-notify/internal";

export type {
	AstrBotPushTarget,
	DeliveryResult,
	FeatureKey,
	GlobalConfig,
	LoginSnapshot,
	PushAdapter,
	Subscription,
	SubscriptionOverrides,
	SubscriptionRouting,
};

export const FEATURE_KEYS: FeatureKey[] = [
	"dynamic",
	"live",
	"liveEnd",
	"liveGuardBuy",
	"superchat",
	"wordcloud",
	"liveSummary",
	"specialDanmaku",
	"specialUserEnter",
];

export const FEATURE_LABELS: Record<FeatureKey, string> = {
	dynamic: "动态",
	live: "开播",
	liveEnd: "下播",
	liveGuardBuy: "上舰",
	superchat: "醒目留言",
	wordcloud: "词云",
	liveSummary: "弹幕总结",
	specialDanmaku: "特别弹幕",
	specialUserEnter: "特别进房",
};

export interface SidecarBusinessSnapshot {
	readonly started: boolean;
	readonly authStarted: boolean;
	readonly engines: { readonly dynamic: boolean; readonly live: boolean };
	readonly subscriptions: { readonly count: number; readonly path: string };
	readonly events: { readonly nextId: number; readonly size: number };
	readonly deliveries?: {
		readonly size: number;
		readonly pending: number;
		readonly inFlight: number;
		readonly maxSize: number;
		readonly maxAttempts: number;
	};
	readonly ai?: {
		readonly size: number;
		readonly pending: number;
		readonly inFlight: number;
		readonly maxSize: number;
	};
	readonly login?: LoginSnapshot;
}

export interface SidecarCapabilities {
	readonly tokenAuth: boolean;
	readonly pluginPageProxy: boolean;
	readonly sse: boolean;
	readonly deliveryQueue: boolean;
	readonly aiProviderBridge: boolean;
}

export interface SidecarSnapshot {
	readonly status: "starting" | "ready" | "stopping" | "stopped";
	readonly version: string;
	readonly pid: number;
	readonly host: string;
	readonly port: number;
	readonly dataDir?: string;
	readonly startedAt: string;
	readonly readyAt?: string;
	readonly aiBackend: "astrbot" | "own" | "disabled";
	readonly aiProviderId?: string;
	readonly capabilities?: SidecarCapabilities;
	readonly business?: SidecarBusinessSnapshot;
	readonly url: string;
	readonly uptimeMs: number;
}

export interface DashboardBootstrap {
	readonly snapshot: SidecarSnapshot;
	readonly globals: GlobalConfig;
	readonly subscriptions: Subscription[];
	readonly adapters: PushAdapter[];
	readonly targets: AstrBotPushTarget[];
}

export interface UserLookupResult {
	readonly uid: string;
	readonly name: string;
	readonly avatar: string;
	readonly sign: string;
	readonly fans: number;
}

export interface UserSearchResult {
	readonly results: UserLookupResult[];
	readonly page: number;
	readonly pageSize: number;
	readonly total: number;
}

export interface PairingCodeResult {
	readonly code: string;
	readonly expiresAt: string;
}

export interface ApiIssue {
	readonly path?: Array<string | number>;
	readonly message?: string;
}

export interface ApiErrorBody {
	readonly error?: string;
	readonly message?: string;
	readonly issues?: ApiIssue[];
	readonly [key: string]: unknown;
}
