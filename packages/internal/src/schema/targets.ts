import { z } from "zod";

/**
 * Push 目标平台。Adapter 矩阵按 platform 分发：
 * - `onebot`：独立端 OneBot v11 HTTP adapter
 * - `webhook`：任意 HTTP POST JSON
 * - `web-dashboard`：通过独立端 WebSocket 推到 Dashboard 通知中心
 * - `koishi-bot`：仅 koishi 薄壳侧实现，通过 `ctx.bots[botPlatform]` 调 koishi bot
 *   `sendMessage`；独立端不注册该 platform adapter
 * - `astrbot`：仅 AstrBot 插件侧实现，通过 Python 壳按 `unified_msg_origin` 投递
 * - `qq-official`：独立端 QQ 官方机器人(q.qq.com)WS 网关 adapter,频道/群/C2C
 */
export const PushTargetPlatformSchema = z.union([
	z.literal("onebot"),
	z.literal("webhook"),
	z.literal("web-dashboard"),
	z.literal("koishi-bot"),
	z.literal("astrbot"),
	z.literal("qq-official"),
]);
export type PushTargetPlatform = z.infer<typeof PushTargetPlatformSchema>;

export const PushTargetScopeSchema = z.enum(["group", "private", "channel"]);
export type PushTargetScope = z.infer<typeof PushTargetScopeSchema>;

/* -------------------------------------------------------------------------- */
/* Adapter (connection-level) configs                                         */
/* -------------------------------------------------------------------------- */

/**
 * OneBot 适配器三种连接方式(`transport`)共用的字段。
 * `transport` 是连接属性,只活在 adapter config 里 —— PushTarget / session 不受影响。
 */
const onebotCommonConfigShape = {
	accessToken: z.string().optional(),
	/** OneBot 协议版本；首期固定 v11，留位以便后续扩展 v12。 */
	protocolVersion: z.literal("v11").default("v11"),
	/** 单次操作总超时（毫秒）。HTTP = 请求超时；WS = 等 echo 响应超时。 */
	timeoutMs: z.number().int().positive().default(15_000),
	/** 失败时的重试次数（不含首次）。 */
	retryTimes: z.number().int().min(0).default(0),
	/** 两次重试之间的等待（毫秒）。 */
	retryIntervalMs: z.number().int().min(0).default(1_000),
} as const;

/** HTTP:独立端用 fetch POST 到 bot 的 OneBot HTTP API。 */
export const OnebotHttpConfigSchema = z
	.object({
		// `.default("http")` 兼顾迁移:早期 adapters.json 的 onebot 条目没有 `transport`
		// 字段,union 试到本 branch 时 default 补上 → 旧数据按 http 加载。
		transport: z.literal("http").default("http"),
		/** bot 的 OneBot HTTP API 根地址。 */
		baseUrl: z.url(),
		/** 附加到每次请求的 HTTP header（例如自定义鉴权头）。 */
		headers: z.record(z.string(), z.string()).default({}),
		...onebotCommonConfigShape,
	})
	.strict();

/** 正向 WS:独立端作为 WS 客户端,主动连到 bot 的 WS 服务。 */
export const OnebotWsConfigSchema = z
	.object({
		transport: z.literal("ws"),
		/** bot 的 OneBot 正向 WS 地址,必须 `ws://` 或 `wss://`。 */
		url: z.string().regex(/^wss?:\/\/\S+$/i, "必须是 ws:// 或 wss:// 地址"),
		/** WS 握手请求头（例如自定义鉴权头）。 */
		headers: z.record(z.string(), z.string()).default({}),
		...onebotCommonConfigShape,
	})
	.strict();

/** 反向 WS:独立端监听 `port`,bot 作为客户端主动连进来。端口即身份。 */
export const OnebotWsReverseConfigSchema = z
	.object({
		transport: z.literal("ws-reverse"),
		/** 独立端为该 adapter 开的 WS 监听端口；bot 连 `ws://<host>:<port>/`。 */
		port: z.number().int().min(1).max(65_535),
		...onebotCommonConfigShape,
	})
	.strict();

/**
 * OneBot 适配器连接配置 —— 按 `transport` 区分 HTTP / 正向 WS / 反向 WS。
 *
 * 用 `z.union`(而非 `discriminatedUnion`):http branch 的 `transport` 带
 * `.default("http")`,早期没有 `transport` 字段的旧 adapters.json 条目试到 http
 * branch 时 default 补上 → 旧数据无缝按 http 加载。三 branch 的 `transport` 是互斥
 * literal,新数据只会命中唯一一个 branch,无歧义。
 */
export const OnebotAdapterConfigSchema = z.union([
	OnebotHttpConfigSchema,
	OnebotWsConfigSchema,
	OnebotWsReverseConfigSchema,
]);
export type OnebotAdapterConfig = z.infer<typeof OnebotAdapterConfigSchema>;
export type OnebotTransport = OnebotAdapterConfig["transport"];

export const WebhookProviderSchema = z.enum(["generic", "dingtalk", "feishu", "wecom"]);
export type WebhookProvider = z.infer<typeof WebhookProviderSchema>;

export const WebhookAdapterConfigSchema = z.object({
	url: z.url(),
	/** 协议提供方;旧配置缺省为 generic,保持 bilibili-notify JSON envelope 兼容。 */
	provider: WebhookProviderSchema.default("generic"),
	secret: z.string().optional(),
	/** 自定义 header 例如 Authorization */
	headers: z.record(z.string(), z.string()).default({}),
});
export type WebhookAdapterConfig = z.infer<typeof WebhookAdapterConfigSchema>;

export const WebDashboardAdapterConfigSchema = z.object({}).strict();
export type WebDashboardAdapterConfig = z.infer<typeof WebDashboardAdapterConfigSchema>;

export const KoishiBotAdapterConfigSchema = z.object({
	/** koishi 内部 bot.platform，例如 'onebot' / 'discord' / 'telegram'。 */
	botPlatform: z.string().min(1),
	/** 同 platform 多 bot 时挑 bot。 */
	selfId: z.string().optional(),
});
export type KoishiBotAdapterConfig = z.infer<typeof KoishiBotAdapterConfigSchema>;

// AstrBot 由宿主 Python 壳完成实际投递；连接级配置固定为空对象。
export const AstrBotAdapterConfigSchema = z.object({}).strict();
export type AstrBotAdapterConfig = z.infer<typeof AstrBotAdapterConfigSchema>;

/**
 * QQ 官方机器人公域/私域类型。私域可发原生 markdown,公域只能发模板 markdown ——
 * 决定 adapter 的 markdown 能力门控(私域默认开、公域默认关)。
 */
export const QQOfficialBotTypeSchema = z.enum(["public", "private"]);
export type QQOfficialBotType = z.infer<typeof QQOfficialBotTypeSchema>;

/**
 * QQ 官方机器人(q.qq.com,非 OneBot/NapCat)适配器连接配置。
 * 鉴权 appId+appSecret → getAppAccessToken;`sandbox` 切沙箱/正式环境的 wss+REST host。
 */
export const QQOfficialAdapterConfigSchema = z
	.object({
		appId: z.string().min(1),
		appSecret: z.string().min(1),
		sandbox: z.boolean().default(false),
		botType: QQOfficialBotTypeSchema.default("public"),
	})
	.strict();
export type QQOfficialAdapterConfig = z.infer<typeof QQOfficialAdapterConfigSchema>;

export const PushAdapterTestStatusSchema = z.object({
	ok: z.boolean(),
	lastCheckedAt: z.string(),
	latencyMs: z.number().optional(),
	err: z.string().optional(),
});
export type PushAdapterTestStatus = z.infer<typeof PushAdapterTestStatusSchema>;

/**
 * Push adapter — 平台级的"连接实例"。
 *
 * 类比 Koishi bot 实例：一份 baseUrl/accessToken 一次配置，被多个 PushTarget
 * (实际的群/私聊/dashboard 会话) 复用。
 */
const PushAdapterCommonShape = {
	id: z.uuid(),
	name: z.string().min(1),
	enabled: z.boolean(),
	testStatus: PushAdapterTestStatusSchema.optional(),
} as const;

const OnebotAdapterSchema = z.object({
	...PushAdapterCommonShape,
	platform: z.literal("onebot"),
	config: OnebotAdapterConfigSchema,
});

const WebhookAdapterSchema = z.object({
	...PushAdapterCommonShape,
	platform: z.literal("webhook"),
	config: WebhookAdapterConfigSchema,
});

const WebDashboardAdapterSchema = z.object({
	...PushAdapterCommonShape,
	platform: z.literal("web-dashboard"),
	config: WebDashboardAdapterConfigSchema,
});

const KoishiBotAdapterSchema = z.object({
	...PushAdapterCommonShape,
	platform: z.literal("koishi-bot"),
	config: KoishiBotAdapterConfigSchema,
});

export const AstrBotAdapterSchema = z.object({
	...PushAdapterCommonShape,
	platform: z.literal("astrbot"),
	config: AstrBotAdapterConfigSchema,
});
export type AstrBotAdapter = z.infer<typeof AstrBotAdapterSchema>;

const QQOfficialAdapterSchema = z.object({
	...PushAdapterCommonShape,
	platform: z.literal("qq-official"),
	config: QQOfficialAdapterConfigSchema,
});

export const PushAdapterSchema = z.discriminatedUnion("platform", [
	OnebotAdapterSchema,
	WebhookAdapterSchema,
	WebDashboardAdapterSchema,
	KoishiBotAdapterSchema,
	AstrBotAdapterSchema,
	QQOfficialAdapterSchema,
]);
export type PushAdapter = z.infer<typeof PushAdapterSchema>;

/* -------------------------------------------------------------------------- */
/* Target (session-level) — references an adapter                             */
/* -------------------------------------------------------------------------- */

// P2:.strict() —— 对齐已 strict 的 webhook / web-dashboard session。此前
// non-strict 放任 `gruopId` 之类拼写错被静默忽略,target 无可投递地址却校验
// 通过、推送悄悄丢。多收一个未知键即报错,让配置拼写错在保存期就暴露。
export const OnebotSessionSchema = z
	.object({
		groupId: z.string().optional(),
		userId: z.string().optional(),
	})
	.strict();
export type OnebotSession = z.infer<typeof OnebotSessionSchema>;

export const WebhookSessionSchema = z.object({}).strict();
export type WebhookSession = z.infer<typeof WebhookSessionSchema>;

// Web Dashboard 是单用户 in-process passthrough;无 per-user 概念,不需要 session 字段。
// 任何 web-dashboard target 都会通过 WS 广播给所有连接的 dashboard 客户端。
export const WebDashboardSessionSchema = z.object({}).strict();
export type WebDashboardSession = z.infer<typeof WebDashboardSessionSchema>;

export const KoishiBotSessionSchema = z
	.object({
		channelId: z.string().optional(),
		guildId: z.string().optional(),
		userId: z.string().optional(),
	})
	.strict();
export type KoishiBotSession = z.infer<typeof KoishiBotSessionSchema>;

export const AstrBotSessionSchema = z
	.object({
		/** AstrBot 会话稳定定位符，来自 `event.unified_msg_origin`。 */
		unified_msg_origin: z.string().min(1),
		/** 展示用宿主平台摘要，例如 aiocqhttp / telegram。 */
		platform: z.string().optional(),
		/** 展示用消息类型摘要，例如 group / private / channel。 */
		messageType: z.string().optional(),
		/** 展示用会话 ID 摘要；投递仍以 unified_msg_origin 为准。 */
		sessionId: z.string().optional(),
		/** 展示用会话名摘要。 */
		sessionName: z.string().optional(),
	})
	.strict();
export type AstrBotSession = z.infer<typeof AstrBotSessionSchema>;

/**
 * QQ 官方机器人会话。按 target.scope 用不同字段(发送时运行期校验,缺失即拒)。
 * - channel(频道子频道):channelId 必填,guildId 仅面板分组/排错用。
 * - group(群):groupOpenid —— 不透明 id,只能从入站事件捞,用户不可手填群号。
 * - private(C2C 单聊):userOpenid —— 同样从入站事件捞。
 */
export const QQOfficialSessionSchema = z
	.object({
		guildId: z.string().optional(),
		channelId: z.string().optional(),
		groupOpenid: z.string().optional(),
		userOpenid: z.string().optional(),
	})
	.strict();
export type QQOfficialSession = z.infer<typeof QQOfficialSessionSchema>;

const PushTargetCommonShape = {
	id: z.uuid(),
	name: z.string().min(1),
	adapterId: z.uuid(),
	scope: PushTargetScopeSchema,
	enabled: z.boolean(),
	/** 生命周期由 adapter 管理的系统目标；用户不直接编辑 / 删除。 */
	managedBy: z.literal("adapter").optional(),
	/**
	 * 最近一次显式 `/api/push/test` 或真实业务推送的结果。
	 * 跟 PushAdapter.testStatus 互相独立 — 此处只反映会话级 (group/userId) 是否可达,
	 * adapter 连接级状态在 PushAdapter.testStatus。
	 */
	testStatus: PushAdapterTestStatusSchema.optional(),
} as const;

const OnebotPushTargetSchema = z.object({
	...PushTargetCommonShape,
	platform: z.literal("onebot"),
	session: OnebotSessionSchema,
});

const WebhookPushTargetSchema = z.object({
	...PushTargetCommonShape,
	platform: z.literal("webhook"),
	session: WebhookSessionSchema,
});

const WebDashboardPushTargetSchema = z.object({
	...PushTargetCommonShape,
	platform: z.literal("web-dashboard"),
	session: WebDashboardSessionSchema,
});

const KoishiBotPushTargetSchema = z.object({
	...PushTargetCommonShape,
	platform: z.literal("koishi-bot"),
	session: KoishiBotSessionSchema,
});

export const AstrBotPushTargetSchema = z.object({
	...PushTargetCommonShape,
	platform: z.literal("astrbot"),
	session: AstrBotSessionSchema,
});
export type AstrBotPushTarget = z.infer<typeof AstrBotPushTargetSchema>;

const QQOfficialPushTargetSchema = z.object({
	...PushTargetCommonShape,
	platform: z.literal("qq-official"),
	session: QQOfficialSessionSchema,
});

export const PushTargetSchema = z
	.discriminatedUnion("platform", [
		OnebotPushTargetSchema,
		WebhookPushTargetSchema,
		WebDashboardPushTargetSchema,
		KoishiBotPushTargetSchema,
		AstrBotPushTargetSchema,
		QQOfficialPushTargetSchema,
	])
	.superRefine((target, ctx) => {
		if (target.managedBy === "adapter" && target.platform !== "webhook") {
			ctx.addIssue({
				code: "custom",
				path: ["managedBy"],
				message: "managedBy is only supported for webhook targets",
			});
		}
	});
export type PushTarget = z.infer<typeof PushTargetSchema>;
