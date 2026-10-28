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
import type { AuthState } from "./auth-state";
import type {
	ConnectionCapabilities,
	DeliveryResult,
	Disposable,
	IntegrationContext,
	NotificationPayload,
} from "./platform";
import type { PushTargetScope } from "./push-target";
import type { Result } from "./result";
import type {
	ChatIdentity,
	Connection,
	DestinationRef,
	PlatformDescriptor,
} from "./schema/targets";
import type { SettingsScalarField } from "./settings-field";

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
 * 方法可以吃 `this`(class 写的、方法在原型上都行):宿主造视图、派生表、拓展包装、能力注入时
 * 按成员表取成员、并把方法 `bind` 回原实例,不用对象展开。接口里多一个成员,宿主那张成员表
 * (`apps/server/src/push/adapter-members.ts`)编译不过,逼着一起加。
 */
export interface PlatformAdapter {
	/**
	 * 适配器键 —— 登记表与分发按它找。内置的是 `"onebot"` / `"qq-official"` / `"webhook"`
	 * (webhook 那一族:飞书 / 钉钉 / 企微 / 通用共用一个),拓展的由宿主填成拓展 id。
	 */
	readonly adapterKey: string;
	/**
	 * 这个适配器的脸与连接配置项(ADR-0024 决策 3),`GET /api/adapters` 照它列。写成方法:名字是给人看的字,
	 * 要在出字那一刻按当前语言取(ADR-0037 决策 1),每次读都现调;字段会在宿主造视图时冻住。
	 *
	 * 拓展的由宿主照清单 `contributes.push` 填,拓展自己交的不认(ADR-0024 决策 3 下 10-14 的 🔗)。
	 * 内置三个的 `settingsFields` 随 4-29 和表单一起设计,在那之前是空表。
	 */
	descriptor(): PlatformAdapterDescriptor;
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
	 * 抛了(或交回的 Promise 拒了)算登记失败:登记表把键与表里那一项撤掉,再把错原样交回去
	 * (交回 Promise 的以拒绝的形式),登记成功的通知也不会发。异步初始化直接写 `async start()`。
	 */
	start(ctx: PlatformAdapterContext): void | Promise<void>;
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
	 * `shouldSendAtAll` / `canReceiveReply` / `listsForLinkPreview`。
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
	 * 列新建连接时供挑的候选(ADR-0024 决策 4),必备。内置三个交写死的模板候选(平台描述从平台
	 * 注册表现取、设置是默认值),拓展(桥)交在线的 bot;新建连接时宿主只认这里列出来的平台。
	 */
	listConnectionCandidates(signal: AbortSignal): Promise<readonly ConnectionCandidate[]>;
	/**
	 * 列这条连接上可挑的地址。只查 `scope` 那一种 —— 有的种类是内存里现成的,有的要现去平台拉,
	 * 调用方要哪种就只付哪种的代价。不实现 = 这种连接没有可列的地址,面板让主人手填。
	 * 不对拓展开放(ADR-0024 决策 11):拓展的 `adapter` 类型把它排除掉。
	 */
	listAddressCandidates?(
		connection: Connection,
		scope: PushTargetScope,
		signal: AbortSignal,
	): Promise<Result<{ candidates: readonly AddressCandidate[] }>>;
	/**
	 * 扫码之类的建连接流程(ADR-0024 决策 3)。不实现 = 这种连接只能手填。
	 * 不对拓展开放(ADR-0024 决策 11):拓展的 `adapter` 类型把它排除掉。
	 */
	connectionAuth?: ConnectionAuth;
}

/**
 * 一个平台适配器给面板的描述(ADR-0012 决策 33 / 46 那三格外观,加要主人填的那几栏):
 * 推送目标页照它画新建连接那一排的名字、连接卡上那张脸、以及连接配置项。中立概念:拓展写在清单里,
 * 内置适配器经 {@link PlatformAdapter.descriptor} 交同一种(ADR-0024 决策 3)。
 *
 * **就这几格**:作用域、地址名词、能不能 @全体这些都是**bot 所在平台**的事(一条拓展连接
 * 就是一个借来的 bot,决策 45),从 bot 报的 `platform` 查注册表,不从这儿来。
 *
 * 拓展写在清单里,拓展停着也有(ADR-0019 决策 41)。**有它不等于拓展在场** —— 要在场的看它的运行状态。
 */
export interface PlatformAdapterDescriptor {
	/** 全名:新建连接那一排、「经 xxx 借来的」那句。 */
	label: string;
	/** 短名:卡片上那个方章。 */
	shortLabel: string;
	/** 方章的底色,hex。 */
	color: string;
	/** 平台图标:图片 data URL(面板第 4 期按描述画时当 `<img>` 画,这一版还不读)。 */
	icon?: string;
	/** 要主人填的连接配置项;不需要配置的适配器就是空表。 */
	settingsFields: readonly SettingsScalarField[];
}

/**
 * 扫码建连接的三步。三个方法都不依赖 `this`(同文件头那条承重的规矩),都不许抛。
 *
 * 与订阅侧 `SourceAuth.state()` 同名不同形:这边异步、按任务号、回结果形状(要出网,会失败),
 * 那边同步、无参、直接回 `AuthState`。同名是有意的(都是「读此刻的状态」),别为了对齐改成对方的样子。
 */
export interface ConnectionAuth {
	/** 发起一次:开一个任务,回任务号(适配器自己发)、此刻的状态与建议的问询间隔(秒)。 */
	begin(
		signal: AbortSignal,
	): Promise<Result<{ taskId: string; state: AuthState; pollIntervalSeconds: number }>>;
	/** 读这个任务此刻的状态。可反复读;回包不带草稿、不清草稿。 */
	state(taskId: string, signal: AbortSignal): Promise<Result<{ state: AuthState }>>;
	/**
	 * 取走这次认证拿到的那几格设置(键是适配器自己 `settingsSchema` 里的键)。
	 * 只在状态到了 `logged-in` 之后成功一次,取走即清;之后这个任务号找不到。
	 */
	takeDraft(taskId: string): Promise<Result<{ settings: Record<string, unknown> }>>;
}

/** 挑地址时的一个候选(ADR-0024 决策 3 的 listAddressCandidates)。 */
export interface AddressCandidate {
	/** 填进目标 `address` 的那个值。 */
	address: string;
	/** 给人认的名字;平台给不出就没有(QQ 的群事件不带群名,只有触发者的名字可作提示)。 */
	name?: string;
	/** 上级地址,填进目标的 `parentAddress`(QQ 频道:子频道所属的频道服务器 id)。 */
	parentAddress?: string;
	/** 上级的名字,面板拿它给候选分组。 */
	parentName?: string;
}

/**
 * 新建连接时供挑的一个候选(ADR-0024 决策 3、4)。平台固定的适配器交写死的模板候选(OneBot 一个、
 * QQ 官方一个、webhook 四个):`settings` 是默认值、不带 `boundConnectionId`、可以反复用;
 * 桥交在线的 bot。挑中之后宿主把 `platform` 去掉 `platform` 那格存成连接的 `platformSnapshot`,
 * `settings` 原样落进连接。
 */
export interface ConnectionCandidate {
	/** 给人认的名字。 */
	name: string;
	/** 候选连接所在平台的描述;宿主新建连接时把它去掉 `platform` 的部分存成 `platformSnapshot`。 */
	platform: PlatformDescriptor;
	/** 落进连接的 `settings`;宿主看不懂它,按适配器自己的 `settingsSchema` 校验后原样存。 */
	settings: unknown;
	selfId?: string;
	/** 经由谁借来的(桥:那条接入的名字)—— 两条桥各驮一个同名 bot 时分得开。 */
	via?: string;
	/** 已被哪条连接用上 —— 面板标「已加过」。模板候选没有这一格。 */
	boundConnectionId?: string;
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
	/**
	 * 在集成层的上报上多一格 `connectionId`:带了就是关于这条连接的问题(宿主核它是不是这个适配器的连接,
	 * 不是、或不存在的被拒);不带就是适配器自己的问题。连接删了,关于它的问题宿主跟着清。
	 */
	reportProblem(problem: {
		connectionId?: string;
		code: string;
		message: string;
		notify?: boolean;
		recoveryMessage?: string;
	}): void;
	/**
	 * 清掉一个问题(同 `reportProblem` 的对象规矩);语义同集成层的 `resolveProblem`。
	 * 带 `connectionId` 时,连接已删的,清是空操作、不算被拒(宿主删连接时已经清过它名下的问题)。
	 */
	resolveProblem(problem: { connectionId?: string; code: string; notify?: boolean }): void;
	/**
	 * 把收到的私聊 / 群消息交给宿主(ADR-0024 决策 12)。适配器只报**是哪条连接**收到的(`connectionId`),
	 * 平台不由适配器自报:宿主核这条连接是不是这个适配器的(按 `adapterKey`,不是、或不存在的丢掉并记一行),
	 * 平台取连接上那一格,补成完整的 {@link InboundMeta} 再交下一层。两个成员都在 —— 没人接的那一路宿主静默丢。
	 */
	inbound: {
		private(msg: InboundPrivateMessage, meta: Pick<InboundMeta, "connectionId">): void;
		group(msg: InboundGroupMessage, meta: Pick<InboundMeta, "connectionId">): void;
	};
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
	 * 收到这条消息的平台 —— **宿主按连接补上的**,适配器不自报(适配器交入站时只带 `connectionId`)。
	 *
	 * 主人身份的比对要按平台走:OneBot 的 QQ 号与官机的 C2C openid 是两个命名空间,
	 * 光比字符串就是在赌两边永远不撞。这一格让那句「绝不能跨平台比对」第一次真的可校验。
	 */
	platform: string;
}

/** 一条私聊。指令分发器只认这个;`address` 在 OneBot 是 QQ 号,在官机是 C2C 用户 openid。 */
export interface InboundPrivateMessage {
	address: string;
	text: string;
}

/**
 * 一条私聊 → 「谁」的两坐标,拿去跟主人比对。
 *
 * 地址在帧里、平台在 meta 里 —— 两个鉴权口(指令分发、锐评审批)各自拼一份的话,
 * 迟早有一边少拼一格,而少一格就是把「跨平台不许比」又变回一句注释。
 */
export function inboundIdentity(msg: InboundPrivateMessage, meta: InboundMeta): ChatIdentity {
	return { platform: meta.platform, address: msg.address };
}

/**
 * 入站的两路收口。三个直连 adapter 与桥交出来的是同一对回调,所以形状只声明这一份 ——
 * 各写一份的话,哪天加一格(N-3 给 meta 加平台那次)就会有人漏掉。
 */
export interface InboundHandlers {
	private?: (msg: InboundPrivateMessage, meta: InboundMeta) => void;
	group?: (msg: InboundGroupMessage, meta: InboundMeta) => void;
}

/** 一条群消息。链接解析只认这个;`address` 在 OneBot 是群号,在官机是群 openid。 */
export interface InboundGroupMessage {
	address: string;
	/** 发言者。官机给的是群成员域的 openid,与 C2C 用户 openid 不是一个命名空间,别拿去比对主人。 */
	senderId: string;
	/** 收到这条消息的 bot 自己的号(OneBot 有);与 senderId 相同就是自己发的。 */
	selfId?: string;
	/** 用户敲的正文 —— 就是正文,不掺别的。 */
	text: string;
	/**
	 * 分享卡里的链接候选,按出现顺序。与正文分开放:下一个群消息消费者拿到的 `text` 得还是
	 * 「用户敲的那句话」,而不是被接了一串卡片链接的东西。正文里的链接不在这儿,由消费者自己从 `text` 挑。
	 */
	sharedLinks: {
		url: string;
		/**
		 * 这条链接来自哪种卡。`"nativeShare"` 是平台自己的原生分享卡(QQ 小程序卡,B 站 App
		 * 「分享到 QQ」发出的那种):群里已经有一张能点开播放的卡了,链接解析再回一张(不管是图片卡
		 * 还是小程序卡)都是重复 —— 主人 2026-09-07 拍板一律不回。别的卡(json / xml 结构化
		 * 消息)记 `"card"`。
		 */
		kind: "card" | "nativeShare";
	}[];
}
