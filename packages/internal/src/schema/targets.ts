import { z } from "zod";
import {
	ONEBOT_FORWARD_MIN_TIMEOUT_MS,
	ONEBOT_IMAGE_MIN_TIMEOUT_MS,
	PUSH_TARGET_PLATFORMS,
} from "../constants.js";

/**
 * Push 目标平台。Adapter 矩阵按 platform 分发(server 侧 `apps/server/src/platforms/`
 * 一平台一实现)—— 这条 union 就是将来薄插件把 Koishi / AstrBot 桥接进来时的接入点:
 * 往 constants 的 `PUSH_TARGET_PLATFORMS` 加一个平台名 + 一套 adapter/session schema +
 * 一个 server adapter。词表住零依赖的 constants 是为了前端也拿得到(平台能力判断在那边)。
 * - `onebot`:OneBot v11 HTTP adapter
 * - `webhook`:任意 HTTP POST JSON
 * - `qq-official`:QQ 官方机器人(q.qq.com)WS 网关 adapter,频道/群/C2C
 */
export const PushTargetPlatformSchema = z.enum(PUSH_TARGET_PLATFORMS);
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
	/**
	 * 带图普通消息的超时**下限**（毫秒）。协议端要先把图传到 QQ 图床才回响应，实测
	 * 常超 15s，所以取 `max(timeoutMs, 此值)` 单独放宽。`0` = 关闭放宽，严格按
	 * `timeoutMs` 走（想让挂掉的 bot 快速失败、别拖住串行发送的后续目标时用）。
	 */
	imageMinTimeoutMs: z.number().int().min(0).default(ONEBOT_IMAGE_MIN_TIMEOUT_MS),
	/** 合并转发（`send_*_forward_msg`）的超时下限（毫秒）。语义同上，`0` = 关闭放宽。 */
	forwardMinTimeoutMs: z.number().int().min(0).default(ONEBOT_FORWARD_MIN_TIMEOUT_MS),
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
		/**
		 * 空串 = 尚未配置密钥,**合法可存**(与 onebot 的 `accessToken`、webhook 的
		 * `secret` 建模一致)。这里曾经是 `.min(1)`,结果脱敏备份把 appSecret 抹成空串
		 * 后就再也存不回去 —— 恢复直接 ConfigValidationError(scope=adapters)。
		 *
		 * 「要有真密钥才能连」是**连接期**的约束,不是**存储期**的:见
		 * `platforms/qq-official.ts` 的 isAvailable / reconcile,两处都拒绝空密钥的
		 * adapter,不会拿空密钥去撞 QQ 网关。
		 */
		appSecret: z.string(),
		sandbox: z.boolean().default(false),
		botType: QQOfficialBotTypeSchema.default("public"),
		/** 是否记录网关 RECONNECT/RESUMED 事件日志。QQ 官方网关每约 30 分钟主动要求
		 * 重连一次,属正常协议行为;默认关闭避免刷屏,排障时可开启。 */
		logReconnects: z.boolean().default(false),
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
 * 类比一个 bot 实例:一份 baseUrl/accessToken 一次配置,被多个 PushTarget
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

const QQOfficialAdapterSchema = z.object({
	...PushAdapterCommonShape,
	platform: z.literal("qq-official"),
	config: QQOfficialAdapterConfigSchema,
});

export const PushAdapterSchema = z.discriminatedUnion("platform", [
	OnebotAdapterSchema,
	WebhookAdapterSchema,
	QQOfficialAdapterSchema,
]);
export type PushAdapter = z.infer<typeof PushAdapterSchema>;

/* -------------------------------------------------------------------------- */
/* Target (session-level) — references an adapter                             */
/* -------------------------------------------------------------------------- */

// P2:.strict() —— 对齐已 strict 的 webhook session。此前
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

const QQOfficialPushTargetSchema = z.object({
	...PushTargetCommonShape,
	platform: z.literal("qq-official"),
	session: QQOfficialSessionSchema,
});

export const PushTargetSchema = z
	.discriminatedUnion("platform", [
		OnebotPushTargetSchema,
		WebhookPushTargetSchema,
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

/**
 * 群目标的「群地址」—— 与入站帧里的 `groupId` 是同一个值(OneBot 是群号,官机是群
 * openid)。没有入站的平台(webhook)没有地址。
 *
 * 和 {@link groupSessionFor} 是一对反函数,都住在 session 形状声明的地方:各处自己
 * 按平台写一个 switch 的话,以后接进来的新平台会在一处落进 default、另一处被列出来,
 * 群配了却永远匹配不上,还不报错。
 */
export function groupAddressOf(target: PushTarget): string | undefined {
	switch (target.platform) {
		case "onebot":
			return target.session.groupId;
		case "qq-official":
			return target.session.groupOpenid;
		default:
			return undefined;
	}
}

/** 群地址 → 该平台的 session。给「回到来源群」造临时目标用(见 groupAddressOf)。 */
export function groupSessionFor(
	platform: "onebot",
	groupId: string,
): z.infer<typeof OnebotSessionSchema>;
export function groupSessionFor(
	platform: "qq-official",
	groupId: string,
): z.infer<typeof QQOfficialSessionSchema>;
export function groupSessionFor(platform: "onebot" | "qq-official", groupId: string) {
	return platform === "onebot" ? { groupId } : { groupOpenid: groupId };
}
