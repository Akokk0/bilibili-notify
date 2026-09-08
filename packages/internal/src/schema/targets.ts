import { z } from "zod";
import {
	DIRECT_CONNECTORS,
	ONEBOT_FORWARD_MIN_TIMEOUT_MS,
	ONEBOT_IMAGE_MIN_TIMEOUT_MS,
	PUSH_TARGET_PLATFORMS,
	WEBHOOK_PLATFORMS,
} from "../constants.js";

/**
 * Push 目标平台。Adapter 矩阵按 platform 分发(server 侧 `apps/server/src/platforms/`
 * 一平台一实现)—— 这条 union 就是将来薄插件把 Koishi / AstrBot 桥接进来时的接入点:
 * 往 constants 的 `PUSH_TARGET_PLATFORMS` 加一个平台名 + 一套 adapter/session schema +
 * 一个 server adapter。词表住零依赖的 constants 是为了前端也拿得到(平台能力判断在那边)。
 * - `onebot`:OneBot v11 HTTP adapter
 * - `qq-official`:QQ 官方机器人(q.qq.com)WS 网关 adapter,频道/群/C2C
 * - `feishu` / `dingtalk` / `wecom` / `generic`:走出站 webhook 那一族(见
 *   {@link WEBHOOK_PLATFORMS})。它们**不是**四个 adapter,是同一个 adapter 的四种
 *   报文方言 —— 「怎么连」由 `connector` 说了算,这里只说「连到哪」。
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
export const OnebotConnectionConfigSchema = z.union([
	OnebotHttpConfigSchema,
	OnebotWsConfigSchema,
	OnebotWsReverseConfigSchema,
]);
export type OnebotConnectionConfig = z.infer<typeof OnebotConnectionConfigSchema>;
export type OnebotTransport = OnebotConnectionConfig["transport"];

/** 词表本体在零依赖的 constants,`WebhookPlatform` 这个类型也从那边导 —— 别在这儿再声明一份。 */
export const WebhookPlatformSchema = z.enum(WEBHOOK_PLATFORMS);

/**
 * 出站 webhook 的连接配置。
 *
 * **这里没有 `provider`** —— 它升格成了 `platform`(见 {@link WEBHOOK_PLATFORMS})。
 * 老配置里那个字段由 `schema/migration.ts` 提上去并从 config 里摘掉;这一层是非 strict
 * 的 z.object,所以万一漏了一条,strip 掉也不会让主人开不了机。
 */
export const WebhookConnectionConfigSchema = z.object({
	url: z.url(),
	secret: z.string().optional(),
	/** 自定义 header 例如 Authorization */
	headers: z.record(z.string(), z.string()).default({}),
});
export type WebhookConnectionConfig = z.infer<typeof WebhookConnectionConfigSchema>;

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
export const QQOfficialConnectionConfigSchema = z
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
export type QQOfficialConnectionConfig = z.infer<typeof QQOfficialConnectionConfigSchema>;

export const ConnectionTestStatusSchema = z.object({
	ok: z.boolean(),
	lastCheckedAt: z.string(),
	latencyMs: z.number().optional(),
	err: z.string().optional(),
});
export type ConnectionTestStatus = z.infer<typeof ConnectionTestStatusSchema>;

/** 直连连接器 —— 「怎么连」。词表与理由见 constants 的 {@link DIRECT_CONNECTORS}。 */
export const DirectConnectorSchema = z.enum(DIRECT_CONNECTORS);
export type DirectConnector = z.infer<typeof DirectConnectorSchema>;

/**
 * Connection — 平台级的"连接实例"。
 *
 * 类比一个 bot 实例:一份 baseUrl/accessToken 一次配置,被多个 PushTarget
 * (实际的群/私聊/dashboard 会话) 复用。
 *
 * 两根正交的轴:`platform`(连到哪)与 `connector`(怎么连)。`kind` 是将来接桥时的
 * 判别子 —— 桥那一支没有 platform(平台靠探测),今天只有 `direct` 一档。
 * **老数据没有这两个字段**,由 `schema/migration.ts` 的一次性迁移补上;这里刻意不给
 * default,好让「没迁移过的数据」在 parse 阶段就响,而不是被默认值糊过去。
 */
const ConnectionCommonShape = {
	id: z.uuid(),
	name: z.string().min(1),
	enabled: z.boolean(),
	kind: z.literal("direct"),
	connector: DirectConnectorSchema,
	testStatus: ConnectionTestStatusSchema.optional(),
} as const;

// 每一支把 `connector` 收窄到自己**真走得通**的那几档。收窄不只是为了拦住乱写的配置:
// 收窄之后 `connection.connector === "webhook"` 才是个判别式,TS 能顺着它把 config
// narrow 到对应形状 —— 否则每处都得改判 platform,「怎么连」这根轴白提了。
const OnebotConnectionSchema = z.object({
	...ConnectionCommonShape,
	connector: z.enum(["http", "ws", "ws-reverse"]),
	platform: z.literal("onebot"),
	config: OnebotConnectionConfigSchema,
});

const WebhookConnectionSchema = z.object({
	...ConnectionCommonShape,
	connector: z.literal("webhook"),
	platform: WebhookPlatformSchema,
	config: WebhookConnectionConfigSchema,
});

const QQOfficialConnectionSchema = z.object({
	...ConnectionCommonShape,
	// 官机只有 WS 网关一条路。
	connector: z.literal("ws"),
	platform: z.literal("qq-official"),
	config: QQOfficialConnectionConfigSchema,
});

export const ConnectionSchema = z
	.discriminatedUnion("platform", [
		OnebotConnectionSchema,
		WebhookConnectionSchema,
		QQOfficialConnectionSchema,
	])
	.superRefine((connection, ctx) => {
		// `connector` 与 OneBot 的 `config.transport` 在这一版是**同一件事的两份**
		// (前者是新轴,后者是它今天的住处)。两份就会漂,所以这里把它钉死:漂了当场
		// 报错,而不是让面板显示 ws、实际按 http 连。`config.transport` 那份会在
		// 收口那步删掉,到时这条 refine 一并退休。
		if (connection.platform === "onebot" && connection.connector !== connection.config.transport) {
			ctx.addIssue({
				code: "custom",
				path: ["connector"],
				message: `connector ${connection.connector} does not match config.transport ${connection.config.transport}`,
			});
		}
	});
export type Connection = z.infer<typeof ConnectionSchema>;

/* -------------------------------------------------------------------------- */
/* Target (session-level) — references an adapter                             */
/* -------------------------------------------------------------------------- */

/**
 * 推送目标的两支形态。
 *
 * - `session` —— 一个**会话**:群、私聊、子频道。有地址,能收到入站消息,人手配。
 * - `endpoint` —— 一个**单向出站终点**:地址烧在连接的 config 里,目标本身只是个壳。
 *
 * 它眼下与 `platform` 一一对应(webhook 那族 ⇔ endpoint),看着冗余 —— 但 `target.platform`
 * 将来要开放(桥驮来的平台枚举不了),那之后按平台名比会全线恒假。判据先搬到这根轴上。
 */
export const PushTargetKindSchema = z.enum(["session", "endpoint"]);
export type PushTargetKind = z.infer<typeof PushTargetKindSchema>;

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
	 * 跟 Connection.testStatus 互相独立 — 此处只反映会话级 (group/userId) 是否可达,
	 * adapter 连接级状态在 Connection.testStatus。
	 */
	testStatus: ConnectionTestStatusSchema.optional(),
} as const;

/**
 * 会话目标的**地址**。
 *
 * 这一格原先是每个平台一套 `session` 对象:OneBot 的 `{groupId?, userId?}`、官机的
 * `{guildId?, channelId?, groupOpenid?, userOpenid?}`。四个可选字段配一个 `scope`,
 * 于是「scope 说 group、填的却是 userId」这种状态在类型上完全合法,只能在发送时才发现。
 *
 * 收成一格之后那一整类状态不存在了:**scope 说是哪种会话,address 就是那个会话的地址**。
 * OneBot 是群号 / QQ 号,官机是群 openid / 用户 openid / 子频道 id,将来接进来的平台
 * 自然也只需要填这一格 —— 不用再为它抄一份 session schema。
 *
 * 它是**必填键**(可以是空串:目标先建后填是正常用法),空不空的检查留在发送那一刻 ——
 * 那里本来就要检查,而在保存期拒绝会让「先建个壳、回头再填群号」这种用法做不到。
 */
const PushTargetSessionShape = {
	kind: z.literal("session"),
	address: z.string(),
	/**
	 * 上一级容器的地址。今天只有官机的频道用得上(`guildId`:子频道挂在频道服务器下)。
	 *
	 * 留着这一格不是为了官机 —— 是 Telegram 那种**论坛话题**:话题 id 是每个超级群自己
	 * 一套的小整数,只存话题 id 的话,两个不同群里的同号话题会折成同一个地址。
	 */
	parentAddress: z.string().optional(),
} as const;

const OnebotPushTargetSchema = z.object({
	...PushTargetCommonShape,
	...PushTargetSessionShape,
	platform: z.literal("onebot"),
});

const WebhookPushTargetSchema = z.object({
	...PushTargetCommonShape,
	kind: z.literal("endpoint"),
	platform: WebhookPlatformSchema,
});

const QQOfficialPushTargetSchema = z.object({
	...PushTargetCommonShape,
	...PushTargetSessionShape,
	platform: z.literal("qq-official"),
});

export const PushTargetSchema = z
	.discriminatedUnion("platform", [
		OnebotPushTargetSchema,
		WebhookPushTargetSchema,
		QQOfficialPushTargetSchema,
	])
	.superRefine((target, ctx) => {
		if (target.managedBy === "adapter" && target.kind !== "endpoint") {
			ctx.addIssue({
				code: "custom",
				path: ["managedBy"],
				message: "managedBy is only supported for endpoint targets",
			});
		}
	});
export type PushTarget = z.infer<typeof PushTargetSchema>;

/**
 * 群目标的「群地址」—— 与入站帧里的 `groupId` 是同一个值(OneBot 是群号,官机是群
 * openid)。
 *
 * 它以前是一对反函数里的一头:另一头 `groupSessionFor` 按平台造 session。两头各写一个
 * switch,新平台在一处落进 default、另一处被列出来,群配了却永远匹配不上还不报错 ——
 * `group-address.test.ts` 就是为这件事写的。地址收成一格之后**那对函数塌成了取一个字段**,
 * 反函数没有了,失配也就无从发生。
 *
 * 剩下的判断只有一句:`scope` 说它是群,`address` 才是群地址。私聊目标的 address 是
 * 那个人的 id,不是群。
 */
export function groupAddressOf(target: PushTarget): string | undefined {
	if (target.kind !== "session" || target.scope !== "group") return undefined;
	return target.address || undefined;
}
