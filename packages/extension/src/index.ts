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
	/**
	 * 推送源契约 —— 一个出口长什么样。核心的 onebot / 官机 / webhook 与每个推送拓展实现的
	 * 都是这一套,所以它的本体住 `@bilibili-notify/internal`;这里转出来给拓展用。
	 */
	PlatformAdapter,
	PlatformDialect,
	ProbeResult,
	PushTarget,
	PushTargetScope,
} from "@bilibili-notify/internal";

/**
 * 面板也要认的那几个形状住零依赖子入口 `./wire`(理由见那个文件的文件头),这里**转出来**
 * —— 拓展照旧只认这一扇门,不必知道有过这么一次拆分。
 */
export type {
	ExtensionBlock,
	ExtensionBotView,
	ExtensionButton,
	ExtensionConfigField,
	ExtensionDescriptor,
	ExtensionDisplay,
	ExtensionField,
	ExtensionItemView,
	ExtensionListField,
	ExtensionPushView,
	ExtensionRichRun,
	ExtensionRichText,
	ExtensionScalarField,
	ExtensionSubscriptionCandidate,
	ExtensionSubscriptionDisplay,
	ExtensionSubscriptionEventKind,
	ExtensionSubscriptionView,
	ExtensionTableCell,
	ExtensionTableColumn,
	ExtensionTone,
	ExtensionView,
	ExtensionViewSummary,
} from "./wire";

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type {
	Disposable,
	InboundGroupMessage,
	InboundMeta,
	InboundPrivateMessage,
	Logger,
	PlatformAdapter,
} from "@bilibili-notify/internal";
import type { ZodType } from "zod";
import type {
	ExtensionBotView,
	ExtensionConfigField,
	ExtensionDescriptor,
	ExtensionSubscriptionCandidate,
	ExtensionView,
} from "./wire";

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
 * 一个推送源 —— **代码那一半**:行为与校验,一次交齐。
 *
 * 外观(`display`)与连接配置项(`connection.fields`)是静态数据,写在清单的
 * `contributes.push` 里(ADR-0019 决策 16),宿主读清单拿;代码里别再交一份 —— 两份声明
 * 会打架,宿主注册那一刻就会抛。清单里没开 `contributes.push` 的拓展注册不了推送源。
 */
export interface PushExtensionDef<TConfig> {
	/** 行为。⚠️ 它自报的 `platforms` **会被宿主覆盖**成这个拓展的 id。 */
	adapter: PlatformAdapter;
	/**
	 * config 的校验。宿主拿它解连接,解不出的那条根本不交给拓展;注册那一刻还拿它与清单里的
	 * 连接配置项逐格对表(键、类型、默认值),对不上直接抛(ADR-0019 决策 17)。
	 */
	configSchema: ZodType<TConfig>;
	/**
	 * **现在能借来当连接的 bot**,现读。可选:endpoint 形态的推送源没有 bot 这回事。
	 *
	 * 🔴 **一条连接就是一个 bot**(ADR-0012 决策 45)—— 与直连同一套操作逻辑:新建连接时
	 * 挑一个 bot,底下的推送目标只填地址。哪些 bot 能挑只有拓展知道(桥后面挂什么是握手时
	 * 才知道的),所以宿主拿这一格列给主人挑,而不是让主人手敲一个 id。给了它,连接配置项
	 * 就可以是空表(config 整份由拓展交,见 {@link ExtensionBotView.config})。
	 */
	listBots?: () => readonly ExtensionBotView<TConfig>[];
}

/**
 * **v1 的推送源** —— 清单 `apiVersion: 1` 的拓展还把外观与连接配置项写在代码里,用的是
 * 老名字。宿主收下时翻译成新形状。只剩桥在用;桥迁到 v2、再抬最低档之后删掉。
 */
export interface LegacyPushExtensionDef<TConfig> extends PushExtensionDef<TConfig> {
	/** 外观(新名字:清单里的 `contributes.push.display`)。 */
	descriptor: ExtensionDescriptor;
	/** 连接配置项(新名字:清单里的 `contributes.push.connection.fields`)。 */
	configFields: readonly ExtensionConfigField[];
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
	 * **现读**,已经过交进来的那份 zod。`undefined` 只有一个意思:**没设过**。
	 *
	 * 存着的那份过不了这份 zod 时,拓展**根本不会跑着**(ADR-0019 决策 36):开机时宿主不起它、
	 * 面板上是「设置读不了」,改对了宿主自己起它;跑着时被写坏了,宿主不把那一份交给它、
	 * 接着把它收掉 —— 这里读到的永远是一份过得了它自己 zod 的设置。
	 */
	get(): T | undefined;
	/**
	 * 内容**真的变了**才叫(globals 别处动一下不算),而且只在新的那份过得了交进来的 zod 时叫。
	 * 卸载时自动摘掉。
	 */
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
 * 一个订阅源 —— **代码那一半**:行为(ADR-0012 决策 7 的 `SubscriptionSourceDef`)。
 *
 * 外观与会报哪几种事件是静态数据,写在清单的 `contributes.subscription` 里(ADR-0019 决策 16);
 * 清单里没开这一口的拓展注册不了订阅源。
 */
export interface SubscriptionSourceDef {
	/**
	 * **解析门**:主人在新建订阅的输入框里粘的东西(主页链接、id、名字……)**原样**交进来,回「可能是
	 * 哪几个人」(ADR-0019 决策 11 / 52)。只回候选 —— 建不建、建成什么样由 BN 定。一个都认不出就
	 * 回空表;认不出是因为平台那头出了错(被风控、cookie 过期),抛出来 —— 原话会给到面板。
	 *
	 * 🔴 `signal` 在两种时候中止,手上的请求接着它停:**超时**(`reason` 是 `TimeoutError`,宿主已经
	 * 回了面板一句「超时」)与**拓展停用 / 收摊**(`AbortError`)。
	 *
	 * 查询**可以并发**(主人一边打字一边查),宿主不排队、不挡第二发;要节流是拓展自己的事(它才知道
	 * 那个平台的风控松紧)。
	 */
	lookup(
		query: string,
		signal: AbortSignal,
	): readonly ExtensionSubscriptionCandidate[] | Promise<readonly ExtensionSubscriptionCandidate[]>;
}

/**
 * 一条属于这个拓展的订阅 —— 只有拓展要的那三格(ADR-0019 决策 52):推不推、推给谁它不需要
 * 知道(决策 1)。
 */
export interface ExtensionOwnSubscription {
	/** BN 这条订阅自己的 id(uuid)—— 以后报资料、报事件时认的是 `externalId`,这一格用来分条。 */
	id: string;
	/** 那个人在平台上的 id —— 建订阅时它从解析门交出来的那个 `id`,原样。 */
	externalId: string;
	/** 主人有没有停用这条。**停用的也在名单里** —— 跳不跳过由拓展自己定。 */
	enabled: boolean;
}

// ---- 订阅源的上报(ADR-0019 决策 4 / 7 / 54–57 / 62)--------------------------------------------
//
// 🔴 这几张表是 `@bilibili-notify/internal` 里上报 zod 的**手写镜像**(拓展进不来 internal),两份由宿主
// 那头的类型断言**双向严格相等**地钉住(`apps/server/src/extensions/subscription-shape-pin.ts`)。
//
// 共同的规矩:
// - **时刻一律是毫秒时间戳**(`Date.now()` / `getTime()`)。平台接口常给秒 —— 早于 2000 年的宿主当场拒。
// - **图一律交字节**(`Uint8Array`,Buffer 也行),平台的门道(Referer、签名链接、过期)留在拓展里
//   (决策 6)。宿主按文件头认格式,收下的是它自己拷的一份。
// - 字段只收**通用的**;多交一格宿主不认识的,整条拒。认识的选填格值坏了(一张图解不开、超大小、数为负、
//   字符串超长)只丢那一格,其余照收 —— 丢了什么、为什么,记在日志与拓展详情页的「上报问题」里。

/**
 * 卡上的作者(决策 54):都选填,出卡优先用这里的,没带的那一样用订阅资料。**不改资料** —— 订阅页的
 * 名字 / 头像只认 {@link SubscriptionSourceHandle.reportProfile}。
 */
export interface SubscriptionAuthor {
	/** 1–128 字。 */
	name?: string;
	/** png / jpeg / webp(不收 gif、SVG),约 96 KiB 封顶。 */
	avatar?: Uint8Array;
}

/** 作品里的视频(决策 55)。都选填。 */
export interface SubscriptionVideo {
	/** 封面:png / jpeg / webp / gif,8 MiB 封顶。 */
	cover?: Uint8Array;
	title?: string;
	/** 时长,**秒**。 */
	duration?: number;
	/** 简介,纯文本。 */
	description?: string;
	/** 播放数。 */
	plays?: number;
}

/** 作品的互动数(决策 55):交数字(非负整数),BN 排版。 */
export interface SubscriptionPostStats {
	likes?: number;
	comments?: number;
	/** 转发 / 分享。 */
	shares?: number;
}

/**
 * 一条作品(决策 55)—— 映射到 BN 的「动态」。
 *
 * 不收:转发(嵌套原作品)、富文本(表情图 / @ / 话题高亮)、话题、附加卡(预约 / 商品 / 投票)、
 * 充电专属、弹幕数、大会员标记。正文里的 #话题 照字面显示。
 */
export interface SubscriptionPost {
	/** 平台自己的作品 id,原样存。 */
	id: string;
	/** 作品的链接,http(s)。 */
	url: string;
	/** 发布时刻,毫秒。 */
	publishedAt: number;
	/** 正文,纯文本,保留换行。 */
	text?: string;
	/** 作品图:png / jpeg / webp / gif,单张 8 MiB、最多 30 张;宽高由 BN 读。 */
	images?: readonly Uint8Array[];
	video?: SubscriptionVideo;
	stats?: SubscriptionPostStats;
	author?: SubscriptionAuthor;
}

/**
 * 直播那张表里除了链接与开播时刻之外的格(决策 56),都选填。
 *
 * 不收:关键帧、人气值、短号、粉丝勋章、词云 / 总结 / SC / 上舰。粉丝那一格事件不带 —— BN 拿订阅资料
 * 里的粉丝数自己算(开播记一次、下播相减)。
 */
export interface SubscriptionLiveDetails {
	title?: string;
	/** 封面:png / jpeg / webp / gif,8 MiB 封顶。 */
	cover?: Uint8Array;
	/** 分区。 */
	category?: string;
	viewers?: number;
	likes?: number;
	/** 纯文本。 */
	description?: string;
	author?: SubscriptionAuthor;
}

/** 开播(决策 56)—— 映射到 BN 的「开播」。 */
export interface SubscriptionLiveStart extends SubscriptionLiveDetails {
	/** 直播间链接,http(s)。 */
	url: string;
	/** 开播时刻,毫秒。 */
	startedAt: number;
}

/**
 * 下播(决策 56)—— 映射到 BN 的「下播」。开播时刻 BN 自己记着,BN 中途重启过才用得上这里补的那一格。
 */
export interface SubscriptionLiveEnd extends SubscriptionLiveDetails {
	url: string;
	startedAt?: number;
}

/**
 * 直播状态(决策 57)—— **不触发推送**。每轮查询都可以报,开机第一轮查基线时也报。BN 拿它做首页在播、
 * 周期「正在直播」、重启补推、下播补开播时刻;开播卡 / 下播卡仍只由事件触发,BN 不拿状态的翻转猜。
 */
export interface SubscriptionLiveStatus extends SubscriptionLiveDetails {
	/** 在不在播。 */
	live: boolean;
	url?: string;
	startedAt?: number;
}

/**
 * 资料更新(决策 7 / 62)—— **不触发推送**,订阅页的名字 / 头像 / 粉丝数认的是它。都选填。
 */
export interface SubscriptionProfile {
	/** 1–128 字。 */
	name?: string;
	/** png / jpeg / webp(不收 gif、SVG),约 96 KiB 封顶。 */
	avatar?: Uint8Array;
	fans?: number;
}

/**
 * 注册完一个订阅源之后拿到的把手。
 *
 * **五个 `report*`**(决策 7 / 62):按外部 id 报「那个人怎么了」,BN 找出这个拓展名下所有指向他的订阅
 * 逐条分发。它们都在 BN **核完形状、对上订阅**之后就 resolve,不等出卡与推送;拒掉时 reject 一个
 * 带原因的 `Error`:
 * - 报了清单 `contributes.subscription.events` 里没声明的种类(直播状态要声明了开播或下播之一;
 *   资料更新总是收);
 * - 外部 id 不是 1–256 字的字符串;
 * - 多了 BN 不认识的字段,或者必填的缺了 / 坏了。
 *
 * 外部 id 不在自己名下(多半是订阅刚删、变更通知还没到)不算错:忽略、正常 resolve。停用的订阅收不到
 * 事件与直播状态,资料更新照样生效。
 *
 * 判新、去重、限流都归拓展(决策 53):BN 报什么收什么,不兜底 —— 开机第一轮只记基线、别报。
 */
export interface SubscriptionSourceHandle {
	/**
	 * 属于自己的订阅,**现读**。别的拓展的、B 站的都不在里面。
	 *
	 * 别缓存 —— 缓存与真相会漂,症状是「面板上删了它还在轮询」,而且没人报错。变更通知是用来
	 * **做动作**的(补上新订阅的基线),不是用来刷缓存的。
	 */
	subscriptions(): readonly ExtensionOwnSubscription[];
	/** 订阅动过了。卸载时自动摘掉。 */
	onSubscriptionsChanged(fn: () => void): Disposable;
	/** 那个人发了一条新作品(清单要声明 `post`)。 */
	reportPost(externalId: string, post: SubscriptionPost): Promise<void>;
	/** 那个人开播了(清单要声明 `liveStart`)。 */
	reportLiveStart(externalId: string, live: SubscriptionLiveStart): Promise<void>;
	/** 那个人下播了(清单要声明 `liveEnd`)。 */
	reportLiveEnd(externalId: string, live: SubscriptionLiveEnd): Promise<void>;
	/** 那个人此刻在不在播(清单要声明 `liveStart` 或 `liveEnd`)。不触发推送。 */
	reportLiveStatus(externalId: string, status: SubscriptionLiveStatus): Promise<void>;
	/** 那个人的名字 / 头像 / 粉丝数(总是收)。不触发推送。 */
	reportProfile(externalId: string, profile: SubscriptionProfile): Promise<void>;
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
	/** 宿主**当前**的契约档位(它认的区间的上沿)。拓展自己也可能要按它分叉。 */
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
	 *
	 * 清单没开推送源那一口(v2 的 `contributes.push`、v1 的 `provides`)会抛。v2 交
	 * {@link PushExtensionDef},v1 交 {@link LegacyPushExtensionDef}。
	 */
	registerPushSource<TConfig>(
		def: PushExtensionDef<TConfig> | LegacyPushExtensionDef<TConfig>,
	): PushSourceHandle<TConfig>;
	/**
	 * 注册这个拓展的订阅源 —— 一个拓展就是一个平台(ADR-0019 决策 9),再注册一次会抛。
	 *
	 * **只有 v2**,而且清单得开了 `contributes.subscription`,否则抛:注册的口必须是清单开了的口。
	 * 订阅记在哪个拓展名下由宿主按 id 认,拓展不自报(同推送源的分发键)。
	 */
	registerSubscriptionSource(def: SubscriptionSourceDef): SubscriptionSourceHandle;
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
	 * 交给面板看的「视图」(ADR-0019 决策 20 / 39)—— **v2 专用**。宿主在 `/api/ext/<id>/status`
	 * 下发:走 `/api/*` 才吃得到 dashboard 会话鉴权,而 `/ext/<id>/*` 是**刻意**在鉴权外的。
	 * **现取**,不缓存:面板每问一次,宿主叫一次这个回调。
	 *
	 * 🔴 回调要**同步**交回视图。交回 Promise(`async` 回调就是这样)宿主当场报错 —— 那一口画成
	 * 一条「publishView 的回调要同步交回视图」的提示,不会静默变成一份空视图;要等的东西自己先算好
	 * 存着,变了喊一声 {@link statusChanged}。
	 *
	 * 宿主先校验再画,不合规矩的**按块 / 按项**降级(决策 40):页上坏一块只换掉那一块,列表坏一项
	 * 那张卡写「状态未知」,摘要坏了就不画 —— 每一处都点名哪儿、为什么,日志里也记一行。
	 */
	publishView(fn: () => ExtensionView): void;
	/**
	 * **v1 的老口**:交任意 JSON,宿主原样下发(v1 的页是手写的,形状归它自己)。
	 *
	 * ⛔ v2 拓展叫它,宿主不受理(记一行日志)—— 它对 `async` 回调会静默交出一份空视图,v2 走
	 * {@link publishView}。
	 */
	publishStatus(fn: () => unknown): void;
	/**
	 * 交上去的那份数据**变了**,喊一声。`publishView` / `publishStatus` 是现取的,盲点在「什么时候该再取」:
	 * 桥那头刚握完手,面板上那张卡还灰着,得切一下页才刷新。宿主把这一声推到面板(WS
	 * `state` 频道),面板当场重取 `/api/ext/<id>/status` 与 bot 名单。什么算「变了」由
	 * 拓展自己定 —— 桥:一条接入连上 / 断开。
	 *
	 * 放心连喊:宿主**按拓展合并**,一个短窗口(四分之一秒)里的连喊只推一次,落在窗口的尾沿 —— 最后
	 * 那一喊之后一定还有一次,面板重取到的是它之后的样子。拓展不用自己攒。
	 */
	statusChanged(): void;
	/**
	 * 自己的持久设置(见 {@link ExtensionSettings})。交一份 zod 进来,拿回一个现读的把手。
	 * 可以叫多次,每次都是同一份数据的一个视图。
	 *
	 * v2 拓展的这份 zod 要与清单里的 `settings.fields` 对得上(键、类型、默认值),对不上
	 * 当场抛 —— 面板照清单画表单、宿主照 zod 解,两份漂开就是「填了存不进去」。清单声明了设置项的
	 * v2 **必须在 `activate` 里交**(ADR-0019 决策 35):面板写进来的值要再过它这一道,不交按加载失败算。
	 *
	 * 存着的那份过不了这份 zod 也当场抛(ADR-0019 决策 36)—— 别接住了接着往下起:宿主认的是它自己
	 * 记下的那一笔,接住了也照样不起,面板上是「设置读不了」,主人改对了宿主会再起它一次。
	 */
	settings<T>(schema: ZodType<T>): ExtensionSettings<T>;
	/**
	 * 接面板上的一个「调拓展」按钮(ADR-0019 决策 22 / 42)。`name` 必须在清单的 `actions`(一串动作名)
	 * 里声明过 —— 清单是面板能按哪些钮的全集,没声明的注册当场抛;同一个名字接两次也抛。
	 *
	 * 面板经 `POST /api/ext/<id>/actions/<name>` 调(走面板会话鉴权)。抛出来的错**原话**给到面板;
	 * 30 秒没回按超时算。界面该跟着变的话,自己叫一声 `statusChanged()`。卸载时自动摘掉。
	 *
	 * 🔴 `signal` 在两种时候中止,handler 要听它、手上的请求 / 轮询接着它停:
	 * - **超时**(`reason` 是 `TimeoutError`):宿主已经回了面板一句「超时」,再接着跑下去,做完的事主人
	 *   看不见(扫码登录会在背后多存下一份账号);
	 * - **拓展停用 / 收摊**(`AbortError`):在 `onDispose` 的钩子跑之前就中止了,钩子里可以等它们收尾。
	 *
	 * 同一个动作在跑时再按,宿主直接回面板「还在跑」(409),不排队、不并发 —— 「在跑」算到 handler
	 * 真的回来为止:超时叫停了却不停的,照样挡着下一发。不同的动作互不相干。
	 */
	onAction(name: string, handler: (signal: AbortSignal) => void | Promise<void>): void;
	/** 卸载时要跑的收摊钩子。后注册的先跑。 */
	onDispose(fn: () => void | Promise<void>): void;
}
