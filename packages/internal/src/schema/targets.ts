import { z } from "zod";

/**
 * Push 目标平台。Adapter 矩阵按 platform 分发：
 * - `onebot`：独立端 OneBot v11 HTTP adapter
 * - `webhook`：任意 HTTP POST JSON
 * - `web-dashboard`：通过独立端 WebSocket 推到 Dashboard 通知中心
 * - `koishi-bot`：仅 koishi 薄壳侧实现，通过 `ctx.bots[botPlatform]` 调 koishi bot
 *   `sendMessage`；独立端不注册该 platform adapter
 */
export const PushTargetPlatformSchema = z.union([
	z.literal("onebot"),
	z.literal("webhook"),
	z.literal("web-dashboard"),
	z.literal("koishi-bot"),
]);
export type PushTargetPlatform = z.infer<typeof PushTargetPlatformSchema>;

export const PushTargetScopeSchema = z.enum(["group", "private", "channel"]);
export type PushTargetScope = z.infer<typeof PushTargetScopeSchema>;

/* -------------------------------------------------------------------------- */
/* Adapter (connection-level) configs                                         */
/* -------------------------------------------------------------------------- */

export const OnebotAdapterConfigSchema = z.object({
	baseUrl: z.url(),
	accessToken: z.string().optional(),
	/** OneBot 协议版本；首期固定 v11，留位以便后续扩展 v12。 */
	protocolVersion: z.literal("v11").default("v11"),
	/** 附加到每次请求的 HTTP header（例如自定义鉴权头）。 */
	headers: z.record(z.string(), z.string()).default({}),
	/** 单次请求总超时（毫秒），覆盖连接 + 响应。 */
	timeoutMs: z.number().int().positive().default(15_000),
	/** 失败时的重试次数（不含首次）。 */
	retryTimes: z.number().int().min(0).default(0),
	/** 两次重试之间的等待（毫秒）。 */
	retryIntervalMs: z.number().int().min(0).default(1_000),
});
export type OnebotAdapterConfig = z.infer<typeof OnebotAdapterConfigSchema>;

export const WebhookAdapterConfigSchema = z.object({
	url: z.url(),
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

export const PushAdapterSchema = z.discriminatedUnion("platform", [
	OnebotAdapterSchema,
	WebhookAdapterSchema,
	WebDashboardAdapterSchema,
	KoishiBotAdapterSchema,
]);
export type PushAdapter = z.infer<typeof PushAdapterSchema>;

/* -------------------------------------------------------------------------- */
/* Target (session-level) — references an adapter                             */
/* -------------------------------------------------------------------------- */

export const OnebotSessionSchema = z.object({
	groupId: z.string().optional(),
	userId: z.string().optional(),
});
export type OnebotSession = z.infer<typeof OnebotSessionSchema>;

export const WebhookSessionSchema = z.object({}).strict();
export type WebhookSession = z.infer<typeof WebhookSessionSchema>;

export const WebDashboardSessionSchema = z.object({
	/** 可选过滤：仅推到指定 user 的会话；空则广播 */
	dashboardUser: z.string().optional(),
});
export type WebDashboardSession = z.infer<typeof WebDashboardSessionSchema>;

export const KoishiBotSessionSchema = z.object({
	channelId: z.string().optional(),
	guildId: z.string().optional(),
	userId: z.string().optional(),
});
export type KoishiBotSession = z.infer<typeof KoishiBotSessionSchema>;

const PushTargetCommonShape = {
	id: z.uuid(),
	name: z.string().min(1),
	adapterId: z.uuid(),
	scope: PushTargetScopeSchema,
	enabled: z.boolean(),
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

export const PushTargetSchema = z.discriminatedUnion("platform", [
	OnebotPushTargetSchema,
	WebhookPushTargetSchema,
	WebDashboardPushTargetSchema,
	KoishiBotPushTargetSchema,
]);
export type PushTarget = z.infer<typeof PushTargetSchema>;
