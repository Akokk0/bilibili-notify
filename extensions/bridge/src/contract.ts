/**
 * 桥接协议 wire 契约 —— 独立端的 WS 端点 ↔ 跑在机器人框架里的桥接插件。
 *
 * 形态一句话:**桥主动连 BN**。BN 开一条 WS 端点(桥是拓展,地址由宿主分配,今天是
 * `/ext/bridge`),插件(koishi / AstrBot)填「BN 地址 + token」连过来,把它宿主里的
 * bot 借给 BN 用。重连退避归插件 —— 先例是 OneBot 的 ws-reverse,本来就是
 * 「BN 开口、bot 连进来」。
 *
 * 与 dashboard 那条 `/ws` **彻底分开**:那条的帧想改就改(两端同版本同时发),这条
 * 对面是**独立发版的第三方插件**,所以有独立的协议版本号与「不认识就忽略」的演进纪律。
 *
 * Wire format
 * ----------
 * 传输:WebSocket,JSON 文本帧,一帧一个对象,`type` 是判别子。
 * 鉴权:**HTTP upgrade 时的 `Authorization: Bearer <token>` 头**,不在帧里、不在 URL 里
 *   (URL 会进访问日志)。token 错 / 已吊销 → upgrade 直接 401,连 WS 都不给开。
 *
 * Bridge → Server:  hello / bots / inbound / result / pong
 * Server → Bridge:  welcome / send / ping / error
 *
 * 演进纪律(两个方向对称,写死在协议里):
 *   - 收到**不认识的 `type`** → 记一行 debug 后**忽略**,不断连。桥比 BN 新时多发一种
 *     帧不该把老 BN 打死。
 *   - 收到**认识的 type 但形状不对** → 拒(BN 侧断连 4003)。这不是「新帧」,是畸形帧。
 *   - 能力表里**不认识的键静默丢掉**,不认识的**值**当 `unknown`。
 *
 * 帧的 zod 校验、心跳间隔、blob TTL 是实现细节,在这个拓展的别的文件里;
 * 给插件作者看的规范在 `../PROTOCOL.md`。
 */

import type { PushTargetScope } from "@bilibili-notify/extension";

// ---------------------------------------------------------------------------
// 协议版本
// ---------------------------------------------------------------------------

export interface BridgeProtocolVersion {
	major: number;
	minor: number;
}

/**
 * BN 这一侧说的协议版本。**判定只看 `major`** —— major 相同即接受,minor 差多少、
 * 谁大谁小都不管。所以:加可选字段 / 加新帧类型 → 只升 minor;改已有字段的含义或
 * 删字段 → 升 major(那会把所有旧插件挡在门外,是刻意的)。
 */
export const BRIDGE_PROTOCOL_VERSION: BridgeProtocolVersion = { major: 1, minor: 2 };

/** 桥的种类。**BN 侧处理完全相同**,这一格只用来显示与排障。 */
export const BRIDGE_KINDS = ["koishi", "astrbot"] as const;
export type BridgeKind = (typeof BRIDGE_KINDS)[number];

// ---------------------------------------------------------------------------
// 能力
// ---------------------------------------------------------------------------

/**
 * 桥**必报**的六项能力。
 *
 * 为什么是「声明」不是「探测」:四家框架(koishi/Satori、AstrBot、NoneBot、OneBot v11)
 * 都自省不了这些 —— koishi 的 `bot.supports()` 粒度是 Satori 的 **API 方法**
 * (`message.delete` 那类),而 @全体 / 发图 / 合并转发是**消息元素**;适配器遇到不认识的
 * 元素**静默丢弃、不抛错**,连 try/catch 都探不出来。所以只能由桥硬编一张表报上来。
 *
 * 为什么归桥不归 BN:能力是「**框架 × 平台**」的函数 —— 同一个 Telegram 经 koishi 和经
 * AstrBot 能力可能不同(取决于那个框架的适配器实现了多少),桥天然是一维表,BN 要建就是
 * 二维表;何况两个框架的平台词表还不同名(koishi `onebot` vs AstrBot `aiocqhttp`)。
 *
 * - `atAll` —— 能不能真的 @全体成员(不是发一串「@全体」文字)。
 * - `inbound` —— 能不能把用户的消息回传给 BN。私聊指令与群链接解析都靠它。
 * - `forward` —— 合并转发(「聊天记录」卡)。
 * - `miniAppCard` —— 能不能发 QQ 小程序卡(要能向腾讯签 ark)。
 * - `shareCardLinks` —— 群里的分享卡 / 小程序卡消息,桥能不能解出里面的链接回传。
 * - `markdown` —— 那一头认不认 markdown。**BN 据此分叉**:认就把主人写的排版原样发出去,
 *   不认(或 `unknown`)就在 BN 这一侧剥成干净纯文本 —— 不然群里收到的是一堆星号。
 *   ⛔ 与之相对,`link` 段怎么渲染**不是**能力项:那本来就归桥自己判,BN 不必据此分叉。
 *   能力项的门槛是「**BN 要据此做不同的事**」,不是「对面有什么区别」。
 *   BN 只出 CommonMark 的一个子集,**方言转换(转义 / 平台富文本)归桥**,BN 一种都不懂。
 *
 * **发文本恒真,不做成能力项** —— 一个连文本都发不出的 bot 没有接进来的意义。
 */
export const BRIDGE_CAPABILITIES = [
	"atAll",
	"inbound",
	"forward",
	"miniAppCard",
	"shareCardLinks",
	"markdown",
] as const;
export type BridgeCapability = (typeof BRIDGE_CAPABILITIES)[number];

/**
 * 三态,不是布尔 —— 桥对没见过的平台会**真的不知道**。
 * UI 上「不支持」与「还不知道」要分开显示:前者是结论,后者是「试试看,可能行」。
 */
export const BRIDGE_CAPABILITY_STATES = ["supported", "unsupported", "unknown"] as const;
export type BridgeCapabilityState = (typeof BRIDGE_CAPABILITY_STATES)[number];

/** 归一之后的能力表 —— 六项恒在。BN 内部只该看见这个形状。 */
export type BridgeCapabilityReport = Record<BridgeCapability, BridgeCapabilityState>;

/**
 * 桥在 wire 上报的那张表 —— **键与值都开放**:桥可以少报(缺的按 `unknown` 算)、
 * 多报(BN 静默丢掉)、报个 BN 没见过的值(按 `unknown` 算)。校验放宽是刻意的:
 * 一格没见过的能力不该把整帧握手拒掉。
 */
export type BridgeCapabilityWire = Record<string, string>;

// ---------------------------------------------------------------------------
// bot 名单
// ---------------------------------------------------------------------------

/**
 * 桥借给 BN 的一个 bot。**握手给全量、之后桥推快照**(见 {@link BridgeBotsFrame})。
 *
 * `botId` 只要求**在这条桥连接内唯一**,BN 拿它回指「用哪个 bot 发」;`platform` 是
 * **开放词表**(telegram / discord / onebot / …),它是能力键与显示标签,不是分发键 ——
 * 分发键是连接那一侧的 `kind`,桥后面挂什么平台 BN 一概不预设。
 */
export interface BridgeBotWire {
	botId: string;
	platform: string;
	/** 显示名。给面板上的 bot 名单用。 */
	name?: string;
	/** bot 在平台上的账号(QQ 号 / telegram id / …)。**仅用于显示**,别拿去当身份比对。 */
	selfId?: string;
	/**
	 * 平台的图标,给面板上 bot 那一行画方块用。**只收 `data:image/…;base64,` 的 data URL**
	 * (png / jpeg / webp / svg+xml),不收 http(s) 地址 —— 面板一开就去对家点名不是图标该有的
	 * 本事。BN 这头**不认得**桥后面的平台(开放词表),所以图标只能由桥给;不给就退回
	 * 首字母。上限 32 KB,超了整枚丢掉。
	 */
	icon?: string;
	capabilities?: BridgeCapabilityWire;
}

/** 归一之后的 bot —— 能力表已补成六项恒在。 */
export interface BridgeBot extends Omit<BridgeBotWire, "capabilities"> {
	capabilities: BridgeCapabilityReport;
}

// ---------------------------------------------------------------------------
// 消息投影(Server → Bridge)
// ---------------------------------------------------------------------------

/**
 * `NotificationPayload` 在 wire 上的 JSON 投影。差别只有一处:**图从 `Buffer` 换成
 * 一次性 blob URL**(见 {@link BridgeSendFrame} 的说明)。
 */
export type BridgeSegment =
	| { type: "text"; text: string }
	| { type: "image"; url: string; mime: string }
	| { type: "link"; href: string; title?: string }
	/** 桥按 `atAll` 能力决定翻成真 @全体还是降级成文字。 */
	| { type: "at-all" };

export type BridgeMessage =
	| { kind: "text"; text: string }
	| { kind: "image"; url: string; mime: string; caption?: string }
	| { kind: "composite"; segments: BridgeSegment[] }
	/** `forward: true` 要求 `forward` 能力;不支持时桥自己降级成多张图,别整条丢。 */
	| {
			kind: "forward-images";
			images: { url: string; width?: number; height?: number }[];
			forward: boolean;
	  }
	| {
			kind: "miniapp-card";
			title: string;
			desc: string;
			picUrl: string;
			/** 小程序**页面路径**(B 站视频页是 `pages/video/video?bvid=…`),不是网页链接。 */
			path: string;
			/** 网页链接。签不了 ark 时降级成文字只用它。 */
			jumpUrl: string;
	  };

/**
 * {@link BridgeMessage} 的判别子词表 —— 运行时要遍历它(守卫、文档生成),所以得有个值。
 *
 * `satisfies` 让它**跟着联合走**:联合里没有的档写进来就编译不过。反方向由
 * `protocol.test.ts` 的投影表钉住 —— 那张表对 `NotificationPayload` 的 kind 是全的,
 * 所以**有 payload 来源的**档漏在这里就编译不过。漏网的只剩「联合加了一档但没有任何
 * payload 会走它」,那是条死枝,发不出去的风险为零。
 */
export const BRIDGE_MESSAGE_KINDS = [
	"text",
	"image",
	"composite",
	"forward-images",
	"miniapp-card",
] as const satisfies readonly BridgeMessage["kind"][];
export type BridgeMessageKind = (typeof BRIDGE_MESSAGE_KINDS)[number];

// ---------------------------------------------------------------------------
// Bridge → Server 帧
// ---------------------------------------------------------------------------

export const BRIDGE_TO_SERVER_FRAME_TYPES = ["hello", "bots", "inbound", "result", "pong"] as const;
export type BridgeToServerFrameType = (typeof BRIDGE_TO_SERVER_FRAME_TYPES)[number];

/**
 * 握手 —— 连上后桥发的**第一帧**。BN 在 {@link BRIDGE_HANDSHAKE_TIMEOUT_MS} 内没收到
 * 就断连。token 不在这里(在 upgrade 的 header 里),所以这一帧到达时身份已经确认过了。
 */
export interface BridgeHelloFrame {
	type: "hello";
	protocol: BridgeProtocolVersion;
	bridge: {
		kind: BridgeKind;
		/** 桥自己起的名字,面板上显示。 */
		name?: string;
		/** 插件版本,排障用。 */
		version?: string;
	};
	bots: BridgeBotWire[];
}

/**
 * bot 名单**全量快照**,不是增量。
 *
 * 只有一种帧、且幂等,是刻意的:koishi 有 `login-added/removed/updated` 三个事件、
 * AstrBot 没有插件钩子只能轮询 `get_insts()` —— 两边都能轻松产出一份快照,而增量帧
 * 要求两边对齐顺序与丢帧语义。协议只规定「桥必须推」,不规定它怎么察觉。
 */
export interface BridgeBotsFrame {
	type: "bots";
	bots: BridgeBotWire[];
}

/** 一条入站消息。`scope` 只有两支 —— 频道消息由桥自己归到 `group`。 */
export type BridgeInboundMessage =
	| { scope: "private"; userId: string; text: string }
	| {
			scope: "group";
			groupId: string;
			/** 发言者。跨平台不同命名空间,别拿去跟别的平台的主人身份比。 */
			userId: string;
			text: string;
	  };

/**
 * 入站消息。**按需订阅** —— BN 在 {@link BridgeWelcomeFrame} 里下发要什么,桥在自己
 * 那侧过滤后才发。群白名单**不下放**:那是 BN 的策略,BN 本地过滤。
 */
export interface BridgeInboundFrame {
	type: "inbound";
	botId: string;
	platform: string;
	message: BridgeInboundMessage;
}

/** 一次 {@link BridgeSendFrame} 的回执。`id` 原样带回。 */
export interface BridgeResultFrame {
	type: "result";
	id: string;
	ok: boolean;
	err?: string;
}

export interface BridgePongFrame {
	type: "pong";
}

export type BridgeToServerFrame =
	| BridgeHelloFrame
	| BridgeBotsFrame
	| BridgeInboundFrame
	| BridgeResultFrame
	| BridgePongFrame;

// ---------------------------------------------------------------------------
// Server → Bridge 帧
// ---------------------------------------------------------------------------

export const SERVER_TO_BRIDGE_FRAME_TYPES = ["welcome", "send", "ping", "error"] as const;
export type ServerToBridgeFrameType = (typeof SERVER_TO_BRIDGE_FRAME_TYPES)[number];

/**
 * BN 要什么入站消息。桥在**自己那侧**过滤,省的是带宽与隐私,不是 BN 的工作量。
 *
 * `group: "with-links"` —— 只要含链接的群消息。BN 今天群里**没有指令入口**(指令是
 * 私聊专属),群消息唯一的用途就是链接解析。
 */
export interface BridgeInboundSubscription {
	private: boolean;
	group: "none" | "with-links";
}

/** 握手回执。版本不兼容时 BN 不发这一帧,直接按 {@link BRIDGE_CLOSE_CODES} 断连。 */
export interface BridgeWelcomeFrame {
	type: "welcome";
	protocol: BridgeProtocolVersion;
	server: {
		/** 独立端版本,排障与「你这版太老了」提示用。 */
		version: string;
	};
	inbound: BridgeInboundSubscription;
}

/**
 * 发一条消息。`id` 由 BN 生成,桥用 {@link BridgeResultFrame} 原样带回。
 *
 * ⚠️ **图里的 URL 只保证桥自己可达**(`<挂载点>/blob/<id>`,一次性 id + 短 TTL 即凭据)。
 * 桥要把图交给平台去拉的话**必须自己先下载**再以文件 / base64 交上去 —— BN 常跑在
 * NAS 上、外网根本进不来,Telegram 服务器去拉那个 URL 会**静默失败**。
 * (便宜的地方:koishi 的 `<img src>` 与 AstrBot 的 `Comp.Image.fromURL` 都直接吃 http
 * URL,本地部署时桥连一次内存拷贝都不用做。)
 */
export interface BridgeSendFrame {
	type: "send";
	id: string;
	botId: string;
	platform: string;
	target: {
		scope: PushTargetScope;
		address: string;
		parentAddress?: string;
	};
	message: BridgeMessage;
}

export interface BridgePingFrame {
	type: "ping";
}

/** 出错但还不至于断连(比如一条 `send` 引用了不存在的 bot)。断连一律走 close code。 */
export interface BridgeErrorFrame {
	type: "error";
	message: string;
}

export type ServerToBridgeFrame =
	| BridgeWelcomeFrame
	| BridgeSendFrame
	| BridgePingFrame
	| BridgeErrorFrame;

// ---------------------------------------------------------------------------
// 断连
// ---------------------------------------------------------------------------

/**
 * BN 主动断连时用的 close code(WS 应用私有区 4000–4999)。插件应当据此决定**要不要
 * 重连**:`unauthorized` / `incompatibleProtocol` / `revoked` 重连多少次都没用,
 * 该把错误显示给用户;别的可以退避重连。
 */
export const BRIDGE_CLOSE_CODES = {
	/** token 错 —— 实际上 upgrade 阶段就 401 了,这一档留给「连上之后 token 被吊销」。 */
	unauthorized: 4001,
	/** major 对不上。别重连,升级插件或升级 BN。 */
	incompatibleProtocol: 4002,
	/** 认识的帧但形状不对。 */
	badFrame: 4003,
	/** 连上了但迟迟不发 `hello`。 */
	handshakeTimeout: 4004,
	/** 这条桥接入被删了 / token 被重新生成了。别重连。 */
	revoked: 4005,
	/** 同一个 token 又连进来一条 —— **新的赢**,老的收这个。避免僵尸连接占着位子。 */
	replaced: 4006,
	/**
	 * **这条桥接入**被停用了(接入还在,只是关着)。配置全留,重开即恢复,可以退避重连。
	 *
	 * ⚠️ 桥拓展整个被关掉是**另一回事**:那时桥自己被收摊,连接以 `1001` 断开 —— 它没有
	 * 机会挑一个码,也不需要,两者对插件来说都是「退避重连」。
	 */
	disabled: 4007,
} as const;

export type BridgeCloseCode = (typeof BRIDGE_CLOSE_CODES)[keyof typeof BRIDGE_CLOSE_CODES];

/** 桥连上之后必须在这个窗口内发 `hello`,否则断连 —— 不给未鉴权的空连接占位子。 */
export const BRIDGE_HANDSHAKE_TIMEOUT_MS = 10_000;
