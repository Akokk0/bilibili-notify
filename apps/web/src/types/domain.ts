/**
 * 独立端 Dashboard 的域类型门面(原「手维护镜像」,已退役)。
 *
 * 类型的单一来源:域模型在 `@bilibili-notify/internal`(全部 `import type`,
 * 编译后擦除,web 产物不含核心代码);wire DTO 在 `@bilibili-notify/contract`。
 * 值级常量(FEATURE_KEYS / DEFAULT_FEATURE_FLAGS)从 internal 的零依赖子路径
 * `@bilibili-notify/internal/constants` 运行时导入 —— 该模块不含 zod,bundle
 * 零增量。本文件自留的只剩 UI 文案、工厂函数与表单辅助。
 *
 * 旧镜像时代的 `*Full` / `*Override` 命名以别名保留,消费者无需改动:
 * `XxxFull` = internal 的全量类型,`XxxOverride` = internal 的 `XxxPartial`
 * (cardLayout / messageLayout 例外:per-UP 是「整份覆盖」,Override = 全量)。
 */

import type { SubscriptionDTO } from "@bilibili-notify/contract";
import type {
	OnebotAdapterConfig,
	OnebotTransport,
	PushAdapter,
	PushTarget,
	PushTargetPlatform,
	WebhookProvider,
} from "@bilibili-notify/internal";
import {
	DEFAULT_FEATURE_FLAGS,
	DEFAULT_ROAST_SCHEDULE,
	FEATURE_KEYS,
	type FeatureKey,
	ONEBOT_FORWARD_MIN_TIMEOUT_MS,
	ONEBOT_IMAGE_MIN_TIMEOUT_MS,
} from "@bilibili-notify/internal/constants";

export type { FeatureKey };
export { DEFAULT_FEATURE_FLAGS, FEATURE_KEYS };

/**
 * Dashboard 消费的订阅一直是 wire DTO 形状(internal Subscription + 服务端
 * join 回来的 cachedProfile / state / followed),沿用旧名 Subscription。
 */
export type Subscription = SubscriptionDTO;

export type {
	AIOverride,
	CardBlock as CardBlockFull,
	// per-UP 卡片版式是「整份覆盖」(fork 全局后编辑),不是 Partial。
	CardLayout as CardLayoutFull,
	ContentFiltersPartial as ContentFiltersOverride,
	ImageGroupSettingsPartial as ImageGroupOverride,
	MessageBlock as MessageBlockFull,
	MessageKindLayout as MessageKindLayoutFull,
	// per-UP 消息版式同 cardLayout:整份覆盖,不是 Partial。
	MessageLayout as MessageLayoutOverride,
	OnebotAdapterConfig,
	OnebotSession,
	OnebotTransport,
	// 推送平台类型直接用 internal 的定义:将来薄插件桥接进来的平台加进那条 union 就自动出现在这里。
	PushAdapter,
	PushTarget,
	PushTargetPlatform,
	PushTargetScope,
	QQOfficialAdapterConfig,
	QQOfficialBotType,
	QQOfficialSession,
	ScheduleConfigPartial as ScheduleOverride,
	SpecialUser,
	SubscriptionOverrides as OverridesShape,
	SubscriptionRouting,
	TemplateBundlePartial as TemplateOverride,
	WebhookProvider,
} from "@bilibili-notify/internal";

// ---- UI 文案 -----------------------------------------------------------

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

export const KNOWN_PLATFORMS: ReadonlyArray<{ value: PushTargetPlatform; label: string }> = [
	{ value: "onebot", label: "OneBot v11" },
	{ value: "qq-official", label: "QQ 官方机器人" },
	{ value: "webhook", label: "Webhook" },
];

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

function emptyRouting(): Subscription["routing"] {
	const out: Partial<Subscription["routing"]> = {};
	for (const k of FEATURE_KEYS) out[k] = [];
	return out as Subscription["routing"];
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
		// 新订阅不自带定时锐评 —— 加一个 UP 不该顺手给群里排一条周期推送。
		// 与服务端的 makeEmptySubscription 保持一致。
		roastSchedule: { ...DEFAULT_ROAST_SCHEDULE },
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
				imageMinTimeoutMs: ONEBOT_IMAGE_MIN_TIMEOUT_MS,
				forwardMinTimeoutMs: ONEBOT_FORWARD_MIN_TIMEOUT_MS,
				retryTimes: 0,
				retryIntervalMs: 1_000,
			},
		};
	}
	if (platform === "qq-official") {
		return {
			...base,
			platform: "qq-official",
			config: { appId: "", appSecret: "", sandbox: false, botType: "public", logReconnects: false },
		};
	}
	return {
		...base,
		platform: "webhook",
		config: { url: "https://example.com/hook", provider: "generic", headers: {} },
	};
}

/** OneBot 三种连接方式(transport)共用的连接字段。 */
type OnebotAdapterConfigCommon = Pick<
	OnebotAdapterConfig,
	| "accessToken"
	| "protocolVersion"
	| "timeoutMs"
	| "imageMinTimeoutMs"
	| "forwardMinTimeoutMs"
	| "retryTimes"
	| "retryIntervalMs"
>;

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
		imageMinTimeoutMs: cfg.imageMinTimeoutMs,
		forwardMinTimeoutMs: cfg.forwardMinTimeoutMs,
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
