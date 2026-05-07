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

export const OnebotConfigSchema = z.object({
	baseUrl: z.url(),
	accessToken: z.string().optional(),
	groupId: z.string().optional(),
	userId: z.string().optional(),
	/** OneBot 协议版本；首期固定 v11，留位以便后续扩展 v12。 */
	protocolVersion: z.literal("v11").default("v11"),
});
export type OnebotConfig = z.infer<typeof OnebotConfigSchema>;

export const KoishiTargetConfigSchema = z.object({
	/** koishi 内部 bot.platform，如 'onebot' / 'discord' / 'telegram'。与 PushTarget.platform 的 'koishi-' 前缀去掉等价。 */
	botPlatform: z.string(),
	/** koishi bot selfId；多 bot 同 platform 时用来挑 bot。 */
	selfId: z.string().optional(),
	channelId: z.string().optional(),
	guildId: z.string().optional(),
	userId: z.string().optional(),
});
export type KoishiTargetConfig = z.infer<typeof KoishiTargetConfigSchema>;

export const WebhookConfigSchema = z.object({
	url: z.url(),
	secret: z.string().optional(),
	/** 自定义 header 例如 Authorization */
	headers: z.record(z.string(), z.string()).default({}),
});
export type WebhookConfig = z.infer<typeof WebhookConfigSchema>;

export const WebDashboardConfigSchema = z
	.object({
		/** 可选过滤：仅推到指定 user 的会话；空则广播 */
		dashboardUser: z.string().optional(),
	})
	.strict();
export type WebDashboardConfig = z.infer<typeof WebDashboardConfigSchema>;

/**
 * 按 platform 字段分支取对应 config 的便捷 union（运行时由 PushTarget.platform 决定）。
 * 实际 PushTarget 校验请用 `PushTargetSchema`，它按 platform 做了 discriminated union，
 * 可避免 onebot/webhook/web-dashboard 三家 config 互相误匹配。
 */
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

/**
 * 顶层 PushTarget schema：按 platform 字段分发 config 形态。
 *
 * 实现说明：
 * - `onebot` / `webhook` / `web-dashboard` 是固定 literal，三者一起走 `z.discriminatedUnion`，
 *   这样 zod 会基于 `platform` 直接挑分支、避免无标签 union 的"任意 config 偶然通过别家 schema"问题。
 * - `koishi-*` 平台是动态前缀，不能作为 discriminator literal，所以单独走一个分支并用
 *   `z.string().regex(/^koishi-/)` 校验 platform。`koishi-` 平台只有 `KoishiTargetConfig`
 *   一种结构，不与上面三家冲突，因此即便不在 discriminatedUnion 内也不会误匹配。
 * - 外层用 `z.union` 把两边粘起来。
 */
const KOISHI_PLATFORM_REGEX = /^koishi-[a-z0-9-]+$/;
const PushTargetCommonShape = {
	id: z.uuid(),
	name: z.string().min(1),
	scope: PushTargetScopeSchema,
	enabled: z.boolean(),
	testStatus: PushTargetTestStatusSchema.optional(),
} as const;

const OnebotPushTargetSchema = z.object({
	...PushTargetCommonShape,
	platform: z.literal("onebot"),
	config: OnebotConfigSchema,
});

const WebhookPushTargetSchema = z.object({
	...PushTargetCommonShape,
	platform: z.literal("webhook"),
	config: WebhookConfigSchema,
});

const WebDashboardPushTargetSchema = z.object({
	...PushTargetCommonShape,
	platform: z.literal("web-dashboard"),
	config: WebDashboardConfigSchema,
});

const KoishiPushTargetSchema = z.object({
	...PushTargetCommonShape,
	platform: z
		.string()
		.regex(KOISHI_PLATFORM_REGEX, "Koishi platform must be 'koishi-<botPlatform>' (lowercase)"),
	config: KoishiTargetConfigSchema,
});

export const PushTargetSchema = z.union([
	z.discriminatedUnion("platform", [
		OnebotPushTargetSchema,
		WebhookPushTargetSchema,
		WebDashboardPushTargetSchema,
	]),
	KoishiPushTargetSchema,
]);
export type PushTarget = z.infer<typeof PushTargetSchema>;
