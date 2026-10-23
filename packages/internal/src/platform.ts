import type { ZodType } from "zod";
import type { AuthState } from "./auth-state";
import type { Identity, ImageRef, PushTargetScope, Result } from "./constants";
import type { HttpClient } from "./http";
import type { KeyValueStore } from "./key-value-store";
import type { LiveSessionChange } from "./live";
import type { PostEvent, PostImage } from "./post";
import type { AddressCandidate, ProbeResult } from "./push-source";
import type { HistoryEntry } from "./schema/history";
import type { SubscriptionReportDelivery } from "./schema/subscription-report";
import type { Subscription } from "./schema/subscriptions";
import type { PushTarget, SessionRef } from "./schema/targets";

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
 * 关停分四段，按这个先后跑:
 * - `stop`:停生产者(来源、拓展、定时任务),之后不再有新活进来
 * - `drain`:排空 HTTP 在途请求
 * - `flush`:先等 {@link ServiceContext.track} 登记的后台活落定，再让各写道落盘并关门
 * - `dispose`:其余收尾(浏览器、连接之类);不写段的 `onDispose` 都在这
 */
export type DisposePhase = "stop" | "drain" | "flush" | "dispose";

/**
 * Service runtime 上下文 —— 业务代码不直接吃任何宿主框架的 Context。
 * - logger：日志门面
 * - signal:关停一开始(`stop` 段之前)就中止;手上的请求、轮询接着它停
 * - setInterval / setTimeout：返回 Disposable，dispose 后停止
 * - onDispose：按 {@link DisposePhase} 分段登记收尾钩子，同一段里后登记的先跑
 * - track:登记一件发出去不等的后台活，关停时在 `flush` 段之前等它落定
 */
export interface ServiceContext {
	readonly logger: Logger;
	readonly signal: AbortSignal;
	setInterval(fn: () => void, ms: number): Disposable;
	setTimeout(fn: () => void, ms: number): Disposable;
	onDispose(fn: () => void | Promise<void>, phase?: DisposePhase): void;
	/**
	 * 「发出去不管」的写入一律经这里登记，关停时才等得到它 —— 否则它会在关停返回以后才落进数据目录。
	 * 它失败了不挡关停。调用方该自己 `.catch` 记下原因;没接住的，这里记一条 error,不静默吞掉。
	 */
	track(task: Promise<unknown>): void;
}

/** 一个集成读自己设置的把手:交一份 zod 进来,拿回它。 */
export interface SettingsReader<T> {
	/**
	 * 此刻这一份。读得懂回过了那份 zod 的值;读不懂回 `invalid`,`issues` 里是逐条原因
	 * (整个设置文件读不懂时只有一条、不带 `path`)。**不抛**,`start` 里与运行中都一样。
	 */
	get(): Result<{ settings: T }>;
	/** 这一份「变了」才叫:值变了,或读得懂与读不懂之间翻了。别的集成的设置动了不叫。 */
	onChange(fn: () => void): Disposable;
}

/**
 * 每个集成(拓展、内置集成)拿到的那一面:日志、停下信号、收尾钩子、两份小存储、日志打码登记、问题上报、
 * 读自己的设置。成员后面各片还会往上加。
 * 宿主握着的另一面(收回它的把手)住服务端,集成拿不到。
 */
export interface IntegrationContext {
	readonly logger: Logger;
	/** 集成停下(停用、卸载、关停)时中止;在收尾钩子跑之前就已经中止。 */
	readonly signal: AbortSignal;
	/** 收尾钩子,后登记的先跑。停下之后再登记不生效,记一行。 */
	onDispose(fn: () => void | Promise<void>): void;
	/** 程序自己记的小状态:明文,不进备份。单键 64KB、整份 1MB;`http.` 开头的键归宿主。 */
	readonly state: KeyValueStore;
	/** 凭据:主密钥加密,只进完整备份。整份 256KB;`http.` 开头的键归宿主。 */
	readonly secrets: KeyValueStore;
	/**
	 * 登记一个**还没存进 `secrets`** 的临时凭据(比如扫码刚拿到的令牌),日志按值把它遮成 `***`。
	 * 一次登记一个,只增不减,直到集成停下(宿主那时撤掉);连续登记不会互相冲掉。存进 `secrets` 的值、
	 * cookie 罐里的每条 cookie 一到就自动登记,不用再登记。少于 8 个字符的值不遮;空串、不是字符串的忽略;
	 * 停下之后再登记不生效。
	 */
	redact(value: string): void;
	/**
	 * 报一个这个集成自己的问题(对面连不上……)。句子写平实、只说事:不称呼主人、不自称女仆、不写宿主的界面
	 * 与操作;私聊时宿主按口吻补完整。有登录口的来源不要报登录,宿主看登录状态报与清。
	 * `code` 是 snake 风格,同一个集成下同一个
	 * code 只有一条,再报只换文案(与 `notify`、`recoveryMessage`)。`notify: true` 请核心私聊主人一次。
	 * 没有返回值;形状不对(含空白的 `message` / `recoveryMessage`)、集成已停下的上报被丢弃。
	 * 平台的数字码写进 `message`,不占 `code`。
	 *
	 * `recoveryMessage`:这件事清掉、且当初真私聊过时核心发的那一句;不给就用宿主带名字的通用说法。
	 * 集成停下时它报的全清(核心清的,不补「已恢复」)。
	 *
	 * ⚠️ 方法写法(不是属性函数):子层(来源、适配器)同名方法多带一格对象,靠的是方法参数的双变。
	 */
	reportProblem(problem: {
		code: string;
		message: string;
		notify?: boolean;
		recoveryMessage?: string;
	}): void;
	/**
	 * 清掉自己报的一个问题。清掉时核心对当初私聊过的补一句「已恢复」;`notify: false` = 这次不是修好了、
	 * 只是不再适用,不补。表里没有这一条什么都不做。
	 */
	resolveProblem(problem: { code: string; notify?: boolean }): void;
	/**
	 * 读这个集成自己的设置(`config/settings/<集成键>.json` 那一段)。可以交多份 zod,各读各的格(zod 的
	 * 对象默认剥掉不认识的键);没设过的拿空对象过规则:过得了是成功并带默认值,过不了回 `not_configured`。
	 * 把手随集成停下自动收掉(来源与适配器的上下文里,订阅还随来源 / 适配器停下摘掉),不必在 `stop()` 里记得摘。
	 */
	settings<T>(schema: ZodType<T>): SettingsReader<T>;
	/**
	 * 这个集成自己的请求客户端:身份与 cookie 罐都是它自己的(宿主管着存与升),集成之间互不相干。
	 * `fetch` 非 2xx 不抛、失败回结果形状;`websocket` 随集成停下自动关(`fetch` 不跟着断,在途的请求由调用方的
	 * `signal` 管)。不拦内网(局域网里的 RSSHub 要连得上),拦内网只在 {@link IntegrationContext.fetchImage} 上。
	 */
	readonly http: HttpClient;
	/**
	 * 把一张远端的图抓进图库,回引用。走 {@link IntegrationContext.http} 同一个客户端(同一套身份与 cookie),
	 * 平台要的头(Referer、签名)由这次传。每一跳都拦内网;单张 8 MiB、按内容嗅探(只认 png / jpg / gif / webp)。
	 * 失败的码:`invalid`(地址不对、内网、太大、不是图、其余 4xx)、`unauthorized`(401 / 403)、`not_found`(404 / 410)、
	 * `rate_limited`(429)、`timeout`、`unavailable`(连不上、5xx、磁盘写失败)、`indeterminate`(调用方中止)。
	 * 只攥在集成自己手里、没交给宿主的引用,过了 24 小时的宽限期不保。
	 */
	fetchImage(
		url: string,
		options?: { headers?: Record<string, string>; signal?: AbortSignal },
	): Promise<Result<{ ref: ImageRef }>>;
	/** 手里已经是字节的图存进图库,回引用。同一套嗅探与 8 MiB;留存的规矩同 {@link IntegrationContext.fetchImage}。 */
	storeImage(
		bytes: Uint8Array,
		options?: { signal?: AbortSignal },
	): Promise<Result<{ ref: ImageRef }>>;
}

/**
 * 订阅变更操作。CRUD 产生的 diff 列表，随 subscription-changed 事件携带。
 *
 * `remove` 带着**被删掉的那一整条**。下游引擎（DynamicPoller / LiveEngine）按 B 站 UID
 * 索引 listener / poll target，得拿到 uid 才清得掉资源 —— 但拓展订阅没有 uid(ADR-0019
 * 决策 9),所以这里不再单拎一个 `uid: string`:那样拓展订阅只能填个空串,下游照样拿它
 * 去清,编译器一声不吭。带整条订阅,消费方按 `kind` 收窄之后才读得到 uid。
 */
export type SubscriptionOp =
	| { kind: "add"; sub: Subscription }
	| { kind: "remove"; sub: Subscription }
	| { kind: "update"; sub: Subscription };

/**
 * 总线的事件表:事件名 → 载荷。业务核心唯一事件源,独立端 WS channel 都源自这里。
 *
 * 载荷一律是一个具名对象(没有载荷的写 `undefined`):`bus.emit("engine-error", { source, message })`、
 * `bus.on("engine-error", ({ source, message }) => …)`。不用位置参数 —— 加一格不会挪动别的格,
 * WS 帧的 `data` 也能直接从这里推导(`apps/contract` 的事件表),面板不用再手写类型断言。
 */
export interface BusEvents {
	"auth-lost": undefined;
	"auth-restored": undefined;
	"subscription-changed": { ops: SubscriptionOp[] };
	/**
	 * 一个来源的登录状态或账号变了(宿主订阅 `Source.auth.onChange` 后发)。载荷只有来源键与此刻的状态:
	 * 账号(名字、头像)走 `GET /api/sources/:sourceKey/auth` 读,密钥与 cookie 永远不在里面。
	 */
	"subscription-auth-changed": { sourceKey: string; state: AuthState };
	/**
	 * Surface a runtime error from a business engine / subsystem.
	 * `source` 是逻辑发射源标识(e.g. "post-delivery" / "live-engine" / "image" / "ai")
	 * 用于消费方（master-notifier / AlertShell）做按域节流与展示。
	 */
	"engine-error": { source: string; message: string };
	ready: undefined;
	"config-changed": { scope: ConfigScope };
	/**
	 * 某个拓展喊了「面板数据变了」(`ctx.statusChanged`)。载荷只有拓展 id:面板按 id 失效
	 * `/api/ext/<id>/status` 与 bot 名单的缓存、自己去取,数据本身不上 bus。
	 */
	"extension-status-changed": { extensionId: string };
	/**
	 * 某个拓展的设置经 `/api/ext/<id>/settings` 写进去了(ADR-0019 决策 35)。载荷只有拓展 id:
	 * 面板按 id 失效它的设置与视图、自己去取 —— 设置里有密钥,数据本身不上 bus、不进帧。
	 * 这是宿主自己知道的事实,不替拓展判它的视图变没变(那是 `extension-status-changed`)。
	 */
	"extension-settings-changed": { extensionId: string };
	/**
	 * 某个订阅源拓展的「上报出入」(ADR-0019 决策 60:丢格、整条拒)新记了几条。载荷只有拓展 id,**按拓展
	 * 合并过**(`REPORT_DISCREPANCIES_CHANGED_COALESCE_MS`)。独立端转成 `state` WS channel 的同名帧,面板只让
	 * 拓展表失效 —— 那个框住在拓展表的那一行上。
	 *
	 * 不借 `extension-status-changed`:那一声说的是「拓展的视图变了」,借了的话桥每喊一次都要多拉一遍拓展表。
	 */
	"extension-report-discrepancies-changed": { extensionId: string };
	/**
	 * 问题表里某个报的人名下的问题变了(开了、换了文案、清了)。载荷只有报的人(集成键或 `"core"`),**按报的人
	 * 合并过**(`PROBLEMS_CHANGED_COALESCE_MS`)。独立端转成 `state` WS channel 的同名帧;面板据此让
	 * `GET /api/problems` 过期、自己去取,数据本身不上 bus。
	 */
	"problems-changed": { reporter: string };
	/**
	 * 订阅源拓展报上来一条、宿主核过形状、对上了它名下的订阅(ADR-0019 决策 7 / 57 / 62)。五种都走这一个
	 * 事件,按 `report.kind` 分:三种事件(`post` / `liveStart` / `liveEnd`)与两种不触发推送的上报
	 * (`profile` / `liveStatus`)。
	 *
	 * `subscriptionIds` 已经按开关筛过:事件与直播状态只含开着的订阅,资料更新含全部(见
	 * {@link SubscriptionReportDelivery})。一条都对不上就不发。
	 *
	 * 🔴 载荷里的图是字节(`Uint8Array`),**不进 WS 帧**、不落盘 —— 出卡、存头像这些消费方自己取用。
	 */
	"subscription-reported": SubscriptionReportDelivery;
	/**
	 * 拓展报的资料更新(ADR-0019 决策 7 / 62)落进资料缓存与图库里的头像之后,面板看得见的那几格(名字 /
	 * 头像 / 粉丝数)真变了的订阅 id。**按窗口合并过**:拓展起来时可能一口气报一百条资料,一阵只发一次。
	 *
	 * 独立端转成 `state` WS channel 的同名帧,面板据此重取订阅列表。🔴 **不发 `config-changed
	 * "subscriptions"`**:那一档会重建路由表、通知拓展「名下订阅变了」、让引擎 reconcile —— 资料缓存
	 * 不是配置,那些全是白干。
	 */
	"subscription-profiles-changed": { subscriptionIds: string[] };
	/**
	 * 历史仓建起一行(一次推送 × 一个目标,本体落地那一刻)后立刻 emit。
	 * 载荷是完整 entry,WS push-events 直接转发给前端做 toast/通知,
	 * 无需前端再二次 fetch detail。
	 */
	"history-recorded": HistoryEntry;
	/**
	 * 同一次推送的后续消息(词云 / 总结 / 图集 / @全体)追加到已有那一行之后 emit。
	 * 载荷是合并后的整行;前端按 id 换缓存、小卡同 id 换字,不重弹。
	 */
	"history-updated": HistoryEntry;
	/**
	 * 一条订阅的直播人数变了。开播、在播状态、断流接续、周期核对带的格经场次引擎原样发出来;
	 * 每个信号最多一帧,只带这份信号报了的格。此刻在线与累计观看是两个不同的数。
	 */
	"live-viewers-changed": {
		subscriptionId: string;
		currentViewers?: number;
		totalViewers?: number;
	};
	/**
	 * 核心场次引擎的每一次变化:开始、核对、接续、状态、断流等待、结束,以及手里没有这一场的下播。
	 * 载荷就是引擎交给进程内监听者的同一份中立纯数据投影;统计是它的消费者。
	 */
	"live-session-changed": LiveSessionChange;
	/**
	 * 某个拓展不在跑了 —— 停用、卸载、换代码、加载失败、设置读不了、宿主关机,一律在它那面 ctx
	 * **开始收摊的那一刻**发(每面 ctx 只发一次),之后它再报什么都不收。
	 *
	 * BN 手里替它记着的在播状态据此作废(ADR-0019 决策 61):它名下的订阅从首页在播里出去,重新跑起来
	 * 之后靠直播状态上报接上。
	 */
	"extension-stopped": { extensionId: string };
	/**
	 * 一轮资料刷新完成后 emit(新建订阅单条刷新后、拓展订阅报了新的粉丝数时也会,见
	 * `runtime/profile-refresh.ts`)。entries 是首页粉丝面板的整份快照:在册来源启用着的订阅与**有粉丝
	 * 时序**的拓展订阅(ADR-0020 决策 8),各带当前粉丝数 + 三个窗口(订阅起点 / 24h / 7d)的 delta。前端 setQueryData
	 * 全量覆盖 ["stats", "followers"] 缓存。delta 字段为 null 表示窗口内没有可用基线/样本。
	 */
	"followers-refreshed": { entries: FollowersRefreshEntry[] };
	/**
	 * 一条作品进了作品装配入口(`PostQueue.enqueue`):**入口同步发的旁路通知**,不是装配的入口 ——
	 * 事件总线不在推送链上,装配由来源直接调入口。每条订阅一份;只发一次(没有「失败后下一轮重发」);
	 * 在串行闸与过滤**之前**发,所以被过滤的、推送失败的作品同样算 UP 的产出(统计口径:
	 * 「这位 UP 发了多少」,「我们推了多少」看 `history-recorded`,两者不可混用)。
	 * 订阅不在 / 停用 / 作品开关关着 / 来源没在跑的,不发。
	 *
	 * 载荷里的图已是图库引用(来源交出之前就抓好 / 写好)。统计是它的监听者(B 站与拓展两支共用一个);
	 * 统计仓仍按 `id` 去重,盘上已有的行与重启后的重放靠它。
	 */
	"post-detected": PostEvent;
}

/**
 * Bus 上 followers-refreshed 事件 / HTTP /api/stats/followers 返回的单条 entry —— 首页粉丝面板的一行,一条订阅一行
 * (ADR-0020 决策 8)。
 */
export interface FollowersRefreshEntry {
	/** 行的键:订阅自己的 id(同统计行,ADR-0020 决策 1 的 🔗)。面板按它对订阅、做键。 */
	subscriptionId: string;
	/**
	 * 这是谁(同统计行 / 推送历史,ADR-0019 决策 73):来源键 + 外部 id,B 站与拓展同一种形状。
	 * 只管颜色与名字兜底。
	 */
	identity: Identity;
	/**
	 * 当前 fans 数。B 站:本次采样问 B 站问到的;拓展:它最近一次报的资料里的(资料没带就是时序的末值)。
	 */
	current: number;
	/** `current` 是什么时候的(ISO):B 站是本次采样时间,拓展是最近那次资料 / 那条样本的时间。 */
	refreshedAt: string;
	/**
	 * delta 相对订阅起点:两种来源都取粉丝时序的**第一条样本**(这位开始被记的那一刻);起点缺失时为 null。
	 */
	deltaSubscribed: number | null;
	/** delta 相对 24h 前最近一条样本;窗口内无样本时为 null。 */
	delta24h: number | null;
	/** delta 相对 7d 前最近一条样本;窗口内无样本时为 null。 */
	delta7d: number | null;
}

/** ConfigStore 在 set 后 emit 'config-changed' 时携带的范围标识。 */
/**
 * 一次配置写入改了哪一块。`integration-settings` 是各集成自己的设置(`config/settings/<键>.json`,今天只有
 * B 站):不按集成分档,想知道自己那份变没变的集成自己比(同 3a 起 `SettingsReader.onChange` 的语义)。
 */
export type ConfigScope =
	| "globals"
	| "integration-settings"
	| "subscriptions"
	| "connections"
	| "targets"
	| "secrets";

/** 事件总线接口。on 返回 Disposable 用于 unsubscribe。 */
/** 总线。载荷为 `undefined` 的事件 `emit` 时不带第二个参数。 */
export interface MessageBus {
	emit<E extends keyof BusEvents>(
		event: E,
		...payload: BusEvents[E] extends undefined ? [] : [payload: BusEvents[E]]
	): void;
	on<E extends keyof BusEvents>(event: E, handler: (payload: BusEvents[E]) => void): Disposable;
}

/** 单段消息载荷类型。composite 中的 segment 之一。 */
export type PayloadSegment =
	| { kind: "text"; text: string }
	| { kind: "image"; buffer: Buffer; mime: string }
	| { kind: "link"; href: string; title?: string }
	/**
	 * @全体成员 段。各 platform adapter 自行翻译:
	 * - OneBot v11: `{ type: "at", data: { qq: "all" } }`(真实 @ 全体)
	 * - Webhook: 通用 JSON 里写成 `{ type: "at-all" }`(线上的名字不随内部改),由接收方自行处理
	 * - Web Dashboard: 渲染成可视化 "@全体" 文本(非真实 @)
	 *
	 * **它是一条自己的消息,不是本体的修饰**(ADR-0016):`PushRouter` 把这一段单独包成
	 * 一条 composite payload,排在本体之前发出,落历史时 `role: "extra"` —— 与下播的词云 /
	 * AI 总结同类,都是挂在某把主特性下面的附加项。发不发由「全局 + per-UP 合并后的
	 * `features.extras.atAll<Scope>`」定,某个目标要不要另说则看订阅上的三态表
	 * `extraTargets.atAll<Scope>[targetId]`。
	 */
	| { kind: "at-all" };

/**
 * 原生分享的中立描述(一张「点开进应用某一页」的分享卡):链接解析器只说「分享什么」,
 * 签名由适配器去签。`LinkPreview.nativeShare` 与载荷的 `native-share` 一支共用这一个类型。
 */
export interface NativeShare {
	/** 小程序 / 应用的标识,适配器按它挑怎么签。 */
	appId: string;
	title: string;
	description: string;
	imageUrl: string;
	/** 应用内的页面路径。 */
	pagePath: string;
	/** 不支持原生分享的客户端点开的网页地址。 */
	webUrl: string;
	iconUrl?: string;
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
	 * 图集 payload(典型来源:动态图集 / 多张大图)。适配器照 `images[].url` 发(`ref` 只是带着);
	 * 尺寸来自来源的图集元数据,仅 QQ 官方原生 markdown 多图(`![文字 #宽px #高px](url)`)需要它来
	 * 正常渲染,缺了不影响别的平台。`mergeForward` 决定 adapter 用哪种
	 * 平台原生形式投递:
	 *   - `true` —— 走 OneBot `send_group_forward_msg`,
	 *     渲染成「聊天记录」卡片。视觉好但走长消息通道(NapCat 的 `SsoSendLongMsg`
	 *     trpc 在某些部署上不稳),失败时所有图都丢。
	 *   - `false` —— 走 OneBot `send_group_msg` 多 image segment。
	 *     普通多图。稳但 N+ 张大图会一排刷屏。
	 * 默认值由设置里的 `imageGroup.mergeForward`(全局与逐订阅覆盖)决定。
	 */
	| { kind: "image-group"; images: PostImage[]; mergeForward: boolean }
	/**
	 * 原生分享:链接解析器交的中立描述原样装进来(见 {@link NativeShare})。怎么签、签不签得了
	 * 归适配器自己挑 —— 认识这个 `appId` 的适配器去签,不认识的、或这条连接签不了的,回
	 * `ok: false`,由链接解析那头回落图片卡。
	 *
	 * `pagePath` 是**应用里的页面路径**,`webUrl` 是网页链接。两个都要:签名协议里页面路径决定
	 * 点开落在哪一页,网页链接给不支持的客户端;把网址填进页面路径签出来的卡点开是「页面不存在」
	 * (2026-09-07 群友反馈那次)。不能原生分享的平台降级成文字时只用 `webUrl`。
	 */
	| ({ kind: "native-share" } & NativeShare);

/**
 * 推送出口接口。业务核心持有此接口，按 PushTarget.id 投递。
 * 实现内部按目标所属连接的分发键找到具体的 platform adapter。
 */
export interface TargetDispatcher {
	send(targetId: string, payload: NotificationPayload): Promise<DeliveryResult>;
	/**
	 * 不经推送目标表,按**连接 + 会话坐标**直接往一个会话发(链接解析回到来源群)。
	 * 不触发投递回调、不重试、不落历史;连接缺 `not_found`、连接停用 `not_configured`、
	 * 没有适配器管或适配器说不可达 `unavailable`。
	 */
	sendToAddress(
		connectionId: string,
		session: SessionRef,
		payload: NotificationPayload,
	): Promise<DeliveryResult>;
	/** 允许 adapter 通过 id 查目标的元数据（scope / 地址 / 启停状态）。 */
	resolve(targetId: string): PushTarget | undefined;
	/**
	 * 配置层面能不能推:目标存在、目标启用、所属连接启用。停用的目标不是候选 ——
	 * 推送层既不发也不等它「恢复可达」。与 {@link isAvailable} 分开:那是运行时的健康。
	 */
	isEnabled(targetId: string): boolean;
	/** 健康检查：目标当前是否可投递（bot 在线 / endpoint 可达）。 */
	isAvailable(targetId: string): boolean;
	/**
	 * 这个目标能不能 @全体。推送路由只问结论,不碰平台;目标或它的连接不在了回 `false`。
	 */
	supportsAtAll(targetId: string): boolean;
	/**
	 * 带外的连接探测入口,给 `/api/connections/:id/probe` 与引擎的周期健康探测用。
	 */
	probeConnection(connectionId: string): Promise<ProbeResult>;
	/**
	 * 这条连接所在平台的能力快照(能不能签小程序卡);连接缺、平台实现缺、平台没有能力
	 * 概念都是 undefined —— 调用方按「什么都不支持」处理。
	 */
	connectionCapabilities(connectionId: string): ConnectionCapabilities | undefined;
	/** 主动探一次能力;同上的三种缺失回 undefined。 */
	probeConnectionCapabilities(connectionId: string): Promise<ConnectionCapabilities | undefined>;
	/**
	 * 列这条连接上可挑的地址(只查 `scope` 那一种)。连接不在 `not_found`、适配器不在
	 * `unavailable`、设置不合法 `not_configured`、适配器没有这个成员 `unsupported`;
	 * **停用的连接照样能列**。
	 */
	listAddressCandidates(
		connectionId: string,
		scope: PushTargetScope,
		signal: AbortSignal,
	): Promise<Result<{ candidates: readonly AddressCandidate[] }>>;
}

/**
 * 一次投递的结果(ADR-0026):送达了是 `{ ok: true, latencyMs }`,没送达是 `Failure`。
 * 耗时只在成功那一支 —— 没真发出去的失败不带一个假的 `0`。
 *
 * `isSynthetic`:这条投递**没有真的出网**(目前只有 devtools 的推送截流会这么标)。结果照样往上回,
 * 好让调用链跑完;但它不携带任何「目标通不通」的信息 —— 拿它去翻 `target.reachability`
 * 就是凭空把一个发不出去的目标标成绿的,而且会落盘、活得比截流本身还久。
 * 读之前先过 {@link isReachabilityEvidence}。
 */
export type DeliveryResult = Result<{ latencyMs: number; isSynthetic?: true }>;

/**
 * 这条投递结果算不算「目标可达」的证据。历史那行照记不误(它记的是这次推送发生了什么),
 * 只有可达性判断要过这道。
 */
export function isReachabilityEvidence(result: DeliveryResult): boolean {
	return !(result.ok && result.isSynthetic === true);
}

/**
 * 一项能力的三态 —— 支持 / 不支持 / 还不知道。**「还不知道」不是「不支持」**:前者是「试试看,可能行」,
 * 后者是结论;读它的地方各自决定「还不知道」时怎么办(见 `ConnectionCapabilities` 各格的注释),
 * 面板上两者也要分开显示。
 *
 * - `supported`:确认支持,`checkedAt` 是确认的时刻。
 * - `unsupported`:确认不支持,`reason` 给人看的一句话,`checkedAt` 是确认的时刻。
 * - `unknown`:还没探出来(没探过、连不上、对面没报),`reason` 可选。
 */
export type CapabilitySupport =
	| { state: "supported"; checkedAt: number }
	| { state: "unsupported"; reason: string; checkedAt: number }
	| { state: "unknown"; reason?: string };

/** 一条连接的能力快照,由这条连接的适配器回答。 */
export interface ConnectionCapabilities {
	/**
	 * 能不能单发 @全体。派发器的 `supportsAtAll` 与订阅抽屉里的 @全体 开关读它;
	 * 「还不知道」时**照发**(发错只是多一条消息)。
	 */
	atAll: CapabilitySupport;
	/**
	 * 主人在这条连接上回一句话,女仆收不收得到。锐评审批(要靠主人回复)与 devtools 的入站场景读它;
	 * 「还不知道」时**审批不能开**(开错了整期草稿都会等到超时作废);
	 * 链接解析设置列不列这个群也读它,「还不知道」时**照列**(今天对拓展连接一律列)。
	 */
	inbound: CapabilitySupport;
	/**
	 * 能不能发原生分享(平台自己的分享卡)。链接预览的门读它:发不了就回落图片;
	 * 「还不知道」时门先探一次,探完仍未知按不能算。
	 */
	nativeShare: CapabilitySupport;
}
