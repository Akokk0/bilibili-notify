import type { HistoryEntry } from "./schema/history";
import type { Subscription } from "./schema/subscriptions";
import type { PushTarget } from "./schema/targets";

/** 通用资源释放接口；adapter 提供，业务持有，dispose 时统一调用。 */
export interface Disposable {
	dispose(): void;
}

/** 业务核心从宿主获取的 logger 抽象(独立端包 pino)。 */
export interface Logger {
	info(msg: string, ...args: unknown[]): void;
	warn(msg: string, ...args: unknown[]): void;
	error(msg: string, ...args: unknown[]): void;
	debug(msg: string, ...args: unknown[]): void;
}

/**
 * Service runtime 上下文 —— 业务代码不直接吃任何宿主框架的 Context。
 * - logger：日志门面
 * - setInterval / setTimeout：返回 Disposable，dispose 后停止
 * - onDispose：注册关闭钩子（adapter 在生命周期结束时调用）
 */
export interface ServiceContext {
	readonly logger: Logger;
	setInterval(fn: () => void, ms: number): Disposable;
	setTimeout(fn: () => void, ms: number): Disposable;
	onDispose(fn: () => void | Promise<void>): void;
}

/**
 * 订阅变更操作。CRUD 产生的 diff 列表，随 subscription-changed 事件携带。
 *
 * `remove` 同时携带 `id`（dashboard 内部 uuid）与 `uid`（B 站用户 ID）。
 * 下游引擎（DynamicEngine / LiveEngine）按 B 站 UID 索引 listener / poll target，
 * 没有 uid 时无法正确清理已订阅 UP 的资源；保留 id 以便 store 内部按主键定位。
 */
export type SubscriptionOp =
	| { type: "add"; sub: Subscription }
	| { type: "remove"; id: string; uid: string }
	| { type: "update"; sub: Subscription };

/**
 * 业务核心唯一事件源。独立端 WS channel 都源自这里;宿主 adapter 以 mitt-like 实现。
 */
export interface BiliEvents {
	"auth-lost": () => void;
	"auth-restored": () => void;
	"cookies-refreshed": (data: unknown) => void;
	"subscription-changed": (ops: SubscriptionOp[]) => void;
	"login-status-report": (snapshot: LoginSnapshot) => void;
	/**
	 * Surface a runtime error from a business engine / subsystem.
	 * `source` 是逻辑发射源标识(e.g. "dynamic-engine" / "live-engine" / "image" / "ai")
	 * 用于消费方（master-notifier / AlertShell）做按域节流与展示。
	 */
	"engine-error": (source: string, message: string) => void;
	ready: () => void;
	"config-changed": (scope: ConfigScope) => void;
	/**
	 * 一条推送被 HistoryStore 写入后立刻 emit。
	 * 载荷是完整 entry,WS push-events 直接转发给前端做 toast/通知,
	 * 无需前端再二次 fetch detail。
	 */
	"history-recorded": (entry: HistoryEntry) => void;
	/**
	 * 直播状态翻转。
	 *
	 * `at` 是**这次状态翻转的真实发生时刻**(ISO),两个方向语义不同,都可能缺失:
	 *
	 *   · `status === "live"` → B 站给出的真实开播时刻。消费方务必区分它与「我们
	 *     发现开播的时刻」—— 服务器在 UP 已开播时启动,两者能差出好几个小时,拿
	 *     后者当开播时间会把这段直播时长整段吞掉。**它同时是这一场的身份**:统计侧
	 *     按它认场次,同一场被重连核对 / 重启 bootstrap 再观测到时必须给出同一个值。
	 *   · `status === "idle"` → 真实下播时刻。走断流接续(grace)时,真实下播在进入
	 *     挂起那刻就定格了,而事件要等 N 分钟窗口到期才发得出来;不带它的话消费方
	 *     只能用「收到事件的此刻」,每场直播平白多算一整个 grace 窗口。
	 *
	 * 缺失时(接口没返回 / 解析失败 / 非 grace 路径)消费方回退到「收到事件的此刻」。
	 */
	"live-state-changed": (uid: string, status: "live" | "idle", at?: string) => void;
	/**
	 * 直播间累计观看人数变化(B 站 WS `WATCHED_CHANGE` 帧 → live engine 节流后转发)。
	 * Engine 端按 per-UID 2s throttle,所以高频帧不会打爆 bus。viewers 是 B 站预格式化
	 * 后的中文压缩字符串(如 "1.2万");消费方直接展示,不二次转换。
	 */
	"live-viewers-changed": (uid: string, viewers: string) => void;
	/**
	 * 一轮 FansPoller 完成后 emit。entries 携带本轮采样到的所有 enabled subs 的
	 * 当前 fans + 三个窗口(订阅起点 / 24h / 7d)的 delta。前端 setQueryData
	 * 全量覆盖 ["fans"] 缓存。delta 字段为 null 表示窗口内没有可用基线/样本。
	 */
	"fans-refreshed": (entries: FansRefreshEntry[]) => void;
	/**
	 * 一条此前未见过的动态首次越过 per-uid 时间线闸门时 emit。
	 *
	 * **载荷是 UP 的产出记录,不是推送记录**:被过滤器屏蔽、被 per-UP 开关关掉、
	 * 投递失败的动态一律照常 emit。数据统计要回答的是「这位 UP 发了多少」,
	 * 「我们推了多少」看 `history-recorded`,两者口径不可混用。
	 *
	 * **不是 exactly-once**:投递失败走 `markFail`,时间线锚点不前移,下一轮
	 * 重判会把同一条再 emit 一次。消费方必须按 `id` 幂等 —— `StatsRecorder`
	 * 靠 `StatsStore.appendDynamic` 的 id 去重挡掉,新消费方别忘了这一层。
	 */
	"dynamic-detected": (event: DynamicDetectedEvent) => void;
}

/** Bus 上 dynamic-detected 事件的载荷。 */
export interface DynamicDetectedEvent {
	uid: string;
	/** B 站动态 id_str;消费方据此去重。 */
	id: string;
	/**
	 * B 站原始动态类型字符串(DYNAMIC_TYPE_AV / _DRAW / _WORD / _LIVE_RCMD …)。
	 * 事件层**不做语义归类** —— 哪些算投稿、哪些算普通动态、哪些是开播伪动态
	 * 要剔除,策略集中在 stats 聚合层一处,免得多个消费方各自跑偏。
	 */
	type: string;
	/** 动态发布时间(ISO)。 */
	ts: string;
}

/** Bus 上 fans-refreshed 事件 / HTTP /api/fans 返回的单条 entry。 */
export interface FansRefreshEntry {
	uid: string;
	/** 本次采样到的 B 站当前 fans 数。 */
	current: number;
	/** 本次采样时间(ISO)。 */
	ts: string;
	/** delta 相对 subscribed baseline;subscribed baseline 缺失时为 null。 */
	deltaSubscribed: number | null;
	/** delta 相对 24h 前最近一条样本;窗口内无样本时为 null。 */
	delta24h: number | null;
	/** delta 相对 7d 前最近一条样本;窗口内无样本时为 null。 */
	delta7d: number | null;
}

/** ConfigStore 在 set 后 emit 'config-changed' 时携带的范围标识。 */
export type ConfigScope = "globals" | "subscriptions" | "adapters" | "targets" | "secrets";

/** 用于 'login-status-report' 事件 / Dashboard auth channel；具体 schema 在 packages/api。 */
export interface LoginSnapshot {
	status: number;
	msg: string;
	data?: unknown;
}

/** 事件总线接口。on 返回 Disposable 用于 unsubscribe。 */
export interface MessageBus {
	emit<E extends keyof BiliEvents>(event: E, ...args: Parameters<BiliEvents[E]>): void;
	on<E extends keyof BiliEvents>(event: E, handler: BiliEvents[E]): Disposable;
}

/** 单段消息载荷类型。composite 中的 segment 之一。 */
export type PayloadSegment =
	| { type: "text"; text: string }
	| { type: "image"; buffer: Buffer; mime: string }
	| { type: "link"; href: string; title?: string }
	/**
	 * @全体成员 段。仅出现在 composite payload 中,由 BilibiliPush.broadcastToFeature
	 * 在 per-target 时按 sub.atAll[feature] 判断是否前置。各 platform adapter 自行翻译:
	 * - OneBot v11: `{ type: "at", data: { qq: "all" } }`(真实 @ 全体)
	 * - Webhook: JSON 序列化时保留 `{ type: "at-all" }`,由接收方自行处理
	 * - Web Dashboard: 渲染成可视化 "@全体" 文本(非真实 @)
	 *
	 * 不会作为单独 payload kind 出现 —— @ 永远是 dynamic/live 推送的"修饰",不能单独发。
	 */
	| { type: "at-all" };

/**
 * 图集单图 —— url + 可选原始像素尺寸。尺寸来自 B站图集元数据(opus.pics / draw.items
 * 的 width/height),仅 QQ 官方原生 markdown 多图(`![文字 #宽px #高px](url)`)需要它来
 * 正常渲染;OneBot / webhook 等只用 `url`,尺寸缺失不影响。
 */
export interface ForwardImage {
	url: string;
	width?: number;
	height?: number;
}

/**
 * 平台中立的消息载荷。Adapter 翻译为各平台原生格式:
 * - OneBot: text/image → message segment 数组；composite → 段拼接
 * - Webhook: 序列化为 JSON
 */
export type NotificationPayload =
	| { kind: "text"; text: string }
	| { kind: "image"; image: { buffer: Buffer; mime: string }; caption?: string }
	| { kind: "composite"; segments: PayloadSegment[] }
	/**
	 * 图集 payload(典型来源:动态图集 / 多张大图)。`forward` 决定 adapter 用哪种
	 * 平台原生形式投递:
	 *   - `true` —— 走 OneBot `send_group_forward_msg`,
	 *     渲染成「聊天记录」卡片。视觉好但走长消息通道(NapCat 的 `SsoSendLongMsg`
	 *     trpc 在某些部署上不稳),失败时所有图都丢。
	 *   - `false` —— 走 OneBot `send_group_msg` 多 image segment。
	 *     普通多图。稳但 N+ 张大图会一排刷屏。
	 * 默认值由上游 dynamic engine config(`imageGroupForward`)决定。
	 */
	| { kind: "forward-images"; images: ForwardImage[]; forward: boolean };

/**
 * 推送出口接口。业务核心持有此接口，按 PushTarget.id 投递。
 * Adapter 实现内部按 target.platform 分发到具体 platform adapter。
 */
export interface NotificationSink {
	send(targetId: string, payload: NotificationPayload): Promise<DeliveryResult>;
	sendPrivate(targetId: string, payload: NotificationPayload): Promise<DeliveryResult>;
	/** 允许 adapter 通过 id 查目标的元数据（platform / scope / 启停状态）。 */
	resolve(targetId: string): PushTarget | undefined;
	/** 健康检查：目标当前是否可投递（bot 在线 / endpoint 可达）。 */
	isAvailable(targetId: string): boolean;
}

export interface DeliveryResult {
	ok: boolean;
	latencyMs: number;
	err?: string;
}
