/**
 * 推送源契约 —— 「一个能把消息送出去的出口长什么样」。
 *
 * 住在公共部分是因为**两边都在实现它**:核心里的 onebot / 官机 / webhook,以及拓展里的
 * 桥(ADR-0012 决策 3)。从前它在 `apps/server/src/platforms/types.ts`,于是拓展要够到
 * 核心才拿得到自己该实现的接口 —— 那条边是反的。
 *
 * ⚠️ 这里只放**契约**,不放任何一个实现:实现要碰网络、要认平台方言,而这个包是平台中立的。
 */

import type { ConnectionCapabilities, DeliveryResult, NotificationPayload } from "./platform";
import type { ChatIdentity, Connection, PushTarget } from "./schema/targets";

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

/**
 * 「**怎么**连」—— 建连、重连退避、心跳、生命周期。与「连到**哪个**平台」正交。
 *
 * 这一半是通用的:一条 WS 长连怎么退避重连,跟对面说的是 OneBot 还是 QQ 网关无关。
 * 接桥那期的 `koishi` / `astrbot` **只实现这一半** —— 桥后面挂着哪些平台是它探出来
 * 告诉我们的,我们不为那些平台写任何编解码。
 *
 * ⚠️ 眼下三个实现都同时实现两半({@link PlatformAdapter} 就是那个交集),**文件也刻意
 * 没拆** —— 抽象只有一个长连接用例验证过,容易抽错。这里先把缝划清楚:哪些方法属于
 * 「怎么连」、哪些属于「说哪国话」,别的等接桥那期真有了第二个用例再动。
 */
export interface Connector {
	/**
	 * Side-effect-free reachability probe. Used by the connection status indicator
	 * and the auto-poller. Implementations that have no out-of-band ping should
	 * return `{ ok: null }` so the UI can render "probe unsupported".
	 */
	probe(connection: Connection): Promise<ProbeResult>;
	/**
	 * Stateful connectors only — called once at boot and again on every
	 * `config-changed: connections`. Reconcile live sockets / listeners against
	 * the current connection set (start / stop / rebind). MUST be idempotent and
	 * cheap (no-op when nothing changed) and MUST NOT write config or trigger a
	 * probe (would loop back through `config-changed`).
	 */
	reconcile?(connections: readonly Connection[]): void;
	/** Stateful connectors only — close all connections / listeners / timers on shutdown. Idempotent. */
	dispose?(): void | Promise<void>;
}

/**
 * 「连到**哪个**平台」—— 认领哪些平台、报文怎么编、地址怎么解、有什么能力。
 *
 * 一份方言只管把 {@link NotificationPayload} 译成对面听得懂的东西,并回答「这个目标
 * 现在发得出去吗」。它不管连接是怎么建起来的 —— 那是 {@link Connector} 的事。
 */
export interface PlatformDialect {
	/** Platforms this dialect speaks ("onebot" / "feishu" / …). 矩阵按它分发。 */
	readonly platforms: readonly string[];
	/** Return whether this dialect can deliver to `target` over `connection` right now. */
	isAvailable(connection: Connection, target: PushTarget): boolean;
	/** Deliver `payload` to `target` over `connection`. `private=true` flips group → private semantics where applicable. */
	send(
		connection: Connection,
		target: PushTarget,
		payload: NotificationPayload,
		opts?: { private?: boolean },
	): Promise<DeliveryResult>;
	/**
	 * 平台能力快照(探测结果的缓存,同步读、不打网络)。没有能力概念的平台不实现 ——
	 * 调用方按「没实现 = 什么都不支持」处理,面板据此写「这个平台不支持」。
	 */
	capabilities?(connection: Connection): ConnectionCapabilities;
	/** 主动探一次能力,结果进缓存。连上时、健康探测时、用之前都可以叫;零副作用。 */
	probeCapabilities?(connection: Connection): Promise<ConnectionCapabilities>;
}

/**
 * 一个平台实现 —— 今天两半都由同一个对象扛,所以它就是那两个接口的交集。
 * 矩阵({@link MultiplexNotificationSink})拿它按 `connection.platform` 分发。
 *
 * 实现**不许抛**:返回 `{ ok: false, err: "..." }`,重试由路由层决定。
 *
 * 方法**不依赖 `this`**:三个实现都是工厂里返回的闭包字面量,状态全在闭包里。这条是承重的 ——
 * devtools 的装饰器(截流闸、能力注入)拿展开语法叠在外面(`{ ...inner, send }`),被复制过去的
 * 方法会以装饰器对象为 `this` 被调;要是哪天有实现按 `this` 写,叠上去就悄悄丢状态。
 */
export interface PlatformAdapter extends Connector, PlatformDialect {}

/**
 * 入站消息 —— 各平台事件帧到「谁在哪说了什么」的收口。**归一化在 adapter 里做**:
 * 消费者(指令分发、链接解析)只认下面两个形状,谁也不该再去碰平台的原始帧。两个
 * adapter 交出来的是同一个形状,接线层才不用替每个平台各写一份映射。
 */

/** 收到这条消息的那条连接 —— 「回到消息来的那个群」得知道用哪条连接的凭据发。 */
export interface InboundMeta {
	connectionId: string;
	/**
	 * 收到这条消息的平台。
	 *
	 * 主人身份的比对要按平台走:OneBot 的 QQ 号与官机的 C2C openid 是两个命名空间,
	 * 光比字符串就是在赌两边永远不撞。这一格让那句「绝不能跨平台比对」第一次真的可校验。
	 */
	platform: string;
	/** 收到这条消息的那个 bot 自己的号。一条连接驮多个 bot(桥)时才有,直连没有。 */
	botId?: string;
}

/** 一条私聊。指令分发器只认这个;`userId` 在 OneBot 是 QQ 号,在官机是 C2C 用户 openid。 */
export interface InboundPrivateMessage {
	userId: string;
	text: string;
}

/**
 * 一条私聊 → 「谁」的三坐标,拿去跟主人比对。
 *
 * 地址在帧里、平台与 bot 在 meta 里 —— 两个鉴权口(指令分发、锐评审批)各自拼一份的话,
 * 迟早有一边少拼一格,而少一格就是把「跨平台不许比」又变回一句注释。
 */
export function inboundIdentity(msg: InboundPrivateMessage, meta: InboundMeta): ChatIdentity {
	return { platform: meta.platform, address: msg.userId, botId: meta.botId };
}

/**
 * 入站的两路收口。三个直连 adapter 与桥交出来的是同一对回调,所以形状只声明这一份 ——
 * 各写一份的话,哪天加一格(N-3 给 meta 加平台那次)就会有人漏掉。
 */
export interface InboundSinks {
	onInboundPrivate?: (msg: InboundPrivateMessage, meta: InboundMeta) => void;
	onInboundGroup?: (msg: InboundGroupMessage, meta: InboundMeta) => void;
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
	 * **不含** QQ 小程序卡里的 —— 那些单放 {@link miniAppCardLinks}。
	 */
	cardLinks: string[];
	/**
	 * QQ 小程序卡(`com.tencent.miniapp_01`,B 站 App「分享到 QQ」发出的那种)里的链接候选。
	 * 单放一格是因为链接解析对它的态度不一样:群里已经有一张能点开播放的卡了,再回一张
	 * (不管是图片卡还是小程序卡)都是重复 —— 主人 2026-09-07 拍板一律不回。
	 */
	miniAppCardLinks: string[];
}
