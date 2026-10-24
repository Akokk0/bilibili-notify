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
 * 破的两例:造结果的 `ok()` / `fail()`(ADR-0026 决策 6)与造中性平台描述的
 * `neutralPlatformDescriptor()`(ADR-0024 决策 4)—— 都是不带状态的纯函数,
 * 拷一份进拓展包不会与宿主那份打架。
 *
 * ⛔ 一格都别多给:`ExtensionRuntime`(谁来收摊)、`ExtensionMounts` / `ExtensionUpgrades`
 * (两张宿主的分发表)、`InboundHandlers`(绕过归属校验的那条管子)刻意都不在这儿 ——
 * **契约的宽度是不可逆的**(决策 13),窄面加宽容易,反过来不行。
 */

/**
 * 实现推送源用得着的域类型 —— `send` / `probe` / `reconcile` 的签名就是拿它们拼的。
 *
 * ⛔ 域模型的其余部分(globals / subscriptions / 订阅与推送的落盘形状……)**刻意不转** ——
 * 拓展碰不着配置的写路径,那条路在这仓里只有一条。
 */
export type {
	CapabilitySupport,
	Connection,
	ConnectionCandidate,
	ConnectionCapabilities,
	CreatorCandidate,
	CreatorProfileReport,
	DeliveryResult,
	DestinationRef,
	Disposable,
	Failure,
	FailureCode,
	FeatureKey,
	/** `ctx.http` 的请求选项(对外那份,不含宿主自用的拦内网口)。 */
	FetchOptions,
	/** 重定向时即将发出的一跳,`beforeHop` 的参数。 */
	Hop,
	HopHandler,
	/** 每个集成一个的请求客户端(`ctx.http`)。 */
	HttpClient,
	HttpResponse,
	Identity,
	ImageRef,
	InboundGroupMessage,
	InboundMeta,
	InboundPrivateMessage,
	/**
	 * 每个集成(内置的、拓展的)拿到的公共那一面。`ExtensionContext` 继承它:新成员加在它身上,
	 * 拓展当场就有,类型逼着宿主那头一并接上。
	 */
	IntegrationContext,
	Json,
	KeyValueOp,
	KeyValueStore,
	Logger,
	NotificationPayload,
	PayloadSegment,
	/**
	 * 推送源契约 —— 一个出口长什么样。核心的 onebot / 官机 / webhook 与每个推送拓展实现的
	 * 都是这一套,所以它的本体住 `@bilibili-notify/internal`;这里转出来给拓展用。
	 */
	PlatformAdapter,
	PlatformAdapterContext,
	PlatformDescriptor,
	ProbeResult,
	PushTarget,
	PushTargetScope,
	Result,
	/**
	 * 一个集成读自己设置的把手。拓展的 `ctx.settings(schema)` 回的就是它(与内置集成同一个口)。
	 */
	SettingsReader,
	SourceHealth,
	SourceSubscriptionView,
	WebSocketLike,
	WebSocketOptions,
} from "@bilibili-notify/internal";
/**
 * 造结果的两个函数(ADR-0026 决策 6)。`send` / `probe` 回的 `DeliveryResult` / `ProbeResult`
 * 就是 `Result`,一律拿它们造,不手写 `{ ok: false, … }`。
 */
export { fail, ok } from "@bilibili-notify/internal/constants";
/** `ctx.i18n.t` 的占位符取值;`count` 同时决定挑哪个单复数类别。只转类型。 */
export type { TextValues } from "@bilibili-notify/internal/i18n";
/**
 * 造「认不出的平台」用的中性平台描述(3b-40,ADR-0024 决策 4):连接候选里的 `platform` 拓展自己造,
 * 不必抄一份取值。第二处运行时值,理由同 `ok` / `fail`。
 */
export { neutralPlatformDescriptor } from "@bilibili-notify/internal/platform-descriptor";

/**
 * 面板也要认的那几个形状住零依赖子入口 `./wire`(理由见那个文件的文件头),这里**转出来**
 * —— 拓展照旧只认这一扇门,不必知道有过这么一次拆分。
 */
export type {
	ExtensionBlock,
	ExtensionButton,
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
	SourceContext as CoreSourceContext,
	CreatorCandidate,
	CreatorProfileReport,
	Disposable,
	FailureCode,
	Identity,
	ImageRef,
	IntegrationContext,
	Logger,
	PlatformAdapter,
	Result,
	SettingsReader,
	SourceHealth,
} from "@bilibili-notify/internal";
import type { TextValues } from "@bilibili-notify/internal/i18n";
import type { ZodType } from "zod";
import type { ExtensionView } from "./wire";

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
	/**
	 * 行为。⚠️ 它自报的 `adapterKey` **会被宿主覆盖**成这个拓展的 id;`settingsSchema` 由宿主拿
	 * `configSchema` 填,所以这里不用(也不能)自己交。`listAddressCandidates` 与 `connectionAuth`
	 * 不对拓展开放(ADR-0024 决策 11),类型上排除。
	 */
	adapter: Omit<PlatformAdapter, "settingsSchema" | "listAddressCandidates" | "connectionAuth">;
	/**
	 * config 的校验。宿主拿它解连接,解不出的那条根本不交给拓展;注册那一刻还拿它与清单里的
	 * 连接配置项逐格对表(键、类型、默认值),对不上直接抛(ADR-0019 决策 17)。
	 */
	configSchema: ZodType<TConfig>;
}

/** 一条属于这个拓展的连接 —— config 已经解成它自己的形状。 */
export interface ExtensionConnectionView<TConfig> {
	id: string;
	name: string;
	/** 主人有没有停用这条。**停用的也在名单里** —— 拓展要拿它答「这条为什么发不出去」。 */
	enabled: boolean;
	config: TConfig;
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
 * 上报卡上的创作者。这里只开放名字与图库引用;没有带的那一样由宿主按订阅资料补。
 */
export interface SubscriptionCreator {
	/** 1–128 字。 */
	name?: string;
	/** 图库引用;不是平台图片地址。 */
	avatar?: ImageRef;
}

/** 正文片段与中立 `RichText` 同形,契约只开放这五种。 */
export type RichTextSegment =
	| { kind: "text"; text: string }
	| { kind: "mention"; text: string; userId?: string }
	| { kind: "topic"; text: string; name: string }
	| { kind: "link"; text: string; url: string; icon?: ImageRef }
	| { kind: "emoji"; text: string; image?: ImageRef };

/** 作品正文的片段列表;片段的 `text` 拼起来必须等于正文 `text`。 */
export type RichText = RichTextSegment[];

/**
 * 来源交的一条作品。作品 id 与地址在信封上,内容在中立 `Post` 的同名位置。
 *
 * 不开放标题、文章、转发、附加块、锁、提醒、会员标记等格。图一律交图库引用;
 * `publishedAt` 是毫秒时间戳,宿主进门时换成 ISO。
 */
export interface PostReport {
	/** 平台自己的作品 id。 */
	postId: string;
	/** 作品地址。 */
	url: string;
	post: {
		/** 出卡优先用这里的创作者;缺的格由订阅资料补。 */
		creator?: SubscriptionCreator;
		/** 发布时刻,毫秒。 */
		publishedAt: number;
		/** 正文,必交。 */
		text: string;
		/** 正文片段;给了就要与 `text` 对得上。 */
		richText?: RichText;
		/** 作品图,图库引用。 */
		images?: ImageRef[];
		/** 话题名,不带 `#`;第一个上卡。 */
		topic?: string;
		video?: {
			cover?: ImageRef;
			title?: string;
			description?: string;
			/** 时长,秒。 */
			durationSec?: number;
			views?: number;
		};
		stats?: {
			likes?: number;
			comments?: number;
			shares?: number;
		};
	};
}

/**
 * 一场直播的内容;与核心的 `LiveDetails` 同义同名。差别只在拓展这一侧:`cover` 是图库引用,
 * `creator` 是 {@link SubscriptionCreator}。
 */
export interface LiveDetails {
	creator?: SubscriptionCreator;
	title?: string;
	cover?: ImageRef;
	category?: string;
	url?: string;
	/** 此刻在线人数。 */
	currentViewers?: number;
	/** 本场累计观看人数。 */
	totalViewers?: number;
	likes?: number;
	description?: string;
}

/**
 * 来源推送式上报的一场直播变化。时刻都是毫秒;下播可以不交 `endedAt`,宿主取到达那一刻。
 */
export type LiveSignalReport =
	| { kind: "start"; startedAt?: number; details: LiveDetails }
	| { kind: "status"; isLive: boolean; startedAt?: number; details: LiveDetails }
	| {
			kind: "end";
			endedAt?: number;
			startedAt?: number;
			details?: LiveDetails;
	  };

/**
 * 来源拉取式直播状态。时刻都是毫秒;失败回标准结果形状,不抛。
 */
export type LiveStatusResult =
	| { ok: true; kind: "live"; startedAt?: number; details: LiveDetails }
	| { ok: true; kind: "offline" }
	| { ok: false; code: FailureCode; message: string };

/** 注册完一个订阅源之后拿到的唯一把手:注销这个来源。 */
export interface SourceHandle {
	/** 注销来源;幂等,调用后来源不再上报。 */
	dispose(): void;
}

/**
 * 拓展拿到的订阅源上下文:与核心那一份同一套名单、请求与收尾口,
 * 只开放作品、直播、资料三种上报。上报返回 `void`,被拒也不回话。
 */
export interface SourceContext
	extends Omit<
		CoreSourceContext,
		| "reportPost"
		| "reportLive"
		| "reportLiveInteraction"
		| "registerLinkResolver"
		| "registerAiToolProvider"
	> {
	/** 交一条作品。没有返回值;图和时刻按拓展契约交。 */
	reportPost(externalId: string, report: PostReport): void;
	/** 交一条直播信号。没有返回值;`status` 不触发推送。 */
	reportLive(externalId: string, report: LiveSignalReport): void;
	/** 交一份创作者资料。没有返回值;停用的订阅不收。 */
	reportProfile(externalId: string, report: CreatorProfileReport): void;
}

/**
 * 订阅源代码那一半。清单负责外观与能力声明;这里的成员按表拿,未开放的成员即使给了也不认。
 */
export interface SourceDef {
	/**
	 * 启动来源。拿到名单与三种上报口;这里可以同步返回,也可以回 Promise。
	 * `stop()` 之后不许再上报。
	 */
	start(ctx: SourceContext): void | Promise<void>;
	/** 停下来源。宿主先叫它,再中止 `ctx.signal` 并跑收尾钩子。 */
	stop(): void | Promise<void>;
	/**
	 * 搜人:输入可以是链接、id 或名字,原样交进来。最多回 10 个候选;
	 * 查无此人是成功的空数组,失败回结果形状、不抛。`signal` 中止后应尽快收手。
	 */
	searchCreators(
		query: string,
		signal: AbortSignal,
	): Promise<Result<{ candidates: CreatorCandidate[] }>>;
	/**
	 * 取一个人的资料。可选;不实现就靠 `ctx.reportProfile` 主动上报。
	 * 失败回结果形状、不抛,`signal` 中止后应尽快收手。
	 */
	fetchProfile?(identity: Identity, signal: AbortSignal): Promise<Result<CreatorProfileReport>>;
	/**
	 * 此刻这个人在不在播,时刻按毫秒交。声明了周期直播必须实现它,否则拓展装不上。
	 * 不实现就只靠 `ctx.reportLive` 推送式上报。
	 */
	fetchLiveStatus?(identity: Identity, signal: AbortSignal): Promise<LiveStatusResult>;
	/** 此刻的健康状况,同步、不出网。不交就不占状态行。 */
	health?(): SourceHealth;
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
//   字符串超长)只丢那一格,其余照收 —— 丢了什么、为什么,记在日志与拓展详情页的「上报出入」里。
// - 例外:作品正文(`text`,10000 字)与视频标题(`video.title`,256 字)超长**不丢**,截到上限收下(截在字符
//   边界上,不把一个 emoji 劈成两半),「上报出入」里同样记一句「已截断」—— 关键词屏蔽、出卡、点评看的都是
//   截下来的那一段。「字」按 JS 字符串的 `length` 数(一个 emoji 算两个)。

/**
 * 卡上的作者(决策 54):都选填,出卡优先用这里的,没带的那一样用订阅资料。**不改资料** —— 订阅页的
 * 名字 / 头像只认来源上下文上的 `reportProfile`。
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
	/** 超过 256 字截到 256 字收下(不丢)。 */
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
 * 不收:转发(嵌套原作品)、富文本(表情图 / @ 高亮)、附加卡(预约 / 商品 / 投票)、充电专属、
 * 弹幕数、大会员标记。话题走 {@link SubscriptionPost.topics}。
 */
export interface SubscriptionPost {
	/** 平台自己的作品 id,原样存。 */
	id: string;
	/** 作品的链接,http(s)。 */
	url: string;
	/** 发布时刻,毫秒。 */
	publishedAt: number;
	/** 正文,纯文本,保留换行。超过 10000 字截到 10000 字收下(不丢)。 */
	text?: string;
	/** 作品图:png / jpeg / webp / gif,单张 8 MiB、最多 30 张;宽高由 BN 读。 */
	images?: readonly Uint8Array[];
	/**
	 * 话题名,**不带 `#`**(带了也行:两头的 `#` 与空白 BN 先剥掉)。
	 *
	 * - **第一个**上卡,当正文上方那一行话题标签(同 B 站动态卡的话题);
	 * - 正文里出现的 `#名字#` / `#名字` 画成话题的颜色 —— BN **只照这里报的名字**去正文里找,不自己按 `#`
	 *   猜(「C#」「#1」不是话题)。名字在正文里找不到的,只进标签(若是第一个)、不上色;
	 * - 每个 1–64 字、最多 20 个,坏的那一项(剥完是空的、超长)只丢那一项;重复的 BN 去掉。
	 */
	topics?: readonly string[];
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
	/**
	 * **此刻在线**人数(非负整数)—— 「直播中」那张卡的人气格用它。平台只有累计观看的话就不报这一格,
	 * 别拿累计冒充。
	 */
	viewers?: number;
	/**
	 * **本场累计观看**人数(非负整数)—— 与 B 站的「累计观看」同一个口径:下播卡、「正在直播」文案、
	 * 首页「正在直播」那一列用它。平台只有此刻在线的话就不报这一格。
	 */
	totalViewers?: number;
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
 * 拓展取自己包里译文的口(`ctx.i18n`,ADR-0037 决策 14)。译文放在包里的 `locales/<语言码>.json`,
 * 宿主在读目录时读好;拓展没带译文也照样有这一格,`t` 回键本身。
 *
 * 语言整台一种、由主人在面板上选;取字时读当前那一种,所以**别把 `t` 的结果存起来用**。
 * 口吻不交给拓展:这里只有平实一层,没有女仆层。
 */
export interface ExtensionI18n {
	/**
	 * 当前语言,**现读**。是 `string` 而不是一个固定的语言码表:宿主以后加了新语言,不该在类型上
	 * 就把旧拓展挡在外面。
	 */
	locale(): string;
	/**
	 * 按键取字。占位符写 `{名字}`,从 `values` 里填;`values.count` 是数字时按当前语言挑单复数类别
	 * (译文里写成 `键#one` / `键#other` …)。
	 *
	 * 回落链固定:当前语言 → 简中 → 英文 → 键本身,**按句**回落 —— 当前语言缺哪一句,只那一句落到后面。
	 * 缺键回键本身(露出来好查),不抛。
	 */
	t(key: string, values?: TextValues): string;
	/**
	 * 当前语言**真的换了**时叫(只换了口吻不叫)。换了语言以后 `t` 取到的就是新语言。
	 * 视图是现取的,宿主已经替每个在跑的拓展喊过一次「面板数据变了」,面板会自己重取 ——
	 * 拓展**不用自己再喊** `statusChanged()`;只有自己缓存了译文算出来的东西时,才在这里重算。
	 * 卸载时自动摘掉。
	 */
	onChange(fn: () => void): Disposable;
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
export interface ExtensionContext extends IntegrationContext {
	/** 它自己的 id —— 同时是挂载点、装载目录与记账键那一段。 */
	readonly id: string;
	/** 宿主**当前**的契约档位(它认的区间的上沿)。拓展自己也可能要按它分叉。 */
	readonly hostApiVersion: number;
	/**
	 * 独立端自己的版本号(载荷版本)。**与契约版本是两件事** —— 那个决定「加不加载」,
	 * 这个是拿去报给对家看的(桥在 `welcome` 帧里把它告诉插件)。
	 */
	readonly hostVersion: string;
	/**
	 * 行的标签就是拓展的 id(面板日志页按它筛),正文里不用也不会再带 id。日志等级跟日志设置里它自己的那一格
	 * (`logging.levels.<id>`),没写就跟总等级。
	 */
	readonly logger: Logger;
	/** 自己包里的译文与当前语言,见 {@link ExtensionI18n}。只挂拓展的上下文,不在 `IntegrationContext` 上。 */
	readonly i18n: ExtensionI18n;
	// 继承自 IntegrationContext、这里不重写的:`signal`(拓展停用时中止)、`state` / `secrets`(与推送源
	// `start(ctx)` 里拿到的是同一对)、`onDispose`(卸载时要跑的收摊钩子,后注册的先跑)、
	// `reportProblem` / `resolveProblem`(报的人是自己的 id,停用时宿主替它清)。
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
	 * **分发键由宿主按 id 填**,`adapter.adapterKey` 自报的那份会被覆盖:自报的话,一个
	 * 拓展可以声明 `"onebot"` 把内置那条连接的推送整个截走。归属是宿主的判断。
	 *
	 * 清单没开推送源那一口(`contributes.push`)会抛。
	 */
	registerPushSource<TConfig>(def: PushExtensionDef<TConfig>): PushSourceHandle<TConfig>;
	/**
	 * 注册这个拓展的订阅源(第 3 版形状)—— 一个拓展就是一个平台,**只许登一次**,再登会抛。
	 *
	 * 清单得开了 `contributes.subscription`,否则抛。`def.start(ctx)` 拿到与核心来源同一套的上下文
	 * ({@link SourceContext}),三种上报都在 `ctx` 上;交回的把手只管注销。
	 *
	 * 🔴 登记是**异步**的:这里同步交回把手,宿主在后台等 `start` 落定;`start` 抛了,这一次加载就失败
	 * (原因进拓展列表),与推送源的 `start` 抛了同一个结局。停用 / 卸载时宿主替它撤登记
	 * (先叫 `stop()`,再中止 `ctx.signal`);把手的 `dispose()` 幂等。
	 */
	registerSource(def: SourceDef): SourceHandle;
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
	 * 交上去的那份数据**变了**,喊一声。`publishView` 是现取的,盲点在「什么时候该再取」:
	 * 桥那头刚握完手,面板上那张卡还灰着,得切一下页才刷新。宿主把这一声推到面板(WS
	 * `state` 频道),面板当场重取 `/api/ext/<id>/status` 与 bot 名单。什么算「变了」由
	 * 拓展自己定 —— 桥:一条接入连上 / 断开。
	 *
	 * 放心连喊:宿主**按拓展合并**,一个短窗口(四分之一秒)里的连喊只推一次,落在窗口的尾沿 —— 最后
	 * 那一喊之后一定还有一次,面板重取到的是它之后的样子。拓展不用自己攒。
	 */
	statusChanged(): void;
	/**
	 * 自己的持久设置 —— 主人在面板上给**这个拓展**填的那些(桥的接入名单就住这儿),落盘在
	 * `config/settings/extensions/<id>.json`,**形状归拓展自己那份 zod**,宿主只保证存得住。交一份
	 * zod 进来,拿回一个现读的 {@link SettingsReader}(与内置集成读自己的设置是同一个口)。
	 * 可以叫多次,每次都是同一份数据的一个视图。(签名继承自 `IntegrationContext.settings`,这里同签名重写
	 * 只为写拓展专属的说明;推送源 `start(ctx).settings` 与它是同一份实现。)
	 *
	 * 与连接是两回事:连接是「一个 bot」,是宿主认识、推送目标能挂上去的东西;设置是拓展
	 * 为了拿到那些 bot 而需要主人填的东西(token、对家的名字……),宿主一格都不认识。
	 * ⛔ **没有写口** —— 配置的写路径在这仓里只有面板那一条(决策 30 同一条纪律)。
	 *
	 * `get()` 回 `Result<{ settings }>`、**不抛**:
	 * - 没设过:拿空对象过这份 zod。过得了是成功并带默认值,过不了回 `not_configured`(拓展照跑,
	 *   等主人填);
	 * - 带异步规则、交进来那一刻判不完:回 `unavailable`,等一拍再读;
	 * - **跑着时**存着的那份被旁路写坏(恢复备份、手改文件):回 `invalid`、带原因,并叫一次 `onChange`
	 *   —— 宿主随后把拓展收掉(ADR-0019 决策 36)。这一拍里别把 `invalid` 当成空设置:桥的做法是记着
	 *   上一份好的名单。
	 *
	 * v2 拓展的这份 zod 要与清单里的 `settings.fields` 对得上(键、类型、默认值),对不上
	 * 当场抛 —— 面板照清单画表单、宿主照 zod 解,两份漂开就是「填了存不进去」。清单声明了设置项的
	 * v2 **必须在 `activate` 里交**(ADR-0019 决策 35):面板写进来的值要再过它这一道,不交按加载失败算。
	 *
	 * 🔴 **只有 `activate` 期间**存着的那份过不了这份 zod 会当场抛(ADR-0019 决策 36)—— 别接住了接着
	 * 往下起:宿主认的是它自己记下的那一笔,接住了也照样不起,面板上是「设置读不了」,主人改对了宿主会
	 * 再起它一次。
	 */
	settings<T>(schema: ZodType<T>): SettingsReader<T>;
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
}
