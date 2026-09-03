import type {
	DeliveryResult,
	NotificationPayload,
	PushAdapter,
	PushTarget,
} from "@bilibili-notify/internal";

/**
 * Platform adapter contract used by {@link MultiplexNotificationSink}.
 *
 * One adapter per `PushAdapter.platform` family. Each platform adapter is
 * constructed with shared deps (HTTP client, WS server reference, etc.) and
 * exposes a single async `send(adapter, target, payload, opts)` method —
 * `adapter` carries the connection params (baseUrl, token, …), `target`
 * carries the session (groupId, userId, …). The sink dispatches by
 * matching `adapter.platform`.
 *
 * Adapters should NOT throw — return `{ ok: false, err: "..." }` instead.
 * The router will retry on transient failures.
 */
/**
 * Connection-level probe outcome. Distinct from {@link DeliveryResult} so the
 * caller can tell "this platform doesn't support a no-message probe" apart
 * from "probe ran and failed".
 */
export interface ProbeResult {
	/** `true` = reachable; `false` = reachable test failed; `null` = adapter has no probe protocol */
	ok: boolean | null;
	latencyMs: number;
	err?: string;
}

export interface PlatformAdapter {
	/** Platforms this adapter handles ("onebot" / "webhook"). */
	readonly platforms: readonly string[];
	/** Return whether this adapter can deliver to `target` (via `adapter`) right now. */
	isAvailable(adapter: PushAdapter, target: PushTarget): boolean;
	/** Deliver `payload` to `target` over `adapter`. `private=true` flips group → private semantics where applicable. */
	send(
		adapter: PushAdapter,
		target: PushTarget,
		payload: NotificationPayload,
		opts?: { private?: boolean },
	): Promise<DeliveryResult>;
	/**
	 * Side-effect-free reachability probe. Used by the adapter status indicator
	 * and the auto-poller. Implementations that have no out-of-band ping should
	 * return `{ ok: null }` so the UI can render "probe unsupported".
	 */
	probe(adapter: PushAdapter): Promise<ProbeResult>;
	/**
	 * Stateful adapters only — called once at boot and again on every
	 * `config-changed: adapters`. Reconcile live connections / listeners against
	 * the current adapter set (start / stop / rebind). MUST be idempotent and
	 * cheap (no-op when nothing changed) and MUST NOT write config or trigger a
	 * probe (would loop back through `config-changed`).
	 */
	reconcile?(adapters: readonly PushAdapter[]): void;
	/** Stateful adapters only — close all connections / listeners / timers on shutdown. Idempotent. */
	dispose?(): void | Promise<void>;
}

/**
 * 入站消息 —— 各平台事件帧到「谁在哪说了什么」的收口。**归一化在 adapter 里做**:
 * 消费者(指令分发、链接解析)只认下面两个形状,谁也不该再去碰平台的原始帧。两个
 * adapter 交出来的是同一个形状,接线层才不用替每个平台各写一份映射。
 */

/** 收到这条消息的那条连接 —— 「回到消息来的那个群」得知道用哪个 adapter 的凭据发。 */
export interface InboundMeta {
	adapterId: string;
}

/** 一条私聊。指令分发器只认这个;`userId` 在 OneBot 是 QQ 号,在官机是 C2C 用户 openid。 */
export interface InboundPrivateMessage {
	userId: string;
	text: string;
}

/** 一条群消息。链接解析只认这个;`groupId` 在 OneBot 是群号,在官机是群 openid。 */
export interface InboundGroupMessage {
	groupId: string;
	/** 发言者。官机给的是群成员域的 openid,与 C2C 用户 openid 不是一个命名空间,别拿去比对主人。 */
	userId: string;
	/** 收到这条消息的 bot 自己的号(OneBot 有);与 userId 相同就是自己发的。 */
	selfId?: string;
	/** 用户敲的正文 —— 就是正文,不掺别的。 */
	text: string;
	/**
	 * 分享卡(json / xml 段)里的链接候选,按出现顺序。与正文分开放:下一个群消息消费者
	 * 拿到的 `text` 得还是「用户敲的那句话」,而不是被接了一串卡片链接的东西。
	 */
	cardLinks: string[];
}
