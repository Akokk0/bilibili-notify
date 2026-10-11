import type { AuthState } from "./auth-state";
import type { PushTargetScope, Result } from "./constants";
import type { KeyValueStore } from "./key-value-store";
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

/**
 * 每个集成(拓展、内置适配器)拿到的那一面。目前五个成员,后面各片往上加。
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
}

/**
 * 订阅变更操作。CRUD 产生的 diff 列表，随 subscription-changed 事件携带。
 *
 * `remove` 带着**被删掉的那一整条**。下游引擎（DynamicEngine / LiveEngine）按 B 站 UID
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
	 * `source` 是逻辑发射源标识(e.g. "dynamic-engine" / "live-engine" / "image" / "ai")
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
	 * 直播状态翻转。
	 *
	 * `at` 是**这次状态翻转的真实发生时刻**(ISO),两个方向语义不同,都可能缺失:
	 *
	 *   · `status === "live"` → B 站给出的真实开播时刻。消费方务必区分它与「我们
	 *     发现开播的时刻」—— 服务器在 UP 已开播时启动,两者能差出好几个小时,拿
	 *     后者当开播时间会把这段直播时长整段吞掉。**它同时是这一场的身份**:统计侧
	 *     按它认场次,同一场被重连核对 / 重启 bootstrap 再观测到时必须给出同一个值。
	 *   · `status === "idle"` → 真实下播时刻。走断流接续(grace)时,真实下播在进入
	 *     挂起那刻就定格了,而事件要等 N 分钟窗口到期才发得出来;不带它的话消费方
	 *     只能用「收到事件的此刻」,每场直播平白多算一整个 grace 窗口。
	 *
	 * 缺失时(接口没返回 / 解析失败 / 非 grace 路径)消费方回退到「收到事件的此刻」。
	 */
	"live-state-changed": { uid: string; status: "live" | "idle"; at?: string };
	/**
	 * 直播间累计观看人数变化(B 站 WS `WATCHED_CHANGE` 帧 → live engine 节流后转发)。
	 * Engine 端按 per-UID 2s throttle,所以高频帧不会打爆 bus。viewers 是帧里的精确数 `num`;
	 * 排成「1.2万」是消费方的事(面板与文字渲染器各走 `formatCount`),统计直接拿它取本场最大值。
	 * (事件的最终形状 —— 按订阅认、拆「此刻在线 / 累计观看」两格 —— 归 3b,这里只改了类型、没改名。)
	 */
	"live-viewers-changed": { uid: string; viewers: number };
	/**
	 * 某个拓展不在跑了 —— 停用、卸载、换代码、加载失败、设置读不了、宿主关机,一律在它那面 ctx
	 * **开始收摊的那一刻**发(每面 ctx 只发一次),之后它再报什么都不收。
	 *
	 * BN 手里替它记着的在播状态据此作废(ADR-0019 决策 61):它名下的订阅从首页在播里出去,重新跑起来
	 * 之后靠直播状态上报接上。
	 */
	"extension-stopped": { extensionId: string };
	/**
	 * 拓展订阅的在播表变了(进表 / 出表 / 面板看得见的那几格变了,ADR-0019 决策 12 / 57)。**拓展订阅的
	 * 在播不走 `live-state-changed`** —— 统计按 uid 订着那一个记场次,而统计不含拓展(决策 12)。
	 *
	 * 载荷为空,面板让 `/api/live/listening` 失效、自己重取。按窗口合并过:直播状态可能每轮都报,一阵
	 * 连着的变化只发一次(`EXTENSION_LIVE_COALESCE_MS`)。
	 */
	"extension-live-changed": undefined;
	/**
	 * 拓展订阅的一场直播开始 / 结束了(ADR-0020 决策 4 / 6)—— 场次(`runtime/extension-live-sessions.ts`)
	 * 算出来的边界,按订阅 id。统计据此记拓展订阅的场次;拓展直播的推送吃的是同一份场次(不经总线)。
	 *
	 * 与推送开关无关:订阅在、启用着、拓展在跑就记。断流接续里的那一下、直播状态、下播进等待都**不是**边界,
	 * 不发。同一场的开始帧与结束帧带同一个 `startedAt`。不进 WS。
	 */
	"extension-live-session": ExtensionLiveSessionEvent;
	/**
	 * 一轮 FansPoller 完成后 emit(拓展订阅报了新的粉丝数时也会,见 `runtime/fans-poller.ts`)。entries
	 * 是首页粉丝面板的整份快照:启用着的 B 站订阅(本轮采样到的)与**有粉丝时序**的拓展订阅(ADR-0020
	 * 决策 8),各带当前 fans + 三个窗口(订阅起点 / 24h / 7d)的 delta。前端 setQueryData
	 * 全量覆盖 ["fans"] 缓存。delta 字段为 null 表示窗口内没有可用基线/样本。
	 */
	"fans-refreshed": { entries: FansRefreshEntry[] };
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
 * 拓展订阅的一场直播为什么结束。
 * - `ended`:拓展报了下播(断流接续开着的,等满了);
 * - `superseded`:没报下播就又开播了,上一场在新的一场开播时收掉;
 * - `extension-stopped`:拓展停了(停用、卸载、换代码、崩了);
 * - `disabled` / `removed`:订阅停用了 / 删了;
 * - `shutdown`:BN 关机。
 */
export type ExtensionLiveSessionEndReason =
	| "ended"
	| "superseded"
	| "extension-stopped"
	| "disabled"
	| "removed"
	| "shutdown";

/**
 * Bus 上 `extension-live-session` 的载荷。时刻都是 ISO。
 *
 * - `startedAt`:这一场的开播时刻,**也是这一场的身份**(同 `live-state-changed` 的 `at`)。开播事件的,
 *   或认出这一场的那份在播状态带的,没带就是认出它的那一刻;开始时定下,结束帧原样带着 —— 之后的状态补上了
 *   真开播时刻也不换,不然两帧对不上。拓展或 BN 重启之后再认出同一场,状态里带着同一个开播时刻,消费方
 *   据此接回同一场(ADR-0020 决策 6)。
 * - `at`:开始帧是 BN 认出这一场的那一刻;结束帧是这一场结束的时刻 —— 拓展报的下播是**下播事件到达那一刻**
 *   (断流接续等的那几分钟不算),其余是结束的那一刻(拓展停了、订阅停用 / 删了、关机时补的就是这一帧)。
 * - `totalViewers`(只有结束帧有):这一场里开播 / 直播状态 / 下播报过的**最大累计观看**(ADR-0020 决策 7)。
 *   累计只增不减,最大的就是本场最后那个累计数;断流接续是同一场、接着算。只报此刻在线(`viewers`)的平台
 *   一次都没报过,这一格就没有 —— 不拿在线顶替。
 */
export type ExtensionLiveSessionEvent =
	| {
			phase: "start";
			subscriptionId: string;
			extensionId: string;
			startedAt: string;
			at: string;
			/** 认出这一场的是开播事件,还是 BN(或拓展)起来之后见到的在播状态。 */
			trigger: "liveStart" | "liveStatus";
	  }
	| {
			phase: "end";
			subscriptionId: string;
			extensionId: string;
			startedAt: string;
			at: string;
			reason: ExtensionLiveSessionEndReason;
			/** 本场报过的最大累计观看;一次都没报过就没有这一格。 */
			totalViewers?: number;
	  };

/**
 * Bus 上 fans-refreshed 事件 / HTTP /api/stats/followers 返回的单条 entry —— 首页粉丝面板的一行,一条订阅一行
 * (ADR-0020 决策 8)。
 */
export interface FansRefreshEntry {
	/** 行的键:订阅自己的 id(同统计行,ADR-0020 决策 1 的 🔗)。面板按它对订阅、做键。 */
	subscriptionId: string;
	/**
	 * 这是谁(同统计行 / 推送历史,ADR-0019 决策 73):B 站条目带 `uid`;拓展条目带 `extensionId` +
	 * `externalId`、不带 `uid`。只管颜色与名字兜底。
	 */
	uid?: string;
	extensionId?: string;
	externalId?: string;
	/**
	 * 当前 fans 数。B 站:本次采样问 B 站问到的;拓展:它最近一次报的资料里的(资料没带就是时序的末值)。
	 */
	current: number;
	/** `current` 是什么时候的(ISO):B 站是本次采样时间,拓展是最近那次资料 / 那条样本的时间。 */
	ts: string;
	/**
	 * delta 相对订阅起点:B 站是 fansBaseline(第一次采到的值,开机按时序最早一条自愈),拓展是它粉丝时序的
	 * **第一条样本**(同一个意思:这位开始被记的那一刻);起点缺失时为 null。
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
	 * QQ 小程序卡(B 站 App「分享到 QQ」那种,点开进小程序播放)。只有能向腾讯签 ark 的
	 * OneBot 实现发得出(扩展接口 `get_mini_app_ark`,见 server 的 platforms/onebot.ts);
	 * 别的平台一律回 `ok: false`,由链接解析那头回落图片卡。
	 *
	 * `path` 是**小程序里的页面路径**(B 站小程序的视频页是 `pages/video/video?bvid=…`),
	 * `jumpUrl` 是网页链接。两个都要:签卡协议里页面路径决定点开落在哪一页,网页链接落到卡的
	 * `qqdocurl`;把网址填进页面路径签出来的卡点开是「页面不存在」(2026-09-07 群友反馈那次)。
	 * 签不了 ark 的平台降级成文字时只用 `jumpUrl`。
	 */
	| {
			kind: "miniapp-card";
			title: string;
			desc: string;
			picUrl: string;
			path: string;
			jumpUrl: string;
	  };

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
	 * 能不能发 QQ 小程序卡。认接口不认实现名:拿空参数探 OneBot 扩展接口 `get_mini_app_ark`,
	 * 按 OneBot 11 的 retcode 判 —— 1404「不支持的动作」= 不支持,1400「参数错」= 接口在、支持;
	 * 别的(连不上、别的错)= 还没探出来,带原因。发送失败不翻它,只有再收到 1404 才翻成不支持。
	 */
	miniAppCard: CapabilitySupport;
}
