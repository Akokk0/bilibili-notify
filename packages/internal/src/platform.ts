import type { Subscription } from "./schema/subscriptions";
import type { PushTarget } from "./schema/targets";

/** 通用资源释放接口；adapter 提供，业务持有，dispose 时统一调用。 */
export interface Disposable {
	dispose(): void;
}

/** 业务核心从 adapter 获取的 logger 抽象。Koishi 端包 ctx.logger，独立端包 pino。 */
export interface Logger {
	info(msg: string, ...args: unknown[]): void;
	warn(msg: string, ...args: unknown[]): void;
	error(msg: string, ...args: unknown[]): void;
	debug(msg: string, ...args: unknown[]): void;
}

/**
 * Service runtime 上下文。替代业务代码中直接吃 koishi `Context` 的写法。
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
 * 业务核心唯一事件源。所有 Koishi `bilibili-notify/*` 事件 + 独立端 WS channel 都源自这里。
 * Koishi adapter 将这些事件桥接到 ctx.emit('bilibili-notify/<event>')；独立端 adapter 直接 mitt-like 实现。
 */
export interface BiliEvents {
	"auth-lost": () => void;
	"auth-restored": () => void;
	"cookies-refreshed": (data: unknown) => void;
	"subscription-changed": (ops: SubscriptionOp[]) => void;
	"login-status-report": (snapshot: LoginSnapshot) => void;
	"plugin-error": (source: string, message: string) => void;
	ready: () => void;
	"config-changed": (scope: ConfigScope) => void;
	"history-recorded": (entryId: string) => void;
	"live-state-changed": (uid: string, status: "live" | "idle") => void;
}

/** ConfigStore 在 set 后 emit 'config-changed' 时携带的范围标识。 */
export type ConfigScope = "globals" | "subscriptions" | "targets" | "secrets";

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
	| { type: "link"; href: string; title?: string };

/**
 * 平台中立的消息载荷。Adapter 翻译为各平台原生格式：
 * - Koishi: kind:text → bot.sendMessage(text)；image → h.image(buffer, mime)；composite → h('message', segments)
 * - OneBot: text/image → message segment 数组；composite → 段拼接
 * - Webhook: 序列化为 JSON
 */
export type NotificationPayload =
	| { kind: "text"; text: string }
	| { kind: "image"; image: { buffer: Buffer; mime: string }; caption?: string }
	| { kind: "composite"; segments: PayloadSegment[] };

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
