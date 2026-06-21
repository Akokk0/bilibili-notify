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
	"live",
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
	live: "开播",
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
	live: true,
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

/** OneBot 三种连接方式(transport)共用的连接字段。 */
interface OnebotAdapterConfigCommon {
	accessToken?: string;
	protocolVersion?: "v11";
	timeoutMs: number;
	retryTimes: number;
	retryIntervalMs: number;
}

/**
 * OneBot 适配器连接配置 —— 按 `transport` 区分 HTTP / 正向 WS / 反向 WS。
 * 镜像 `@bilibili-notify/internal` 的 `OnebotAdapterConfigSchema`(union)。
 */
export type OnebotAdapterConfig =
	| (OnebotAdapterConfigCommon & {
			transport: "http";
			baseUrl: string;
			headers: Record<string, string>;
	  })
	| (OnebotAdapterConfigCommon & {
			transport: "ws";
			url: string;
			headers: Record<string, string>;
	  })
	| (OnebotAdapterConfigCommon & { transport: "ws-reverse"; port: number });

export type OnebotTransport = OnebotAdapterConfig["transport"];

export type WebhookProvider = "generic" | "dingtalk" | "feishu" | "wecom";

export interface WebhookAdapterConfig {
	url: string;
	provider?: WebhookProvider;
	secret?: string;
	headers: Record<string, string>;
}

export const WEBHOOK_PROVIDERS: ReadonlyArray<{ value: WebhookProvider; label: string }> = [
	{ value: "generic", label: "Generic JSON" },
	{ value: "dingtalk", label: "钉钉机器人" },
	{ value: "feishu", label: "飞书机器人" },
	{ value: "wecom", label: "企业微信机器人" },
];

export function webhookProviderLabel(provider: WebhookProvider | undefined): string {
	return (
		WEBHOOK_PROVIDERS.find((p) => p.value === (provider ?? "generic"))?.label ?? "Generic JSON"
	);
}

export function webhookUrlPlaceholder(provider: WebhookProvider | undefined): string {
	switch (provider ?? "generic") {
		case "dingtalk":
			return "https://oapi.dingtalk.com/robot/send?access_token=...";
		case "feishu":
			return "https://open.feishu.cn/open-apis/bot/v2/hook/...";
		case "wecom":
			return "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...";
		case "generic":
			return "https://hooks.example.com/bn";
	}
}

export function webhookSecretHint(provider: WebhookProvider | undefined): string {
	switch (provider ?? "generic") {
		case "dingtalk":
			return "钉钉加签密钥 SEC...；填写后自动追加 timestamp/sign";
		case "feishu":
			return "飞书签名密钥；填写后自动在消息体加入 timestamp/sign";
		case "wecom":
			return "企业微信群机器人通常不需要 Secret；鉴权 key 在 webhook URL 中";
		case "generic":
			return "Generic 模式下加在 x-bilibili-notify-secret 头";
	}
}

export function maskWebhookUrl(url: string): string {
	try {
		const parsed = new URL(url);
		const safePath = parsed.pathname === "/" ? "" : "/***";
		const queryHint = parsed.search ? "?…" : "";
		return `${parsed.origin}${safePath}${queryHint}`;
	} catch {
		return "已配置 webhook URL";
	}
}

/** QQ 官方机器人(q.qq.com)机器人域:公域 / 私域。决定能否发原生 markdown。 */
export type QQOfficialBotType = "public" | "private";

/**
 * QQ 官方机器人适配器连接配置 —— 镜像 `@bilibili-notify/internal` 的
 * `QQOfficialAdapterConfigSchema`。appId/appSecret 明文存(对齐 OneBot accessToken);
 * sandbox 切沙箱 host;botType 私域可发原生 markdown(图集合并),公域需报备模板。
 */
export interface QQOfficialAdapterConfig {
	appId: string;
	appSecret: string;
	sandbox: boolean;
	botType: QQOfficialBotType;
}

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
	| (PushAdapterCommon & { platform: "qq-official"; config: QQOfficialAdapterConfig })
	| (PushAdapterCommon & { platform: "webhook"; config: WebhookAdapterConfig });

// ---- PushTarget (session level — references an adapter) ------------------

export interface OnebotSession {
	groupId?: string;
	userId?: string;
}

/**
 * QQ 官方机器人会话寻址 —— 镜像 `QQOfficialSessionSchema`。按 target.scope 取字段:
 * channel→guildId+channelId、group→groupOpenid、private(C2C)→userOpenid。
 * 群/C2C 的 openid 只能从入站事件捞(经 /api/qq/sessions 选择器)。
 */
export interface QQOfficialSession {
	guildId?: string;
	channelId?: string;
	groupOpenid?: string;
	userOpenid?: string;
}

// no session-level config (the webhook URL is the endpoint)
export type WebhookSession = Record<string, never>;

interface PushTargetCommon {
	id: string;
	name: string;
	adapterId: string;
	scope: PushTargetScope;
	enabled: boolean;
	managedBy?: "adapter";
	testStatus?: PushAdapterTestStatus;
}

export type PushTarget =
	| (PushTargetCommon & { platform: "onebot"; session: OnebotSession })
	| (PushTargetCommon & { platform: "qq-official"; session: QQOfficialSession })
	| (PushTargetCommon & { platform: "webhook"; session: WebhookSession });

export type PushTargetPlatform = "onebot" | "qq-official" | "webhook";

export const KNOWN_PLATFORMS: ReadonlyArray<{ value: PushTargetPlatform; label: string }> = [
	{ value: "onebot", label: "OneBot v11" },
	{ value: "qq-official", label: "QQ 官方机器人" },
	{ value: "webhook", label: "Webhook" },
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
	/** per-UP AstrBot 人格 id —— 仅 AstrBot 宿主消费,独立端不用,但须镜像规范键。 */
	personaId?: string;
}

export type GuardLevel = 1 | 2 | 3;
export interface TimeRange {
	start: number;
	end: number;
}

export interface ContentFiltersFull {
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
	liveSummary: string;
	dynamic: string;
	dynamicVideo: string;
	specialDanmaku: string;
	specialUserEnter: string;
	guardBuy: GuardBundleShape;
}
export type TemplateOverride = Partial<TemplateBundleFull>;

export interface CardStyleFull {
	/**
	 * TD1 同步:规范 `CardStyleSchema.enabled`(z.boolean().default(true))。
	 * 此前镜像漏了它 → per-UP 卡片开关在 overrides.cardStyle 的 PATCH body
	 * 里被静默丢弃(用户在 dashboard 关某 UP 卡片不生效)。
	 */
	enabled: boolean;
	cardColorStart: string;
	cardColorEnd: string;
	font: string;
	hideDesc: boolean;
	hideFollower: boolean;
}
export type CardStyleOverride = Partial<CardStyleFull>;

/**
 * Per-UP 图集推送行为覆盖。空 / undefined 字段继承全局 `GlobalDefaults.imageGroup.{enable,forward}`。
 * 镜像 `packages/internal` 的 `ImageGroupSettingsPartialSchema`。
 */
export interface ImageGroupOverride {
	enable?: boolean;
	forward?: boolean;
}

export interface OverridesShape {
	features?: Partial<Record<FeatureKey, boolean>>;
	filters?: ContentFiltersOverride;
	schedule?: ScheduleOverride;
	templates?: TemplateOverride;
	ai?: AIOverride;
	cardStyle?: CardStyleOverride;
	imageGroup?: ImageGroupOverride;
}
export type SubscriptionOverrides = OverridesShape;

export interface SubscriptionState {
	lastDynamicId?: string;
	lastPushedAt: { dynamic?: string; live?: string };
	liveStatus: "idle" | "live" | "unknown";
}

/**
 * @全体成员「订阅级默认」。每个 UP 主独立持有自己的默认策略,作用于 routing 里所有未在
 * `atAll` Map 中显式覆写的 target。默认:开播 ON、动态 OFF。
 */
export interface SubscriptionAtAllDefaults {
	dynamic: boolean;
	live: boolean;
}

/**
 * @全体成员 per-target 覆写。tristate Map:
 * - Map 没 key → inherit(走 `atAllDefaults`)
 * - `true` → 显式 ON;`false` → 显式 OFF
 *
 * 后端 schema refine 强制 `Object.keys(atAll.X) ⊆ routing.X`。
 */
export interface SubscriptionAtAll {
	dynamic: Record<string, boolean>;
	live: Record<string, boolean>;
}

export interface Subscription {
	id: string;
	uid: string;
	enabled: boolean;
	groups: string[];
	notes?: string;
	cachedProfile?: CachedProfile;
	routing: SubscriptionRouting;
	atAllDefaults: SubscriptionAtAllDefaults;
	atAll: SubscriptionAtAll;
	overrides: SubscriptionOverrides;
	specialUsers: SpecialUser[];
	state: SubscriptionState;
}

// ---- Factories --------------------------------------------------------

/**
 * 生成 RFC 4122 v4 UUID。后端 schema 的 `id` / `adapterId` 都是 `z.uuid()` 严格
 * 校验,必须返回标准 8-4-4-4-12 格式,否则创建订阅 / 适配器 / 目标的 POST 全 400。
 *
 * 刻意**不用** `crypto.randomUUID()` —— 它只在 **secure context**(HTTPS 或
 * localhost)可用;独立端 docker 部署常经 `http://<内网IP>:8787` 访问 = 非 secure
 * context,该方法直接是 `undefined`。`crypto.getRandomValues()` 不受 secure context
 * 限制(所有现代浏览器恒有),用它手搓 v4 UUID,任何部署形态下都产出合法格式。
 */
export function newId(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
	bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
	return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
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
		atAllDefaults: { dynamic: false, live: true },
		atAll: { dynamic: {}, live: {} },
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
				transport: "http",
				baseUrl: "http://127.0.0.1:3000",
				protocolVersion: "v11",
				headers: {},
				timeoutMs: 15_000,
				retryTimes: 0,
				retryIntervalMs: 1_000,
			},
		};
	}
	if (platform === "qq-official") {
		return {
			...base,
			platform: "qq-official",
			config: { appId: "", appSecret: "", sandbox: false, botType: "public" },
		};
	}
	return {
		...base,
		platform: "webhook",
		config: { url: "https://example.com/hook", provider: "generic", headers: {} },
	};
}

/**
 * 切换 OneBot 适配器的连接方式 —— 整体替换 config(branch schema 是 strict,不能
 * 留上一个 transport 的残字段),保留 accessToken / 超时 / 重试等共用字段。切到
 * ws / ws-reverse 时,若 retryTimes 还是 0 则提到 3(bot 偶发重连不丢首条推送)。
 */
export function switchOnebotTransport(
	cfg: OnebotAdapterConfig,
	transport: OnebotTransport,
): OnebotAdapterConfig {
	const common: OnebotAdapterConfigCommon = {
		accessToken: cfg.accessToken,
		protocolVersion: cfg.protocolVersion ?? "v11",
		timeoutMs: cfg.timeoutMs,
		retryTimes: cfg.retryTimes || (transport === "http" ? 0 : 3),
		retryIntervalMs: cfg.retryIntervalMs,
	};
	if (transport === "http") {
		return { ...common, transport: "http", baseUrl: "http://127.0.0.1:3000", headers: {} };
	}
	if (transport === "ws") {
		return { ...common, transport: "ws", url: "ws://127.0.0.1:3001", headers: {} };
	}
	return { ...common, transport: "ws-reverse", port: 9797 };
}

export function makeEmptyTarget(adapter: PushAdapter, name: string): PushTarget {
	const base = { id: newId(), name, adapterId: adapter.id, enabled: true } as const;
	if (adapter.platform === "onebot") {
		return { ...base, platform: "onebot", scope: "group", session: {} };
	}
	if (adapter.platform === "qq-official") {
		return { ...base, platform: "qq-official", scope: "group", session: {} };
	}
	return { ...base, platform: "webhook", scope: "channel", session: {} };
}

export function platformLabel(platform: string): string {
	const known = KNOWN_PLATFORMS.find((p) => p.value === platform);
	return known?.label ?? platform;
}
