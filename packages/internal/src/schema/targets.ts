import { z } from "zod";
import {
	CONNECTION_PLATFORMS,
	type ConnectionPlatform,
	DIRECT_CONNECTORS,
	ONEBOT_FORWARD_MIN_TIMEOUT_MS,
	ONEBOT_IMAGE_MIN_TIMEOUT_MS,
	PUSH_TARGET_KINDS,
	PUSH_TARGET_SCOPES,
	WEBHOOK_PLATFORMS,
} from "../constants.js";
import { ExtensionIdSchema } from "./extension-manifest.js";

// 会话种类、目标形态、连接器这三个词表的本体都在零依赖的 constants —— 类型从那边导,
// 别在这儿用 `z.infer` 再声明一份同义的联合(两份就会漂,而它们是同一件事)。
export type { DirectConnector, PushTargetKind, PushTargetScope } from "../constants.js";

/**
 * **连接**能连的平台 —— 闭集。Adapter 矩阵按它分发(server 侧 `apps/server/src/platforms/`)。
 * 加一档要配齐:constants 的 {@link CONNECTION_PLATFORMS} 加个名字 + 一份 config schema +
 * 一个 server adapter + 一排面板控件。词表住零依赖的 constants 是为了前端也拿得到。
 * - `onebot`:OneBot v11(HTTP / 正向 WS / 反向 WS)
 * - `qq-official`:QQ 官方机器人(q.qq.com)WS 网关,频道/群/C2C
 * - `feishu` / `dingtalk` / `wecom` / `generic`:走出站 webhook 那一族(见
 *   {@link WEBHOOK_PLATFORMS})。它们**不是**四个 adapter,是同一个 adapter 的四种
 *   报文方言 —— 「怎么连」由 `connector` 说了算,这里只说「连到哪」。
 *
 * **推送目标那一格不用这个**,见 {@link TargetPlatformSchema}。
 */
export const ConnectionPlatformSchema = z.enum(CONNECTION_PLATFORMS);

/**
 * **推送目标**的平台 —— 开放词表,只要求非空。
 *
 * 为什么这一侧是开的:桥(koishi / astrbot)把它自己接着的平台驮进来,那份清单是**运行时**
 * 才知道的(桥上装了 telegram 插件就有 telegram)。写成闭集等于「必须先改一次词表、发一版,
 * 主人才能收到 telegram 的推送」—— 而那条平台上一行我们自己的代码都不需要。
 *
 * 代价是拼错不再有人拦(`onebot` 写成 `oneboot` 照样存得下)。这个代价是认下的:目标本来就
 * 只由面板与桥两条路创建,两条都不会手打平台名;而闭集换来的那点保护,在桥接上之后会变成
 * 「合法的平台进不来」这种更贵的毛病。真要挡的是**能力**(能不能 @全体、收不收得到回复),
 * 那由能力位承载,不是平台名。
 */
export const TargetPlatformSchema = z.string().min(1);

export const PushTargetScopeSchema = z.enum(PUSH_TARGET_SCOPES);

/* -------------------------------------------------------------------------- */
/* Connection-level configs                                                   */
/* -------------------------------------------------------------------------- */

/**
 * OneBot 连接的三种连法(`transport`)共用的字段。
 * `transport` 是连接属性,只活在连接的 config 里 —— PushTarget 不受影响。
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
		/** 独立端为该连接开的 WS 监听端口；bot 连 `ws://<host>:<port>/`。 */
		port: z.number().int().min(1).max(65_535),
		...onebotCommonConfigShape,
	})
	.strict();

/**
 * OneBot 连接配置 —— 按 `transport` 区分 HTTP / 正向 WS / 反向 WS。
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
 * QQ 官方机器人(q.qq.com,非 OneBot/NapCat)连接配置。
 * 鉴权 appId+appSecret → getAppAccessToken;`sandbox` 切沙箱/正式环境的 wss+REST host。
 */
export const QQOfficialConnectionConfigSchema = z
	.object({
		appId: z.string().min(1),
		/**
		 * 空串 = 尚未配置密钥,**合法可存**(与 onebot 的 `accessToken`、webhook 的
		 * `secret` 建模一致)。这里曾经是 `.min(1)`,结果脱敏备份把 appSecret 抹成空串
		 * 后就再也存不回去 —— 恢复直接 ConfigValidationError(scope=connections)。
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

/**
 * Connection — 一条"连接实例"。
 *
 * 类比一个 bot 实例:一份 baseUrl/accessToken 一次配置,被多个 PushTarget
 * (实际的群/私聊/dashboard 会话) 复用。
 *
 * 两根正交的轴:`platform`(连到哪)与 `connector`(怎么连)。`kind` 是**判别子**:
 * - `direct` —— 我们自己说协议,连接就是一个平台,`platform` 必填;
 * - `bridge` —— 桥(koishi / astrbot 里的插件)主动连过来,把它宿主里的 bot 借给我们。
 *   **这一支没有 `platform`**:桥后面挂着哪些平台是它握手时报的,是运行时知识。
 *
 * **老数据没有 `kind` / `connector`**,由 `schema/migration.ts` 的一次性迁移补上;
 * 这里刻意不给 default,好让「没迁移过的数据」在 parse 阶段就响,而不是被默认值糊过去。
 */
const ConnectionIdentityShape = {
	id: z.uuid(),
	name: z.string().min(1),
	enabled: z.boolean(),
	testStatus: ConnectionTestStatusSchema.optional(),
} as const;

const ConnectionCommonShape = {
	...ConnectionIdentityShape,
	kind: z.literal("direct"),
	connector: DirectConnectorSchema,
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

/**
 * 桥接入的连接配置。
 *
 * **桥主动连我们**,不是我们连桥:面板生成一个长期 token,插件那头填「BN 地址 + token」。
 * 所以这里没有地址 —— 地址在桥那边。重连退避也归插件。
 */
export const BridgeConnectionConfigSchema = z.object({
	/**
	 * 长期 token,桥握手时出示。
	 *
	 * 空串**合法可存**:与 onebot 的 `accessToken`、官机的 `appSecret` 同一套建模 ——
	 * 脱敏备份会把它抹成空串,存不回去就等于备份恢复不了(官机那格栽过一次)。
	 * 「没 token 不许连」是**连接期**的约束,不是存储期的。
	 */
	token: z.string(),
	/**
	 * 哪一种桥。**只影响面板怎么说**(装插件的指引、卡片上的名字)——BN 侧对两种桥的
	 * 处理完全相同,所以它住 config 而不是长成 `connector` 的第二档:两个桥说同一套协议,
	 * 分两档就是两份几乎一样的 schema branch,而且每来一个新桥都要改核心词表发一次版。
	 */
	bridgeKind: z.enum(["koishi", "astrbot"]),
});
export type BridgeConnectionConfig = z.infer<typeof BridgeConnectionConfigSchema>;

/**
 * 拓展提供的连接(ADR-0012 决策 27)。三格刻意都没有:
 *
 * - **没有 `platform`** —— 拓展不一定就是一个平台。桥后面挂着哪些平台(telegram /
 *   discord / …)是它握手时报的,是运行时知识,枚举不了;塞一个可选的只会让全仓读点静默
 *   变 `undefined`。少那一格,读它的地方就**编译不过** —— 那份编译错清单正是「哪些地方
 *   假定了连接就是一个平台」。平台信息住在**推送目标**那一侧(那边本来就是开放词表)。
 * - **没有 `connector`** —— 全仓读它的地方无一例外在问「是不是 webhook」(见
 *   {@link isWebhookConnection})。给这一支塞一格,唯一作用是让那些读点编译得过。
 * - **config 不由核心定形状** —— 归拓展自己那份 zod(决策 19)。核心只保证它是个对象。
 *   ⚠️ 在加载期对表做出来之前,**消费方自己 parse**(桥就是这么读 `token` 的):核心的
 *   schema 不该认识任何一个拓展 id。
 *
 * 判别子仍是 `kind`,不拿 `extensionId` 直接当 `kind` —— 那样判别键不可枚举,
 * `discriminatedUnion` 第一次 parse 就抛。
 */
const ExtensionConnectionSchema = z.object({
	...ConnectionIdentityShape,
	kind: z.literal("extension"),
	/** 哪个拓展负责它 —— **同时就是分发键**(由宿主填,拓展不自报,见决策 28)。 */
	extensionId: ExtensionIdSchema,
	config: z.unknown(),
});

const DirectConnectionSchema = z
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

/**
 * 一条连接 —— 判别子是 `kind`。
 *
 * zod 4 认嵌套的判别联合,所以直连那侧仍按 `platform` 逐支收窄(config 跟着 narrow),
 * 外面再按 `kind` 分岔;两层各自的错误消息都还是精确的那一条,不会退化成一大坨
 * union 错误。
 */
export const ConnectionSchema = z.discriminatedUnion("kind", [
	DirectConnectionSchema,
	ExtensionConnectionSchema,
]);
export type Connection = z.infer<typeof ConnectionSchema>;

/** 直连那一支 —— 有 `platform`、由我们自己说协议。 */
export type DirectConnection = z.infer<typeof DirectConnectionSchema>;
/** 拓展那一支 —— 没有 `platform`,config 归拓展自己校验。 */
export type ExtensionConnection = z.infer<typeof ExtensionConnectionSchema>;

/**
 * 这条连接是不是 webhook 那种**单向投递**。
 *
 * 从前全仓 20 处写的是 `connection.connector === "webhook"` —— 那是把一个字段当接口用:
 * 拓展那一支没有 `connector`,于是每一处都要先想一遍「它有没有这一格」。问题本来就只有
 * 一个,答案也只有一份,所以收成这一句。
 */
export function isWebhookConnection(connection: Connection): connection is WebhookConnection {
	return connection.kind === "direct" && connection.connector === "webhook";
}

/** webhook 那一档直连 —— 单向投递,没有会话。 */
export type WebhookConnection = Extract<DirectConnection, { connector: "webhook" }>;

/**
 * 这条连接归不归某个拓展 —— 不给 id 就是问「是不是拓展提供的」。
 *
 * ctx 交给拓展的那份快照就是拿它筛的(决策 30):**归属是宿主的判断**,所以筛这一步
 * 只有一份实现。
 */
export function isExtensionConnection(
	connection: Connection,
	extensionId?: string,
): connection is ExtensionConnection {
	if (connection.kind !== "extension") return false;
	return extensionId === undefined || connection.extensionId === extensionId;
}

/**
 * 这条连接自己就是一个平台吗 —— 是的话把平台名交出来。
 *
 * 读点写 `connection.platform` 的地方**大多真正想问的是这个**:桥接入没有单一平台,
 * 该走的是「问桥报了哪些」那条路。留这个谓词是为了让那些地方显式说出「认不出就没有」,
 * 而不是靠一个可选字段悄悄变 `undefined`。
 */
export function isDirectConnection(connection: Connection): connection is DirectConnection {
	return connection.kind === "direct";
}

/**
 * 这条连接是不是**这个平台的直连**。
 *
 * 三个 adapter 开头那句「不是我的就退回去」都问这个。桥接入恒 false —— 它没有单一平台,
 * 该由桥那套实现处理。narrow 之后 `connection.config` 也跟着收窄到那一档的形状。
 */
export function isConnectionOn<P extends ConnectionPlatform>(
	connection: Connection,
	platform: P,
): connection is Extract<DirectConnection, { platform: P }> {
	return connection.kind === "direct" && connection.platform === platform;
}

/* -------------------------------------------------------------------------- */
/* Target (session-level) — references a connection                           */
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
export const PushTargetKindSchema = z.enum(PUSH_TARGET_KINDS);

const PushTargetCommonShape = {
	id: z.uuid(),
	name: z.string().min(1),
	connectionId: z.uuid(),
	scope: PushTargetScopeSchema,
	enabled: z.boolean(),
	/** 生命周期由所属连接管理的系统目标；用户不直接编辑 / 删除。 */
	managedBy: z.literal("connection").optional(),
	/**
	 * 最近一次显式 `/api/push/test` 或真实业务推送的结果。
	 * 跟 Connection.testStatus 互相独立 — 此处只反映会话级 (group/userId) 是否可达,
	 * 连接级状态在 Connection.testStatus。
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
	/**
	 * 收到 / 发出这个会话的消息的那个 bot 自己的号。
	 *
	 * 直连没有:一条连接就是一个 bot,连接 id 已经说全了。桥不一样 —— 一条桥连接后面
	 * 可能挂着好几个 bot,同一个群地址在两个 bot 眼里是两个会话。
	 */
	botId: z.string().optional(),
} as const;

/**
 * 两支目标 —— 判别子是 {@link PushTargetKindSchema} 的 `kind`,**不是 platform**。
 *
 * 曾经是按 platform 判别的:onebot / webhook / qq-official 三支,各带一份自己的 session
 * schema。地址收成一格之后两支会话目标的形状**一模一样**,而 `target.platform` 又开放了
 * —— zod 的 discriminatedUnion 要求判别键取值可枚举,继续按 platform 判别会在**第一次
 * parse 时**抛 `Invalid discriminated union option`:门禁全绿,炸在开机读配置那一刻。
 */
const SessionPushTargetSchema = z.object({
	...PushTargetCommonShape,
	...PushTargetSessionShape,
	platform: TargetPlatformSchema,
});

const EndpointPushTargetSchema = z.object({
	...PushTargetCommonShape,
	kind: z.literal("endpoint"),
	platform: TargetPlatformSchema,
});

export const PushTargetSchema = z
	.discriminatedUnion("kind", [SessionPushTargetSchema, EndpointPushTargetSchema])
	.superRefine((target, ctx) => {
		if (target.managedBy === "connection" && target.kind !== "endpoint") {
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

/**
 * 「谁」的三坐标 —— 平台 + 地址(+ 是哪个 bot 看到的)。
 *
 * 主人身份以前塌成一个裸字符串,比对就是字符串相等。`onebot` 的 QQ 号与官机的 C2C
 * openid 是**两个命名空间**,撞上就等于认错人 —— 代码注释一直这么写着,却从来没有
 * 东西校验过它:那时「一条连接只驮一个平台」这个前提替它兜着,而这个前提正在被拆掉。
 */
export interface ChatIdentity {
	platform: string;
	/** 这个人在该平台上的地址:OneBot 是 QQ 号,官机是 C2C openid。 */
	address: string;
	/** 见 PushTarget 的 `botId`;直连没有。 */
	botId?: string;
}

/**
 * 主人那个私聊目标的三坐标。不是私聊会话就没有 ——
 * 群目标的 `address` 是群,拿它当主人身份等于把整个群当成主人。
 */
export function chatIdentityOf(target: PushTarget | undefined): ChatIdentity | undefined {
	if (target?.kind !== "session" || target.scope !== "private" || !target.address) return undefined;
	return { platform: target.platform, address: target.address, botId: target.botId };
}

/**
 * 两个坐标是不是同一个人。
 *
 * `botId` 只在**两边都有**时参与比对:直连这一格永远是空的,要求它相等等于谁都不认。
 * 平台与地址则都必须给且相等 —— 少一格就不认,而不是当通配。
 */
export function sameChatIdentity(
	a: ChatIdentity | undefined,
	b: ChatIdentity | undefined,
): boolean {
	if (!a || !b) return false;
	if (!a.platform || !a.address) return false;
	if (a.platform !== b.platform || a.address !== b.address) return false;
	return !a.botId || !b.botId || a.botId === b.botId;
}
