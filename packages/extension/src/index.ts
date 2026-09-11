/**
 * `@bilibili-notify/extension` —— **宿主给拓展的那一面**。
 *
 * 拓展住在仓里的 `extensions/<id>/`(ADR-0012 决策 4),写的是 TypeScript,所以它需要
 * 「ctx 上有哪几格」「一个推送源要交哪几样」这些类型。它们必须住在一个**双方都够得到的
 * 公共包**里:放核心里的话,拓展得反过来依赖宿主应用,那条边是反的。
 *
 * 🔴 **拓展只从这一个包拿 BN 的东西。** 它自己那一面(ctx、挂载点、upgrade、表单字段表)
 * 定义在这里;推送源契约与 adapter 签名要用的域类型定义在 `@bilibili-notify/internal`
 * (那是**核心也在实现**的业务词汇),由这里**转出一道** —— 拓展不直接依赖 internal。
 *
 * 为什么转一道而不是让拓展自己去拿:`internal` 导出的是**整个域模型**(globals、
 * subscriptions、patch……),拓展依赖了它就能伸手拿全部,那面太宽。**这里列出来的这些就是
 * 契约的全部** —— 加一格是一次明确的加宽决定(决策 13:契约的宽度不可逆),而不是
 * 「反正 internal 里有」。
 *
 * ⚠️ **只放类型,不放实现。** 拓展会被打成自包含的 `index.mjs`,从这里 import 一个运行时
 * 值等于把一份宿主代码的拷贝塞进拓展包里。真有非放不可的值,先想清楚再破例。
 *
 * ⛔ 一格都别多给:`ExtensionRuntime`(谁来收摊)、`ExtensionMounts` / `ExtensionUpgrades`
 * (两张宿主的分发表)、`InboundSinks`(绕过归属校验的那条管子)刻意都不在这儿 ——
 * **契约的宽度是不可逆的**(决策 13),窄面加宽容易,反过来不行。
 */

/**
 * 推送源契约 —— 一个出口长什么样。核心的 onebot / 官机 / webhook 与每个推送拓展实现的
 * 都是这一套,所以它的本体住 `@bilibili-notify/internal`;这里转出来给拓展用。
 */
/**
 * 实现推送源用得着的域类型 —— `send` / `probe` / `reconcile` 的签名就是拿它们拼的。
 *
 * ⛔ 域模型的其余部分(globals / subscriptions / 订阅与推送的落盘形状……)**刻意不转** ——
 * 拓展碰不着配置的写路径,那条路在这仓里只有一条。
 */
export type {
	Connection,
	ConnectionCapabilities,
	Connector,
	DeliveryResult,
	Disposable,
	InboundGroupMessage,
	InboundMeta,
	InboundPrivateMessage,
	Logger,
	NotificationPayload,
	PayloadSegment,
	PlatformAdapter,
	PlatformDialect,
	ProbeResult,
	PushTarget,
	PushTargetScope,
} from "@bilibili-notify/internal";

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type {
	Disposable,
	InboundGroupMessage,
	InboundMeta,
	InboundPrivateMessage,
	Logger,
	PlatformAdapter,
	PlatformDescriptor,
} from "@bilibili-notify/internal";
import type { ZodType } from "zod";

/**
 * 面板照它画一栏配置。与拓展交的那份 zod 是**两份声明**,注册那一刻逐格对表
 * (ADR-0012 决策 19 / 33):字段表给人填(label / 控件),schema 给机器校验(类型 / 必填)。
 *
 * 🔴 `secret: true` 同时是**备份脱敏的依据**。脱敏本来靠一份键名黑名单,而拓展的 config
 * 键名归拓展自己起 —— 不声明的话,那个 token 会原样躺在主人发出去求助的备份文件里。
 */
export type ExtensionConfigField = ExtensionConfigFieldBase &
	(
		| {
				kind: "text";
				placeholder?: string;
				mono?: boolean;
				secret?: boolean;
		  }
		| { kind: "number"; min?: number; max?: number; step?: number; suffix?: string }
		| { kind: "toggle" }
		| { kind: "select"; options: readonly { value: string; label: string }[] }
	);

interface ExtensionConfigFieldBase {
	/** config 里的键名。**同时是这一栏的身份** —— 值就落在 `config[code]`。 */
	code: string;
	label: string;
	hint?: string;
	required?: boolean;
}

/**
 * 拓展交给宿主的 HTTP 处理函数。
 *
 * 是**标准 fetch 形状**而不是一个 Hono 子应用:拓展包旁边没有 node_modules,它 import
 * 不到 hono。`Request` / `Response` 是运行时自带的。
 */
export type ExtensionFetchHandler = (req: Request) => Response | Promise<Response>;

/** 一条落到某个拓展名下的 WS upgrade。 */
export interface ExtensionUpgrade {
	/** 原样的请求 —— `ws` 的 `handleUpgrade` 吃的就是这三样。 */
	req: IncomingMessage;
	socket: Duplex;
	head: Buffer;
	/**
	 * 去掉 `/ext/<id>` 之后那一段(至少是 `/`)。
	 *
	 * 单给一格而**不改 `req.url`**:`upgrade` 事件上还挂着别的监听器(面板那条 `/ws`),
	 * 改掉它等于在别人脚下换地板。
	 */
	path: string;
}

export type ExtensionUpgradeHandler = (upgrade: ExtensionUpgrade) => void;

/**
 * 拓展交给面板的元信息 —— **就是 `PlatformDescriptor`,少掉 `connectors` 那一格**。
 *
 * 不是新概念:少那一格是因为「怎么连」在拓展这一支根本不存在(连接上没有 `connector`,
 * 见 ADR-0012 决策 27),而 `connectors` 的用处是「新建连接时默认选哪一档」。
 */
export type ExtensionDescriptor = Omit<PlatformDescriptor, "connectors">;

/**
 * 一个推送源 —— 决策 7 那三样已有名字的东西装在一起,**一次交齐**。
 *
 * 拆成三个口的话,一个拓展可以只注册一半,而「有行为、没有面板元信息」是个没人想处理的
 * 中间态。(config 的**字段表**是第四样,跟着表单那一片一起加。)
 */
export interface PushExtensionDef<TConfig> {
	/** 行为。⚠️ 它自报的 `platforms` **会被宿主覆盖**成这个拓展的 id。 */
	adapter: PlatformAdapter;
	/** 面板元信息。 */
	descriptor: ExtensionDescriptor;
	/** config 的校验。宿主拿它解连接,解不出的那条根本不交给拓展。 */
	configSchema: ZodType<TConfig>;
	/**
	 * config 里**要主人亲手填**的那几栏 —— 面板照它画表单。与 `configSchema` 是两份声明,
	 * 注册那一刻逐格对表,对不上直接抛(决策 19 / 33)。
	 *
	 * 可以是空表:桥那种「连接是从 `listBots` 里挑出来的」推送源,config 整份由拓展自己
	 * 交(见 {@link ExtensionBotView.config}),没有一栏是人填的。
	 */
	configFields: readonly ExtensionConfigField[];
	/**
	 * **现在能借来当连接的 bot**,现读。可选:endpoint 形态的推送源没有 bot 这回事。
	 *
	 * 🔴 **一条连接就是一个 bot**(ADR-0012 决策 45)—— 与直连同一套操作逻辑:新建连接时
	 * 挑一个 bot,底下的推送目标只填地址。哪些 bot 能挑只有拓展知道(桥后面挂什么是握手时
	 * 才知道的),所以宿主拿这一格列给主人挑,而不是让主人手敲一个 id。
	 */
	listBots?: () => readonly ExtensionBotView<TConfig>[];
}

/**
 * 一个能借来当连接的 bot。
 *
 * 面板新建连接时列给主人挑,挑中的那个**整个 `config` 原样落进连接**、`platform` 落进
 * 连接的 `platform` —— 宿主看不懂 config(那归拓展自己那份 zod),只负责原样存回。
 * `platform` 是开放词表;`icon` 是 data URL(与桥协议 §5.2 同一种)。
 */
export interface ExtensionBotView<TConfig = unknown> {
	/** 绑上这个 bot 的连接该存的 config。拓展自己认得就行。 */
	config: TConfig;
	platform: string;
	name?: string;
	selfId?: string;
	icon?: string;
	/** 经由谁借来的(桥:那条接入的名字)—— 两条桥各驮一个同名 bot 时分得开。 */
	via?: string;
	/** 已经被哪条连接绑着 —— 面板标「已加过」,同一个 bot 别建两条连接。 */
	boundTo?: string;
}

/** 一条属于这个拓展的连接 —— config 已经解成它自己的形状。 */
export interface ExtensionConnectionView<TConfig> {
	id: string;
	name: string;
	/** 主人有没有停用这条。**停用的也在名单里** —— 拓展要拿它答「这条为什么发不出去」。 */
	enabled: boolean;
	config: TConfig;
}

/**
 * 拓展自己的持久设置 —— 主人在面板上给**这个拓展**填的那些(桥的接入名单就住这儿),
 * 落盘在 `globals.extensions.<id>.settings`,**形状归拓展自己那份 zod**,宿主只保证存得住。
 *
 * 与连接是两回事:连接是「一个 bot」,是宿主认识、推送目标能挂上去的东西;设置是拓展
 * 为了拿到那些 bot 而需要主人填的东西(token、对家的名字……),宿主一格都不认识。
 *
 * ⛔ **没有写口** —— 配置的写路径在这仓里只有面板那一条(决策 30 同一条纪律)。拓展要
 * 自己记东西的那天(订阅源的游标)再开,按同一条纪律等真实用例。
 */
export interface ExtensionSettings<T> {
	/**
	 * **现读**,已经过交进来的那份 zod。没设过、或形状不对(宿主记一行)都是 `undefined`
	 * —— 两种在拓展眼里都是「按没有算」。
	 */
	get(): T | undefined;
	/** 内容**真的变了**才叫(globals 别处动一下不算)。卸载时自动摘掉。 */
	onChange(fn: () => void): Disposable;
}

/** 注册完一个推送源之后拿到的把手。 */
export interface PushSourceHandle<TConfig> {
	/**
	 * 属于自己的连接,**现读**。
	 *
	 * 别缓存 —— 缓存与真相会漂,症状是「面板上停用了它还连着」,而且没人报错。变更通知是
	 * 用来**做动作**的(踢会话),不是用来刷缓存的。
	 */
	connections(): readonly ExtensionConnectionView<TConfig>[];
	/** 配置动过了。卸载时自动摘掉。 */
	onConnectionsChanged(fn: () => void): Disposable;
}

/**
 * 交给拓展的那面 —— **第一版刻意很窄**(ADR-0012 决策 13)。
 *
 * 窄面加宽容易,反过来不行;而我们手上只有一个真实用例(桥接),凭空设计「宿主应该提供
 * 什么」就是在猜。⛔ **`bus` 永远不在这里** —— `MessageBus` 是全仓唯一事件通道,给出去
 * 就等于允许写第二条通道之间的转发器(CLAUDE.md 那条硬约束:会自喂死循环爆栈)。
 *
 * 🔴 拓展的**一切副作用都得从这里过**:裸 `setInterval`、裸挂端点都是禁止的。这是
 * 「卸载得干净」的唯一承重条件 —— 留一条旁路,卸载就不干净,而不干净的卸载比要求重启
 * 更难 debug(面板写着「已停用」,定时器还在跑)。
 */
export interface ExtensionContext {
	/** 它自己的 id —— 同时是挂载点、装载目录与记账键那一段。 */
	readonly id: string;
	/** 宿主契约的主版本。拓展自己也可能要按它分叉。 */
	readonly hostApiVersion: number;
	/**
	 * 独立端自己的版本号(载荷版本)。**与契约版本是两件事** —— 那个决定「加不加载」,
	 * 这个是拿去报给对家看的(桥在 `welcome` 帧里把它告诉插件)。
	 */
	readonly hostVersion: string;
	/** 每一行都自动带上 `[ext:<id>]` —— 日志里认得出是谁写的。 */
	readonly logger: Logger;
	/** 可回收定时器。卸载时宿主统一清,拓展自己漏了也不会留下幽灵。 */
	setTimeout(fn: () => void, ms: number): Disposable;
	setInterval(fn: () => void, ms: number): Disposable;
	/**
	 * 申请一条 HTTP 总入口,回宿主分配的前缀(`/ext/<自己的 id>`)。
	 *
	 * **拓展不该知道自己挂在哪**(决策 12):handler 收到的路径已经剥掉前缀,要拼绝对
	 * 地址时才用这个返回值。一个拓展只有一条总入口,再申请一次会抛。
	 */
	mount(handler: ExtensionFetchHandler): string;
	/**
	 * 注册这个拓展的推送源 —— 一个拓展只有一个(决策 28),再注册一次会抛。
	 *
	 * **分发键由宿主按 id 填**,`adapter.platforms` 自报的那份会被覆盖:自报的话,一个
	 * 拓展可以声明 `"onebot"` 把内置那条连接的推送整个截走。归属是宿主的判断。
	 */
	registerPushSource<TConfig>(def: PushExtensionDef<TConfig>): PushSourceHandle<TConfig>;
	/**
	 * 把一条入站消息喂回核心 —— 归一化在拓展这一侧做完(决策 31)。
	 *
	 * 🔴 `meta.connectionId` **宿主校验归属**:不是自己的连接就丢掉并记一行。放过去的话,
	 * 甲拓展能冒充乙拓展的连接投消息,而主人身份比对走的正是 `平台 + 地址 + bot` 三坐标。
	 *
	 * 🔴 `meta.platform` **以那条连接上那一格为准** —— 报的和连接对不上时,宿主按连接算并
	 * 记一行(每条连接一次)。它是身份比对的另一半,而拓展自报的那一格没有任何办法核;
	 * 一条连接就是一个 bot、bot 就在一个平台上(决策 45),所以这件事宿主自己答得出来。
	 */
	readonly inbound: {
		private(msg: InboundPrivateMessage, meta: InboundMeta): void;
		group(msg: InboundGroupMessage, meta: InboundMeta): void;
	};
	/**
	 * 认领 `/ext/<id>` 底下的 WS upgrade。
	 *
	 * 交给它的是**原样的三样原料**(`req` / `socket` / `head`)加一段剥掉前缀的路径:
	 * 握手、鉴权、帧上限、心跳全归拓展 —— 那些是协议语义(决策 26)。宿主只回答
	 * 「这条 upgrade 归谁」。
	 */
	onUpgrade(handler: ExtensionUpgradeHandler): void;
	/**
	 * 交一份给面板看的数据(任意 JSON)。宿主在 `/api/ext/<id>/status` 下发 —— 走
	 * `/api/*` 才吃得到 dashboard 会话鉴权,而 `/ext/<id>/*` 是**刻意**在鉴权外的。
	 *
	 * 形状第一版不约束:面板那一页还没写,而抽象要两个例子。**现取**,不缓存。
	 */
	publishStatus(fn: () => unknown): void;
	/**
	 * 交上去的那份数据**变了**,喊一声。`publishStatus` 是现取的,盲点在「什么时候该再取」:
	 * 桥那头刚握完手,面板上那张卡还灰着,得切一下页才刷新。宿主把这一声推到面板(WS
	 * `state` 频道),面板当场重取 `/api/ext/<id>/status` 与 bot 名单。什么算「变了」由
	 * 拓展自己定 —— 桥:一条接入连上 / 断开。
	 */
	statusChanged(): void;
	/**
	 * 自己的持久设置(见 {@link ExtensionSettings})。交一份 zod 进来,拿回一个现读的把手。
	 * 可以叫多次,每次都是同一份数据的一个视图。
	 */
	settings<T>(schema: ZodType<T>): ExtensionSettings<T>;
	/** 卸载时要跑的收摊钩子。后注册的先跑。 */
	onDispose(fn: () => void | Promise<void>): void;
}
