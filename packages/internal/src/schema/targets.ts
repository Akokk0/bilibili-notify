import { z } from "zod";
import { neutralPlatformDescriptor } from "../platform-descriptor";
import {
	ONEBOT_FORWARD_MIN_TIMEOUT_MS,
	ONEBOT_IMAGE_MIN_TIMEOUT_MS,
	WEBHOOK_PLATFORMS,
} from "../platform-registry";
import {
	isPrivateTarget,
	PUSH_TARGET_KINDS,
	PUSH_TARGET_SCOPES,
	platformOfTarget,
} from "../push-target";
import { markBackupOnly, markSecret } from "./secret";

// 会话种类、目标形态、连接器这三个词表的本体在零依赖的 `push-target.ts` / `platform-registry.ts`
// —— 类型从那边导,别在这儿用 `z.infer` 再声明一份同义的联合(两份就会漂,而它们是同一件事)。

/**
 * 平台名 —— 开放词表,只要求非空。连接上的 `platform` 就是它(推送目标上没有平台这一格:
 * 平台一律经 `connectionId` 从连接取,见 {@link platformOfTarget})。
 *
 * 为什么这一侧是开的:桥(koishi / astrbot)把它自己接着的平台驮进来,那份清单是**运行时**
 * 才知道的(桥上装了 telegram 插件就有 telegram)。写成闭集等于「必须先改一次词表、发一版,
 * 主人才能收到 telegram 的推送」—— 而那条平台上一行我们自己的代码都不需要。
 *
 * 代价是拼错不再有人拦(`onebot` 写成 `oneboot` 照样存得下)。这个代价是认下的:连接本来就
 * 只由面板创建、平台名从挑中的 bot 上抄,不会手打;而闭集换来的那点保护,在桥接上之后会变成
 * 「合法的平台进不来」这种更贵的毛病。真要挡的是**能力**(能不能 @全体、收不收得到回复),
 * 那由能力位承载,不是平台名。
 */
export const OpenPlatformSchema = z.string().min(1);

export const PushTargetScopeSchema = z.enum(PUSH_TARGET_SCOPES);

/**
 * 推送目标的两支形态。
 *
 * - `session` —— 一个**会话**:群、私聊、子频道。有地址,能收到入站消息,人手配。
 * - `endpoint` —— 一个**单向出站终点**:地址烧在连接的 settings 里,目标本身只是个壳。
 *
 * 它眼下与连接的平台一一对应(webhook 那族 ⇔ endpoint),看着冗余 —— 但平台是开放词表
 * (桥驮来的平台枚举不了),按平台名比会全线恒假。判据放在这根轴上。目标自己不带平台:要知道
 * 平台,经 `connectionId` 问连接。
 */
export const PushTargetKindSchema = z.enum(PUSH_TARGET_KINDS);

/* -------------------------------------------------------------------------- */
/* Connection-level settings                                                  */
/* -------------------------------------------------------------------------- */

/**
 * OneBot 连接的三种连法(`transport`)共用的字段。
 * `transport` 是连接属性,只活在连接的 settings 里 —— PushTarget 不受影响。
 */
const onebotCommonSettingsShape = {
	accessToken: markSecret(z.string()).optional(),
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
	mergeForwardMinTimeoutMs: z.number().int().min(0).default(ONEBOT_FORWARD_MIN_TIMEOUT_MS),
	/** 失败时的重试次数（不含首次）。 */
	maxRetries: z.number().int().min(0).default(0),
	/** 两次重试之间的等待（毫秒）。 */
	retryIntervalMs: z.number().int().min(0).default(1_000),
} as const;

/** HTTP:独立端用 fetch POST 到 bot 的 OneBot HTTP API。 */
export const OnebotHttpSettingsSchema = z
	.object({
		transport: z.literal("http"),
		/** bot 的 OneBot HTTP API 根地址。 */
		baseUrl: markBackupOnly(z.url(), { url: true }),
		/** 附加到每次请求的 HTTP header（例如自定义鉴权头）。 */
		headers: z.record(z.string(), markBackupOnly(z.string())).default({}),
		...onebotCommonSettingsShape,
	})
	.strict();

/** 正向 WS:独立端作为 WS 客户端,主动连到 bot 的 WS 服务。 */
export const OnebotWsSettingsSchema = z
	.object({
		transport: z.literal("ws"),
		/** bot 的 OneBot 正向 WS 地址,必须 `ws://` 或 `wss://`。 */
		url: markBackupOnly(z.string().regex(/^wss?:\/\/\S+$/i, "必须是 ws:// 或 wss:// 地址"), {
			url: true,
		}),
		/** WS 握手请求头（例如自定义鉴权头）。 */
		headers: z.record(z.string(), markBackupOnly(z.string())).default({}),
		...onebotCommonSettingsShape,
	})
	.strict();

/** 反向 WS:独立端监听 `port`,bot 作为客户端主动连进来。端口即身份。 */
export const OnebotWsReverseSettingsSchema = z
	.object({
		transport: z.literal("ws-reverse"),
		/** 独立端为该连接开的 WS 监听端口；bot 连 `ws://<host>:<port>/`。 */
		port: z.number().int().min(1).max(65_535),
		...onebotCommonSettingsShape,
	})
	.strict();

/** OneBot 连接设置 —— 按 `transport` 区分 HTTP / 正向 WS / 反向 WS。 */
export const OnebotConnectionSettingsSchema = z.discriminatedUnion("transport", [
	OnebotHttpSettingsSchema,
	OnebotWsSettingsSchema,
	OnebotWsReverseSettingsSchema,
]);
export type OnebotConnectionSettings = z.infer<typeof OnebotConnectionSettingsSchema>;
export type OnebotTransport = OnebotConnectionSettings["transport"];

/** 词表本体在零依赖的 `platform-registry.ts`,`WebhookPlatform` 这个类型也从那边导 —— 别在这儿再声明一份。 */
export const WebhookPlatformSchema = z.enum(WEBHOOK_PLATFORMS);

/**
 * 出站 webhook 的连接设置。
 *
 * **这里没有 `provider`** —— 它升格成了 `platform`(见 {@link WEBHOOK_PLATFORMS})。
 * 老配置里那个字段由 `schema/migration.ts` 提上去并从 settings 里摘掉;这一层是非 strict
 * 的 z.object,所以万一漏了一条,strip 掉也不会让主人开不了机。
 */
export const WebhookConnectionSettingsSchema = z.object({
	url: markSecret(z.url(), { url: true }),
	secret: markSecret(z.string()).optional(),
	/** 自定义 header 例如 Authorization */
	headers: z.record(z.string(), markBackupOnly(z.string())).default({}),
});
export type WebhookConnectionSettings = z.infer<typeof WebhookConnectionSettingsSchema>;

/**
 * QQ 官方机器人公域/私域类型。私域可发原生 markdown,公域只能发模板 markdown ——
 * 决定 adapter 的 markdown 能力门控(私域默认开、公域默认关)。
 */
export const QQOfficialBotTypeSchema = z.enum(["public", "private"]);
export type QQOfficialBotType = z.infer<typeof QQOfficialBotTypeSchema>;

/**
 * QQ 官方机器人(q.qq.com,非 OneBot/NapCat)连接设置。
 * 鉴权 appId+appSecret → getAppAccessToken;`sandbox` 切沙箱/正式环境的 wss+REST host。
 */
export const QQOfficialConnectionSettingsSchema = z
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
		appSecret: markSecret(z.string()),
		sandbox: z.boolean().default(false),
		botType: QQOfficialBotTypeSchema.default("public"),
		/** 是否记录网关 RECONNECT/RESUMED 事件日志。QQ 官方网关每约 30 分钟主动要求
		 * 重连一次,属正常协议行为;默认关闭避免刷屏,排障时可开启。 */
		logReconnects: z.boolean().default(false),
	})
	.strict();
export type QQOfficialConnectionSettings = z.infer<typeof QQOfficialConnectionSettingsSchema>;

/* -------------------------------------------------------------------------- */
/* Connection — shell, platform snapshot, probe state                         */
/* -------------------------------------------------------------------------- */

/**
 * 连接上存的那份平台描述 —— {@link PlatformDescriptor} 去掉 `platform`。只有宿主写
 * (新建时从适配器的候选抄,认不出的填 {@link neutralPlatformSnapshot})。
 */
export const PlatformSnapshotSchema = z.object({
	label: z.string().min(1),
	shortLabel: z.string().min(1),
	color: z.string().min(1),
	icon: z.string().optional(),
	targetKind: PushTargetKindSchema,
	scopes: z.array(PushTargetScopeSchema),
	addressNouns: z.object({
		group: z.string().optional(),
		private: z.string().optional(),
		channel: z.string().optional(),
	}),
});
export type PlatformSnapshot = z.infer<typeof PlatformSnapshotSchema>;
/** 描述一个聊天平台(适配器的连接候选里带的那份)。 */
export type PlatformDescriptor = PlatformSnapshot & { platform: string };

/**
 * 认不出的平台用的中性快照:读盘时快照坏了、给没有候选口的适配器新建连接、迁移里拓展连接,
 * 用的是同一份(迁移里另有冻结副本,由测试钉相等)。
 */
export function neutralPlatformSnapshot(platform: string): PlatformSnapshot {
	// 取值只有一个家:`platform-descriptor.ts`(零依赖子路径,门转出的也是它)。
	const { platform: _platform, ...snapshot } = neutralPlatformDescriptor(platform);
	return snapshot;
}

export const CONNECTION_PROBE_STATUSES = ["reachable", "unreachable", "unsupported"] as const;

/** 连接探测状态。没有这一格 = 还没探过。只有宿主写。 */
export const ConnectionProbeStateSchema = z.object({
	status: z.enum(CONNECTION_PROBE_STATUSES),
	lastCheckedAt: z.string(),
	/** 只在 `reachable` 时有。 */
	latencyMs: z.number().optional(),
	/** 只在 `unreachable` 时有。 */
	message: z.string().optional(),
});
export type ConnectionProbeState = z.infer<typeof ConnectionProbeStateSchema>;

/** 目标的会话级可达性;只在通断翻转时写。 */
export const TargetReachabilitySchema = z.object({
	status: z.enum(["reachable", "unreachable"]),
	changedAt: z.string(),
	latencyMs: z.number().optional(),
	message: z.string().optional(),
});
export type TargetReachability = z.infer<typeof TargetReachabilitySchema>;

const ConnectionShellShape = {
	id: z.uuid(),
	name: z.string().min(1),
	enabled: z.boolean(),
	/** 哪个适配器负责它 —— 登记表里的适配器键(内置三个,或拓展 id)。 */
	adapterKey: z.string().min(1),
	/** 这个 bot 在哪个平台上 —— 开放词表,同 {@link OpenPlatformSchema}。 */
	platform: OpenPlatformSchema,
} as const;

/** 外壳:坏了才挡开机(SV 规矩 9)。`settings` 归适配器,不在这里。 */
export const ConnectionShellSchema = z.object(ConnectionShellShape);

/**
 * Connection — 一条"连接实例"。一个借来的 / 自己连的 bot,被多个 PushTarget 复用。
 *
 * `settings` 的形状归适配器的 `settingsSchema`,核心不认识任何一个适配器的设置。
 * `platformSnapshot` 与 `probeState` 只有宿主写。
 */
export const ConnectionSchema = z.object({
	...ConnectionShellShape,
	settings: z.unknown(),
	platformSnapshot: PlatformSnapshotSchema,
	probeState: ConnectionProbeStateSchema.optional(),
});
export type Connection = z.infer<typeof ConnectionSchema>;

/** POST /api/connections 收的那一份:宿主独写的两格(`platformSnapshot`、`probeState`)不在里面。 */
export const NewConnectionSchema = z.object({
	...ConnectionShellShape,
	settings: z.unknown(),
});
export type NewConnection = z.infer<typeof NewConnectionSchema>;

/* -------------------------------------------------------------------------- */
/* Target (session-level) — references a connection                           */
/* -------------------------------------------------------------------------- */

const PushTargetCommonShape = {
	id: z.uuid(),
	name: z.string().min(1),
	connectionId: z.uuid(),
	enabled: z.boolean(),
	/** 生命周期由所属连接管理的系统目标；用户不直接编辑 / 删除。 */
	managedBy: z.literal("connection").optional(),
	/**
	 * 最近一次显式 `POST /api/targets/:id/test` 或真实业务推送的通断翻转。
	 * 跟 Connection.probeState 互相独立 — 此处只反映会话级 (group/userId) 是否可达,
	 * 连接级状态在 Connection.probeState。
	 */
	reachability: TargetReachabilitySchema.optional(),
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
	/** 会话的种类(群 / 私聊 / 频道)。端点目标没有这一格:它只是个壳,没有会话可分。 */
	scope: PushTargetScopeSchema,
	address: z.string(),
	/**
	 * 上一级容器的地址。今天只有官机的频道用得上(`guildId`:子频道挂在频道服务器下)。
	 *
	 * 留着这一格不是为了官机 —— 是 Telegram 那种**论坛话题**:话题 id 是每个超级群自己
	 * 一套的小整数,只存话题 id 的话,两个不同群里的同号话题会折成同一个地址。
	 */
	parentAddress: z.string().optional(),
	// 这里**没有 `botId`**:一条连接就是一个 bot,连接 id 已经说全了 —— 对拓展连接也一样
	// (ADR-0012 决策 45)。它曾经为「一条桥连接驮好几个 bot」留过一格,那件事现在住在
	// 连接那一层。
} as const;

/**
 * 两支目标 —— 判别子是 {@link PushTargetKindSchema} 的 `kind`,**不是 platform**。
 *
 * 曾经是按 platform 判别的:onebot / webhook / qq-official 三支,各带一份自己的 session
 * schema。地址收成一格之后两支会话目标的形状**一模一样**,而平台又是开放词表 —— zod 的
 * discriminatedUnion 要求判别键取值可枚举,继续按 platform 判别会在**第一次 parse 时**抛
 * `Invalid discriminated union option`:门禁全绿,炸在开机读配置那一刻。现在目标上根本没有
 * 平台这一格(平台在连接上);盘上 / 请求体里遗留的 `platform` 与端点目标的 `scope` 被静默剥掉,
 * 不拒收(这个 schema 不是 strict)。
 */
const SessionPushTargetSchema = z.object({
	...PushTargetCommonShape,
	...PushTargetSessionShape,
});

const EndpointPushTargetSchema = z.object({
	...PushTargetCommonShape,
	kind: z.literal("endpoint"),
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
 * 一个会话的两坐标 —— 范围 + 地址,取自会话目标自己的类型(`Pick`),不另抄一份声明。
 *
 * 不经推送目标表、直接往某个会话回话的口子用它(链接解析回到来源群):用哪条连接由调用方另给,
 * 这里只说「连接上的哪个会话」。
 */
export type SessionRef = Pick<
	Extract<PushTarget, { kind: "session" }>,
	"scope" | "address" | "parentAddress"
>;

/** 端点目标的「发到哪」—— webhook 写进冻结 JSON 的正是这三格。 */
export type EndpointRef = Pick<Extract<PushTarget, { kind: "endpoint" }>, "id" | "name">;

/**
 * 适配器发送口收的「发到哪」—— 推送目标里**发送要用的那几格**,按 `kind` 分两支。
 * 开关、所属连接、平台这些不在其中:那些检查只在派发器做一份(ADR-0024 决策 13)。
 */
export type DestinationRef =
	| Pick<Extract<PushTarget, { kind: "session" }>, "kind" | keyof SessionRef>
	| Pick<Extract<PushTarget, { kind: "endpoint" }>, "kind" | keyof EndpointRef>;

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
 * 「谁」的两坐标 —— 平台 + 地址。
 *
 * 主人身份以前塌成一个裸字符串,比对就是字符串相等。`onebot` 的 QQ 号与官机的 C2C
 * openid 是**两个命名空间**,撞上就等于认错人 —— 代码注释一直这么写着,却从来没有
 * 东西校验过它。**没有 bot 那一格**:同一个平台上同一个地址就是同一个人,两个 bot 各看
 * 见他一次也还是他(一条连接就是一个 bot,ADR-0012 决策 45)。
 */
export interface ChatIdentity {
	platform: string;
	/** 这个人在该平台上的地址:OneBot 是 QQ 号,官机是 C2C openid。 */
	address: string;
}

/**
 * 主人那个私聊目标的两坐标;平台取自它挂着的连接。不是私聊会话、连接不在了都没有 ——
 * 群目标的 `address` 是群,拿它当主人身份等于把整个群当成主人。
 */
export function chatIdentityOf(
	target: PushTarget | undefined,
	connections: readonly Pick<Connection, "id" | "platform">[],
): ChatIdentity | undefined {
	if (!isPrivateTarget(target) || !target.address) return undefined;
	// 平台取自它挂着的连接;连接不在了就没有身份,同「不是私聊 / 没有地址」。
	const platform = platformOfTarget(target, connections);
	if (platform === undefined) return undefined;
	return { platform, address: target.address };
}

/**
 * 两个坐标是不是同一个人。平台与地址都必须给且相等 —— 少一格就不认,而不是当通配。
 */
export function sameChatIdentity(
	a: ChatIdentity | undefined,
	b: ChatIdentity | undefined,
): boolean {
	if (!a || !b) return false;
	if (!a.platform || !a.address) return false;
	return a.platform === b.platform && a.address === b.address;
}
