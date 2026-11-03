/**
 * 独立端 Dashboard 的域类型门面(原「手维护镜像」,已退役)。
 *
 * 类型的单一来源:域模型在 `@bilibili-notify/internal`(全部 `import type`,
 * 编译后擦除,web 产物不含核心代码);wire DTO 在 `@bilibili-notify/contract`。
 * 值级常量(FEATURE_KEYS / DEFAULT_FEATURE_FLAGS)从 internal 的各领域零依赖子路径
 * 运行时导入 —— 这些模块不含 zod,bundle
 * 零增量。本文件自留的只剩 UI 文案、工厂函数与表单辅助。
 *
 * 旧镜像时代的 `*Full` / `*Override` 命名以别名保留,消费者无需改动:
 * `XxxFull` = internal 的全量类型,`XxxOverride` = internal 的 `XxxPartial`
 * (messageLayout 例外:per-UP 是「整份覆盖」,Override = 全量)。
 */

import type {
	ConnectionCandidatesResponse,
	SubscriptionDTO,
	SubscriptionTag,
} from "@bilibili-notify/contract";
import type { Connection, NewConnection, PushTarget } from "@bilibili-notify/internal";
import { DEFAULT_ROAST_SCHEDULE } from "@bilibili-notify/internal/ai";
import {
	DEFAULT_FEATURE_FLAGS,
	EXTRA_KEYS,
	type ExtraKey,
	FEATURE_KEYS,
	type FeatureFlagValues,
	type FeatureKey,
	PUSH_EXTRAS,
} from "@bilibili-notify/internal/features";
import { countsAsDelivery, countsAsFailure } from "@bilibili-notify/internal/history";
import {
	type Identity,
	identityColor,
	type SourceKey,
	sameIdentity,
	subscriptionIdentityOf,
} from "@bilibili-notify/internal/identity";

import { isTargetPaused, platformOfTarget } from "@bilibili-notify/internal/push-target";

export type { ExtraKey, FeatureFlagValues, FeatureKey, Identity, SourceKey, SubscriptionTag };
export {
	countsAsDelivery,
	countsAsFailure,
	DEFAULT_FEATURE_FLAGS,
	EXTRA_KEYS,
	FEATURE_KEYS,
	identityColor,
	isTargetPaused,
	PUSH_EXTRAS,
	platformOfTarget,
	sameIdentity,
	subscriptionIdentityOf,
};

/**
 * Dashboard 消费的订阅一直是 wire DTO 形状(internal Subscription + 服务端
 * join 回来的 cachedProfile / problems),沿用旧名 Subscription。
 *
 * 订阅只有一种形状(ADR-0021 决策 14、15):「这条订阅订的是谁」一律读
 * `subscriptionIdentityOf(sub)` 的身份(`sourceKey` + `externalId`);`specialViewers` 是公共的,
 * `problems` 必带(挂在这条订阅上的问题,没有就是空数组;没关注 UP 也在里面,`code: "follow_failed"`)。
 */
export type Subscription = SubscriptionDTO;

export type {
	AIOverride,
	// 推送平台类型直接用 internal 的定义:将来薄插件桥接进来的平台加进那条 union 就自动出现在这里。
	Connection,
	ContentFiltersPartial as ContentFiltersOverride,
	ImageGroupSettingsPartial as ImageGroupOverride,
	LiveStartSettingsPartial as LiveStartOverride,
	LiveStreamingSettingsPartial as LiveStreamingOverride,
	MembershipSettingsPartial as MembershipOverride,
	MessageBlock as MessageBlockFull,
	MessageKindLayout as MessageKindLayoutFull,
	// per-UP 消息版式是「整份覆盖」(fork 全局后编辑),不是 Partial。
	MessageLayout as MessageLayoutOverride,
	NewConnection,
	PushTarget,
	PushTargetScope,
	ScheduleConfigPartial as ScheduleOverride,
	SpecialViewer,
	SubscriptionOverrides as OverridesShape,
	SubscriptionRouting,
	SuperchatSettingsPartial as SuperchatOverride,
	TemplateBundlePartial as TemplateOverride,
} from "@bilibili-notify/internal";

// ---- Factories --------------------------------------------------------

/**
 * 一条挂在某个拓展名下的连接 —— **就是主人挑中的那个 bot**(ADR-0012 决策 45)。拓展在
 * 候选(`listConnectionCandidates`)里交出来的 settings 原样存进连接,平台从候选上抄;这里不认得
 * 任何具体拓展。显示名默认用候选的名字,主人没填的话。
 */
export function connectionFromCandidate(
	extensionId: string,
	candidate: ConnectionCandidatesResponse["candidates"][number],
	name: string,
): NewConnection & Pick<Connection, "platformSnapshot"> {
	const { platform: _platform, ...platformSnapshot } = candidate.platform;
	return {
		platformSnapshot,
		id: newId(),
		name: name || candidate.name,
		enabled: true,
		adapterKey: extensionId,
		platform: candidate.platform.platform,
		settings: structuredClone(candidate.settings),
	};
}

/**
 * 刚挑了拓展、还没挑 bot 的那条草稿:平台空着,**存不了**(弹窗按它灰掉保存钮)。别在这儿
 * 编一个平台名 —— 连接的平台是从挑中的 bot 上抄的。
 */
export function makeConnectionDraft(extensionId: string, name: string): NewConnection {
	return {
		id: newId(),
		name,
		enabled: true,
		adapterKey: extensionId,
		platform: "",
		settings: undefined,
	};
}

/**
 * 这条连接是不是「只有一个托管目标」的那种(webhook 一族):读的是连接上存的快照
 * (`platformSnapshot.targetKind`)。**它是 `platformSnapshot` 在面板里的唯一读者。**
 */
export function isEndpointConnection(connection: Pick<Connection, "platformSnapshot">): boolean {
	return connection.platformSnapshot.targetKind === "endpoint";
}

/** 面板画连接 / 目标的通断用的三档:没探过(或探不了)是 `pending`。 */
export interface LinkState {
	status: "ok" | "err" | "pending";
	latencyMs?: number;
	/** 失败原因(只在 `err` 时有)。 */
	message?: string;
}

function linkStateOf(
	state: { status: string; latencyMs?: number; message?: string } | undefined,
): LinkState {
	if (state?.status === "reachable") return { status: "ok", latencyMs: state.latencyMs };
	if (state?.status === "unreachable") return { status: "err", message: state.message };
	return { status: "pending" };
}

/** 一条连接的探测结果。`unsupported`(探不了)与没探过一样归 `pending`。 */
export function connectionProbeOf(connection: Pick<Connection, "probeState">): LinkState {
	return linkStateOf(connection.probeState);
}

/** 一个目标上次的可达性。 */
export function targetReachabilityOf(target: Pick<PushTarget, "reachability">): LinkState {
	return linkStateOf(target.reachability);
}

/**
 * 生成 RFC 4122 v4 UUID。后端 schema 的 `id` / `connectionId` 都是 `z.uuid()` 严格
 * 校验,必须返回标准 8-4-4-4-12 格式,否则创建订阅 / 连接 / 目标的 POST 全 400。
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

/** 附加项的 per-目标 三态表:四把键各一张空表 = 每个目标都跟随上一层。 */
function emptyExtraTargets(): Subscription["extraTargets"] {
	const out: Partial<Subscription["extraTargets"]> = {};
	for (const k of EXTRA_KEYS) out[k] = {};
	return out as Subscription["extraTargets"];
}

/**
 * 一条订阅的草稿:身份是 `(sourceKey, externalId)`,`externalId` 原样存、从不解读(拓展订阅就是解析门
 * 交回的那个候选的 `id`)。路由全空、覆写全空 —— 推给谁由配置弹层里挑;单人定时锐评同服务端的
 * makeEmptySubscription,不自带。
 */
export function makeEmptySubscription(identity: Identity): Subscription {
	return {
		id: newId(),
		identity: { ...identity },
		enabled: true,
		tagIds: [],
		notes: undefined,
		cachedProfile: undefined,
		problems: [],
		routing: emptyRouting(),
		extraTargets: emptyExtraTargets(),
		overrides: {},
		// 新订阅不自带定时锐评 —— 加一个 UP 不该顺手给群里排一条周期推送。
		// 与服务端的 makeEmptySubscription 保持一致。
		roastSchedule: structuredClone(DEFAULT_ROAST_SCHEDULE),
		specialViewers: [],
	};
}

export function makeEmptyTarget(connection: Connection, name: string): PushTarget {
	// 地址留空:新建时还没填群号 / openid,发的时候才检查(见 schema 的 address 那段)。
	const base = { id: newId(), name, connectionId: connection.id, enabled: true } as const;
	// webhook 那一族:目标是连接的单向终点,地址烧在连接的 settings 里。
	if (isEndpointConnection(connection)) return { ...base, kind: "endpoint" };
	// 其余(OneBot / QQ 官方 / 拓展借来的 bot,ADR-0012 决策 45)都是会话目标,只填地址。
	// 曾经在拓展那一支 `throw` —— 异常抛在点击处理器里,主人看到的是「点了没反应」。
	return {
		...base,
		kind: "session",
		scope: connection.platformSnapshot.scopes[0] ?? "group",
		address: "",
	};
}
