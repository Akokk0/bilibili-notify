import { z } from "zod";

/**
 * Push 目标平台。Adapter 矩阵按 platform 分发：
 * - `onebot`：独立端 OneBot v11 HTTP adapter
 * - `koishi-onebot` / `koishi-discord` / `koishi-telegram` / `koishi-...`：Koishi 端 bot.sendMessage 通过 platform 字段选 bot
 * - `webhook`：任意 HTTP POST JSON
 * - `web-dashboard`：通过独立端 WebSocket 推到 Dashboard 通知中心（前端"通知"面板）
 */
export const PushTargetPlatformSchema = z.union([
	z.literal("onebot"),
	z.literal("webhook"),
	z.literal("web-dashboard"),
	z
		.string()
		.regex(/^koishi-[a-z0-9-]+$/, "Koishi platform must be 'koishi-<botPlatform>' (lowercase)"),
]);
export type PushTargetPlatform = z.infer<typeof PushTargetPlatformSchema>;

export const PushTargetScopeSchema = z.enum(["group", "private", "channel"]);
export type PushTargetScope = z.infer<typeof PushTargetScopeSchema>;

const OnebotConfigSchema = z.object({
	baseUrl: z.url(),
	accessToken: z.string().optional(),
	groupId: z.string().optional(),
	userId: z.string().optional(),
	/** OneBot 协议版本；首期固定 v11，留位以便后续扩展 v12。 */
	protocolVersion: z.literal("v11").default("v11"),
});
export type OnebotConfig = z.infer<typeof OnebotConfigSchema>;

const KoishiTargetConfigSchema = z.object({
	/** koishi 内部 bot.platform，如 'onebot' / 'discord' / 'telegram'。与 PushTarget.platform 的 'koishi-' 前缀去掉等价。 */
	botPlatform: z.string(),
	/** koishi bot selfId；多 bot 同 platform 时用来挑 bot。 */
	selfId: z.string().optional(),
	channelId: z.string().optional(),
	guildId: z.string().optional(),
	userId: z.string().optional(),
});
export type KoishiTargetConfig = z.infer<typeof KoishiTargetConfigSchema>;

const WebhookConfigSchema = z.object({
	url: z.url(),
	secret: z.string().optional(),
	/** 自定义 header 例如 Authorization */
	headers: z.record(z.string(), z.string()).default({}),
});
export type WebhookConfig = z.infer<typeof WebhookConfigSchema>;

const WebDashboardConfigSchema = z.object({
	/** 可选过滤：仅推到指定 user 的会话；空则广播 */
	dashboardUser: z.string().optional(),
});
export type WebDashboardConfig = z.infer<typeof WebDashboardConfigSchema>;

/** 按 platform 字段分支取对应 config（运行时由 PushTarget.platform 决定）。 */
export const PushTargetConfigSchema = z.union([
	OnebotConfigSchema,
	KoishiTargetConfigSchema,
	WebhookConfigSchema,
	WebDashboardConfigSchema,
]);
export type PushTargetConfig = z.infer<typeof PushTargetConfigSchema>;

export const PushTargetTestStatusSchema = z.object({
	ok: z.boolean(),
	lastCheckedAt: z.string(),
	latencyMs: z.number().optional(),
	err: z.string().optional(),
});
export type PushTargetTestStatus = z.infer<typeof PushTargetTestStatusSchema>;

export const PushTargetSchema = z.object({
	id: z.uuid(),
	name: z.string().min(1),
	platform: PushTargetPlatformSchema,
	scope: PushTargetScopeSchema,
	config: PushTargetConfigSchema,
	enabled: z.boolean(),
	testStatus: PushTargetTestStatusSchema.optional(),
});
export type PushTarget = z.infer<typeof PushTargetSchema>;
