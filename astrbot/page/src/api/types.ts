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

// 值级单一来源:internal 的零依赖子路径(不含 zod,bundle 零增量)。
export { FEATURE_KEYS } from "@bilibili-notify/internal/constants";
export type {
	AstrBotPushTarget,
	DeliveryResult,
	FeatureKey,
	GlobalConfig,
	LoginSnapshot,
	Subscription,
	SubscriptionOverrides,
	SubscriptionRouting,
};

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

// Sidecar 快照的单一来源在 sidecar 包自身(经 types-only 的 /state 子路径,
// 只供 `import type`;运行时 import 会解析失败,这正是设计意图)。此前这里是
// 手抄镜像,连 login 的精确类型都只有镜像有 —— 现已把 LoginSnapshot 收紧进
// sidecar 本体,镜像随之退役。
import type { SidecarSnapshot } from "@bilibili-notify/astrbot-sidecar/state";

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

/** AstrBot 人格选项,用于 per-UP 人格下拉(来自 GET personas 端点)。 */
export interface PersonaOption {
	readonly id: string;
	readonly label: string;
}

interface ApiIssue {
	readonly path?: Array<string | number>;
	readonly message?: string;
}

export interface ApiErrorBody {
	readonly error?: string;
	readonly message?: string;
	readonly issues?: ApiIssue[];
	readonly [key: string]: unknown;
}
