/**
 * 推送源契约 —— 「一个能把消息送出去的出口长什么样」。
 *
 * 住在公共部分是因为**两边都在实现它**:核心里的 onebot / 官机 / webhook,以及拓展里的
 * 桥(ADR-0012 决策 3)。从前它在 `apps/server/src/platforms/types.ts`,于是拓展要够到
 * 核心才拿得到自己该实现的接口 —— 那条边是反的。
 *
 * ⚠️ 这里只放**契约**,不放任何一个实现:实现要碰网络、要认平台方言,而这个包是平台中立的。
 */

import type { ZodType } from "zod";
import type { Result } from "./constants";
import type {
	ConnectionCapabilities,
	DeliveryResult,
	Disposable,
	IntegrationContext,
	NotificationPayload,
} from "./platform";
import type {
	ChatIdentity,
	Connection,
	DestinationRef,
	PlatformDescriptor,
} from "./schema/targets";

/**
 * 一次连接探测的结果(ADR-0026):通了是 `{ ok: true, latencyMs }`,没通是 `Failure`。
 * 这个适配器没有探测协议时回 `unsupported` —— 它不是「探了、没通」,调用方据此不改连接的状态。
 */
export type ProbeResult = Result<{ latencyMs: number }>;

/**
 * 一个平台实现 —— 认领哪些连接、怎么建连、报文怎么编、地址怎么解、有什么能力。
 * 矩阵({@link TargetDispatcher})拿它按连接的 `adapterKey` 找。
 *
 * 成员分两拨,但**文件刻意没拆**:「怎么连」(建连、重连退避、心跳、生命周期)是通用的,
 * 一条 WS 长连怎么退避重连,跟对面说的是 OneBot 还是 QQ 网关无关,接桥那期的 `koishi` /
 * `astrbot` 只会用到这一拨 —— 桥后面挂着哪些平台是它探出来告诉我们的,我们不为那些平台写
 * 任何编解码;「说哪国话」(报文、地址、能力)只管把 {@link NotificationPayload} 译成对面
 * 听得懂的东西,并回答「这个目标现在发得出去吗」。抽象只有一个长连接用例验证过,别的等
 * 真有了第二个用例再动。
 *
 * 实现**不许抛**:失败回 `fail(code, message)`(码取标准码表,平台自己的码放 `upstreamCode`),
 * 重试由路由层决定。真抛了算 bug,派发器在边界接住按 `unavailable` 记。
 *
 * 方法**不依赖 `this`**:三个实现都是工厂里返回的闭包字面量,状态全在闭包里。这条是承重的 ——
 * 登记表的视图(摘掉 `send`)与 devtools 的能力注入装饰器拿展开语法叠在外面(`{ ...inner }`),被复制过去的
 * 方法会以装饰器对象为 `this` 被调;要是哪天有实现按 `this` 写,叠上去就悄悄丢状态。
 */
export interface PlatformAdapter {
	/**
	 * 适配器键 —— 登记表与分发按它找。内置的是 `"onebot"` / `"qq-official"` / `"webhook"`
	 * (webhook 那一族:飞书 / 钉钉 / 企微 / 通用共用一个),拓展的由宿主填成拓展 id。
	 */
	readonly adapterKey: string;
	/**
	 * Side-effect-free reachability probe. Used by the connection status indicator
	 * and the auto-poller. Implementations that have no out-of-band ping should
	 * return `fail("unsupported", …)` so the UI can render "probe unsupported".
	 */
	probe(connection: Connection): Promise<ProbeResult>;
	/**
	 * 登记即启动 —— 登记表在适配器进表之后调一次(ADR-0024 决策 3)。有状态的连接器在这里
	 * 按 `ctx.connections()` 建连 / 起监听,再用 `ctx.onConnectionsChanged` 订连接配置的变动、
	 * 变了就对一次账。对账必须幂等、够便宜(没变就是空操作),且**不许写配置、不许触发探测**
	 * (会经 `config-changed` 绕回来)。无状态的实现留空。
	 *
	 * 抛了算登记失败:登记表把键与表里那一项撤掉,再把错原样抛出去。
	 */
	start(ctx: PlatformAdapterContext): void;
	/**
	 * 注销即停止 —— 登记表在把适配器摘出表之后调一次。关掉所有连接 / 监听 / 定时器,幂等。
	 * 回 Promise 时登记表不等它,失败由登记表记一行 warn。
	 */
	stop(): void | Promise<void>;
	/**
	 * Return whether this adapter can deliver to `destination` over `connection` right now.
	 * 连接 / 目标的启停与「目标属哪个平台」由派发器查过了,这里只答**运行期**的事:配置齐不齐、
	 * 这个去向的种类自己收不收。
	 */
	isAvailable(connection: Connection, destination: DestinationRef): boolean;
	/** Deliver `payload` to `destination` over `connection`. 群还是私聊只看 `destination.scope`。 */
	send(
		connection: Connection,
		destination: DestinationRef,
		payload: NotificationPayload,
	): Promise<DeliveryResult>;
	/**
	 * 这条连接的能力(三态;探测结果读缓存,同步读、不打网络)。内置适配器都实现;没实现的
	 * (老的拓展适配器)各项按「还不知道」算,怎么对待「还不知道」见 internal 的
	 * `shouldSendAtAll` / `canReceiveReply` / `listsForLinkParsing`。
	 */
	capabilities?(connection: Connection): ConnectionCapabilities;
	/** 主动探一次能力,结果进缓存。连上时、健康探测时、用之前都可以叫;零副作用。 */
	probeCapabilities?(connection: Connection): Promise<ConnectionCapabilities>;
	/**
	 * 这种连接的 `settings` 的校验。宿主拿它:保存时校验、把连接递给适配器之前先解一遍
	 * (**递到适配器手上的连接,`settings` 一律是它解过的输出**,适配器只认键、不再自己解)、
	 * 找密钥标记。
	 */
	readonly settingsSchema: ZodType;
	/**
	 * 列新建连接时供挑的候选(ADR-0024 决策 4)。内置三个都实现(从平台注册表现取自己那几行);
	 * 拓展的由 3b / 22-3 接,所以先是可选 —— 没有这一格的适配器,宿主新建连接时填中性快照。
	 */
	listConnectionCandidates?(signal: AbortSignal): Promise<readonly ConnectionCandidate[]>;
}

/**
 * 新建连接时供挑的一个候选。这一片只有 `platform` 一格(名字、默认设置、selfId 等要到
 * 候选路由 22-3 才有读者)。
 */
export interface ConnectionCandidate {
	/** 候选连接所在平台的描述;宿主新建连接时把它去掉 `platform` 的部分存成 `platformSnapshot`。 */
	platform: PlatformDescriptor;
}

/**
 * 适配器 `start` 时拿到的上下文:集成上下文,加上「自己的连接」的两样 —— 与拓展的推送源把手同形。
 */
export interface PlatformAdapterContext extends IntegrationContext {
	/**
	 * 归这个适配器管的连接(按 `adapterKey` 认领),**现读**。别缓存 —— 缓存与真相会漂,症状是
	 * 「面板上停用了它还连着」;变更通知是用来做动作的,不是用来更新缓存的。
	 */
	connections(): readonly Connection[];
	/** 连接配置动过了(增删改都算),叫一声。适配器停下时自动摘掉。 */
	onConnectionsChanged(fn: () => void): Disposable;
}

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
}

/** 一条私聊。指令分发器只认这个;`userId` 在 OneBot 是 QQ 号,在官机是 C2C 用户 openid。 */
export interface InboundPrivateMessage {
	userId: string;
	text: string;
}

/**
 * 一条私聊 → 「谁」的两坐标,拿去跟主人比对。
 *
 * 地址在帧里、平台在 meta 里 —— 两个鉴权口(指令分发、锐评审批)各自拼一份的话,
 * 迟早有一边少拼一格,而少一格就是把「跨平台不许比」又变回一句注释。
 */
export function inboundIdentity(msg: InboundPrivateMessage, meta: InboundMeta): ChatIdentity {
	return { platform: meta.platform, address: msg.userId };
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
