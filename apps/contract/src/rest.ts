/**
 * REST wire 契约 —— apps/server 各路由的响应 DTO,apps/web 按原样消费。
 * 域模型本体(Subscription / GlobalConfig / …)在 `@bilibili-notify/internal`,
 * 这里只放「服务端 join / 投影出来的」wire 形状。
 */

import type {
	ExtensionBotView,
	ExtensionField,
	ExtensionPushView,
	ExtensionSubscriptionCandidate,
	ExtensionSubscriptionView,
} from "@bilibili-notify/extension/wire";
import type {
	AddressCandidate,
	AIProviderProfile,
	AISettings,
	AuthState,
	CachedProfile,
	CardKind,
	Connection,
	ConnectionCapabilities,
	ExtensionProvides,
	ExtensionRunState,
	Failure,
	FailureCode,
	FansRefreshEntry,
	FeatureKey,
	GlobalConfig,
	HistoryPayload,
	Identity,
	ImageRef,
	Issue,
	PostFilterReason,
	PushMessageRole,
	PushStatus,
	Result,
	SourceAccount,
	Subscription,
	SubscriptionReportKind,
	SubscriptionTag,
} from "@bilibili-notify/internal";
import type { RestartAbility } from "./system";
import type { LogLevel } from "./ws";

// 失败规矩(ADR-0026)的类型也从这儿转出:web 只认 contract。
export type {
	CapabilitySupport,
	Failure,
	FailureCode,
	Issue,
	Result,
} from "@bilibili-notify/internal";
export type {
	AddressCandidate,
	// 扫码建连接的状态:面板按它做穷尽 switch,而 web 只认 contract。
	AuthState,
	ConnectionCapabilities,
	// 面板按「它开的是哪一口」分节,而 web 只认 contract —— 同 CapabilitySupport 那条。
	ExtensionProvides,
	FansRefreshEntry,
	PushMessageRole,
	PushStatus,
	// `/api/subscriptions/tags` 的一格(ADR-0034):`GET` 回整张、`PUT` 收整张。
	SubscriptionTag,
};

// ---- HTTP 非 2xx 的错误体(ADR-0026 决策 6)---------------------------------------

/**
 * HTTP 非 2xx 的回应体:就是 `Failure` 去掉 `ok`,平铺的 `{ code, message }`。
 *
 * 可选附加**只有两格**:`issues`(逐条原因,面板逐格标红读它)与 `upstreamCode`(上游平台自己的码,
 * 永远不占 `code`)。要加别的先问主人 —— 清单封闭,免得又长回 19 种形状。
 *
 * 路由一律经服务端的 `respondFailure` 回它,状态码从 `code` 推;「做一件事、回报结果」的接口
 * (测试推送、预览)照旧回 200,体是 `Result<T>`,不是它。
 */
export type ErrorResponse = Omit<Failure, "ok">;

// ---- /api/connections/capabilities ------------------------------------------

/**
 * `GET /api/connections/capabilities`:连接能力快照,索引是**一级** —— 连接 id → 这条连接的能力。
 *
 * 一条连接就是一个 bot(ADR-0012 决策 45),能力按连接答,不再套一层平台名。直连与拓展连接都在表里;
 * 适配器给不出能力的连接(没有适配器管、适配器没实现、引擎还没起来)不在,读它的地方按「还不知道」算。
 */
export type ConnectionCapabilitiesMap = Record<string, ConnectionCapabilities>;

/**
 * `GET /api/connections/:id/addresses?scope=group|private|channel` 响应 —— 这条连接上可挑的地址,
 * 只含 `scope` 那一种。一排平的项;分组靠 `parentAddress` / `parentName`(QQ 频道:频道服务器)。
 */
export interface AddressCandidatesResponse {
	candidates: AddressCandidate[];
}

// ---- /api/extensions ------------------------------------------------------

/**
 * 一个拓展现在处于什么状态 —— 与主人按的那个开关是**两件事**。
 *
 * 开关开着而它没跑,恰恰是最需要看见的那一格(连败自动停用、清单坏了、版本不合)。
 */
export type ExtensionStateDTO = ExtensionRunState;

/**
 * 拓展挂载点的前缀 —— `/ext/<id>/*`。
 *
 * 🔴 **住契约是因为两头都要拼这条路**:服务端在这儿挂路由,面板要把桥该连的地址印给主人
 * 抄进插件里。各写各的话,改了一头就是「桥连过来 404、而两边都不报错」。
 * (URL 面用短词 `ext`,代码面照旧全称 —— ADR-0012 决策 38。)
 */
export const EXTENSION_MOUNT_PREFIX = "/ext";

/**
 * 拓展页那张卡。**没跑起来的也在这儿** —— 消失的东西没法排查。
 *
 * 清单读得出来的字段才有;读不出来时 `name` 退回目录名,`detail` 说明为什么。
 */
export interface ExtensionDTO {
	id: string;
	/** 清单里的名字;清单读不出来时是目录名。 */
	name: string;
	/** 一句话说清它是干嘛的 —— 卡片上就印这句。 */
	description?: string;
	version?: string;
	/** 它开的是哪一口:推送源 / 订阅源。 */
	provides?: ExtensionProvides[];
	/**
	 * 清单是哪一档(ADR-0019 决策 18)。面板靠它分:v2 照声明画(设置项 + 视图积木),v1 的页是
	 * 手写的(只剩桥)。清单读不出来就没有这一格。
	 */
	apiVersion?: number;
	/**
	 * 推送源那一口:外观 + 连接配置项(ADR-0012 决策 33 / 46)。面板拿外观给这一档画脸(推送目标卡上
	 * 的短名与标识色,不许再手抄一份),照连接配置项画「新建连接」的表单。
	 *
	 * **v2 照清单给,没在跑的也有**(ADR-0019 决策 41)—— 拓展停了,它借来的连接照样画得出脸。
	 * v1 的写在代码里,只有跑着的(注册了推送源的)才有。所以「有这一格」**不等于**拓展在场:
	 * 要它在场的(新建它的连接、挑 bot)另看 `state`。
	 */
	push?: ExtensionPushView;
	/**
	 * 订阅源那一口:外观(平台选择那一排的名字与脸、输入框的提示)+ 会报哪几种事件(配置弹层只列
	 * 这几种)。**照清单给,没在跑的也有**(ADR-0019 决策 41)—— 拓展停了,它名下的订阅照样画得出
	 * 是哪个平台的。只有 v2 有:v1 的契约里没有订阅源。「有这一格」**不等于**解析门问得到 —— 要它
	 * 在场的另看 `state`。
	 */
	subscription?: ExtensionSubscriptionView;
	/**
	 * 清单里声明的设置项(v2,ADR-0019 决策 17 / 30)—— 面板照它画设置表单。**没在跑的也有**:
	 * 它来自清单,「装好 → 填 → 启用」这个顺序靠它才走得通。v1 拓展没有这一格。
	 */
	settings?: { fields: readonly ExtensionField[] };
	/** 卡片图标,一段 SVG —— **服务端已经过过白名单**(决策 20)。没有就退回灰方章。 */
	icon?: string;
	/** 它自己那个目录,绝对路径(`<数据根>/extensions/<id>`)。 */
	dir: string;
	/**
	 * 那个目录要是条**软链**,它指到哪去。
	 *
	 * 🔴 开发版就是这么装的:devtools 把仓里的 `dist` 链进装载目录。跑的代码到底是哪一份,
	 * 只有这一格答得了 —— 少了它,面板上写着 `<数据根>/extensions/bridge`,而那其实是
	 * 主人正在改的工作树。
	 */
	linkedTo?: string;
	/** 主人按的那个开关(`globals.extensions.<id>.enabled`)。 */
	enabled: boolean;
	state: ExtensionStateDTO;
	/** 没跑起来时那句「为什么」。 */
	detail?: string;
	/**
	 * 盘上有一份**这个进程干净地换不上**的新代码(ADR-0012 决策 47)—— 版本号取盘上那份的清单。
	 * 「新版等着换上」只有这一种写法:凡是这样的行都带,**关着的也带**。
	 *
	 * 三种样子:`state: "running"` 带着它 = 跑的还是旧的那份(`version` 是旧的);`state: "staged"`
	 * = 开着却没跑(这一档由「开着 && 没在跑 && 带它」推出来),`version` 已经是新的;关着的照旧是
	 * `state: "disabled"`,`version` 也是新的 —— 拨开开关也只会停在 `staged`。
	 *
	 * 出口:「重启 BN」三种都给;「只重载这个拓展」(`POST /api/ext/:id/swap`)只在**开着 && 带它**
	 * 时给 —— 关着的换上去就是把它跑起来,那是开关的活,服务端回 409。**没有这一格时面板不给只重载**,
	 * 生产上不给随手漏模块的口子。
	 */
	staged?: { version: string };
	/**
	 * 订阅源拓展最近的「上报出入」(ADR-0019 决策 60):丢格、整条拒 —— 一条上报一条,**新的在前**,
	 * 最多 20 条。**有才有这一格**,详情页凭它判「有问题才出现」那个框。只在服务端内存里,重启清空、
	 * 卸载清空;新记了时服务端发 `extension-report-discrepancies-changed`(按拓展合并过),面板据此重取这张表。
	 */
	reportDiscrepancies?: ReportDiscrepancyView[];
}

/** 一条「上报出入」(见 {@link ExtensionDTO.reportDiscrepancies})。 */
export interface ReportDiscrepancyView {
	/** 什么时候(毫秒时间戳)。 */
	at: number;
	/** 报的哪一种:三种事件 + 直播状态 + 资料。 */
	kind: SubscriptionReportKind;
	/** 拓展报的外部 id(不是字符串 / 太长的已截成一段能看的)—— 订阅名对不上时就印它。 */
	externalId: string;
	/** 它名下指向这个人的订阅(停用的也算);一条都没对上是空表。 */
	subscriptionIds: string[];
	/**
	 * `rejected`:整条拒了;`dropped`:收下了,丢了几格;`skipped`:周期「正在直播」到点时上次推送之后没收到
	 * 新的直播状态,这一轮没推(决策 61,`kind` 是 `liveStatus`)。
	 */
	outcome: "rejected" | "dropped" | "skipped";
	/** 拒的原因(一句),或丢掉的每一格(每格一句),或跳过的原因(一句)。 */
	reasons: string[];
}

/** `GET /api/ext/:id/bots` —— 这个拓展现在能借来当连接的 bot(ADR-0012 决策 45)。 */
export interface ExtensionBotsResponse {
	bots: readonly ExtensionBotView[];
}

/**
 * `GET /api/ext/:id/lookup?q=` —— 新建订阅时那个拓展的解析门交回的候选(ADR-0019 决策 11 / 52)。
 * 服务端已经核过形状(最多 20 条、头像只收位图 data URL……)。一个都认不出是空表,不是 404。
 */
export interface ExtensionLookupResponse {
	candidates: readonly ExtensionSubscriptionCandidate[];
}

// ---- /api/ext/:id/settings(ADR-0019 决策 35)------------------------------------
//
// 拓展设置自己的读写口。存储在拓展自己的文件 `config/settings/extensions/<id>.json`,不经
// `PATCH /api/settings` 整份写回:列表整份替换时两发交错就丢一发,`id` 不可变与密钥占位回填
// 也都表达不了。这里按项写、带版本号。

/**
 * 一格密钥下发时的样子:服务端算好的提示,原文永不下发。
 *
 * 不到 24 位整段打点(固定 8 个点,不泄露长度);24 位及以上只露头尾各四位。九到十二位时
 * 头尾八位几乎就是全文,所以门槛不是「八位及以下」(决策 35 修订了决策 30)。
 *
 * 🔴 **只许读、不许写回**:PATCH 里任何一格的值是这个形状都回 400 —— 否则面板原样回传的
 * 占位会把真密钥盖成一个对象。要换密钥就交新的明文(重新生成)。
 */
export interface MaskedSecret {
	masked: string;
}

// ---- 下发时密钥格打码的视图 -----------------------------------------------------------
//
// 凭据字段在 schema 上标 `secret`(`markSecret`),下发打码读的就是这个标记:`GET /api/connections`
// 与 `/api/settings`(含各自写入的响应)里,标了的格换成 {@link MaskedSecret},空串 / 没配照旧。
// `backupOnly` 那一档(OneBot 地址、AI baseUrl、请求头的值)面板照常显示,不在这里。
//
// 🔴 **写回规矩全仓一条**:任何写入接口里 `{ masked }` 这个形状的值都回 400;不带这一格 = 保留已存的;
// 清空交空串(必填的格)或 `null`(可选的格)。所以面板「没动过的密钥格」不进 PATCH。

/** 下发的一格密钥:配了是遮挡,没配是空串。 */
export type SecretCellView = MaskedSecret | "";

/** 面板草稿里的一格密钥:没动是遮挡,换了新的是明文(留空 = 清空)。 */
export type SecretCellDraft = MaskedSecret | string;

/** 值是字符串的那几格换成 `S`(可选的仍可选、`undefined` 仍可以);联合逐支套。 */
type CellsAs<T, K extends PropertyKey, S> = T extends unknown
	? {
			[P in keyof T]: P extends K
				? T[P] extends string | undefined
					? S | Exclude<T[P], string>
					: T[P]
				: T[P];
		}
	: never;

/**
 * 一条连接下发时的样子(`GET /api/connections` 与连接写入的响应)。`settings` 有三种样子:
 * - 适配器在场且合法:解过的 settings,密钥格换成 {@link MaskedSecret};
 * - 适配器在场但过不了它的 settingsSchema:整格一个 {@link MaskedSecret},另带 `settingsIssues`;
 * - 适配器不在场:整格一个 {@link MaskedSecret}(宿主分不出哪一格是密钥)。
 */
export type ConnectionView = Omit<Connection, "settings"> & {
	settings: unknown;
	/** 设置过不了适配器的 settingsSchema 时的逐条原因;合法或适配器不在场时没有这一格。 */
	settingsIssues?: readonly Issue[];
};

/** 一份服务商实例下发时的样子:主模型与看图副模型两把 key。`S` 缺省是下发形状,草稿用 {@link SecretCellDraft}。 */
export type AIProviderProfileView<S = SecretCellView> = Omit<
	CellsAs<AIProviderProfile, "apiKey", S>,
	"vision"
> & { vision: CellsAs<AIProviderProfile["vision"], "apiKey", S> };

/** AI 设置下发时的样子:各实例的 key 与联网搜索的 key。 */
export type AISettingsView<S = SecretCellView> = Omit<AISettings, "providers" | "search"> & {
	providers: Record<string, AIProviderProfileView<S>>;
	search: Omit<AISettings["search"], "keys"> & {
		keys: { [Backend in keyof AISettings["search"]["keys"]]: S };
	};
};

/** `GET /api/settings` 的核心那一份(各集成的设置另挂在自己的键下,与 PATCH 收的同一个形状)。 */
export type GlobalConfigView<S = SecretCellView> = Omit<GlobalConfig, "ai"> & {
	ai: AISettingsView<S>;
};

/** `GET /api/ext/:id/settings`。 */
export interface ExtensionSettingsResponse {
	/**
	 * 不透明的版本号:存着的那份设置的内容摘要。写的时候带回来,对不上回 409。
	 *
	 * 摘要只看**这个拓展的设置** —— 别的全局设置、它的开关怎么变都不动它,不会让互不相干的
	 * 写入互相 409。
	 */
	revision: string;
	/**
	 * 存着的设置;密钥格(`secret` 或 `generate`,顶层与列表项里都算)有值时换成
	 * {@link MaskedSecret},空串照旧是空串 —— 面板要分得开「没配」与「配了」。
	 * 清单没声明的键原样带着(拓展可能有面板不管的格)。
	 */
	values: Record<string, unknown>;
}

/**
 * 一次写里的一步。按顺序套在存着的那份上,**只校验这一步动到的**:存量里别的不合规的不连坐
 * (否则清单一收紧,连删一条坏项都被拒)。
 */
export type ExtensionSettingsOp =
	/** 顶层非列表的一格;`value` 为 `null` = 清掉。对列表的键用 `set` 回 400 —— 列表只能逐项改。 */
	| { op: "set"; key: string; value: unknown }
	/** 不带 `id`:项的 id 由 BN 生成(UUID)、藏起来、不许改(决策 29)。生成的 id 在回应的 `added` 里。 */
	| { op: "add"; list: string; item: Record<string, unknown> }
	/** 部分合并进那一项(`null` = 清掉那一格);不许带 `id`。找不到那一项回 400。 */
	| { op: "update"; list: string; id: string; values: Record<string, unknown> }
	/** 找不到那一项回 400 —— 静默当成功的话,面板以为删掉了而它其实从没在那儿。 */
	| { op: "remove"; list: string; id: string };

/** `PATCH /api/ext/:id/settings` 的请求体。 */
export interface ExtensionSettingsPatch {
	/** 上一次 GET / PATCH 拿到的 {@link ExtensionSettingsResponse.revision}。 */
	revision: string;
	/** 至少一步;要么全写进去,要么一步都不写。 */
	ops: ExtensionSettingsOp[];
}

/** PATCH 的回应:写完之后的那份(同 GET),外加每个 add 生成的 id(按 op 顺序)。 */
export interface ExtensionSettingsWriteResponse extends ExtensionSettingsResponse {
	added: string[];
}

/**
 * PATCH 校验不过(400 `{ code: "invalid", message, issues }`)时 `issues` 里的一条 —— 标准的 {@link Issue}
 * 加一格 `op`(ADR-0026 决策 6:全仓只有这一处的原因带 `op`)。
 *
 * `path` 从**这个拓展的设置**那一层往下数,列表项**按 id 点名**(`["links", "<id>", "name"]`)
 * —— 增删之后下标会挪,按第几项说会指错。`add` 那一项的 id 是这次现生成的、面板不认识,
 * 所以每条尽量带上 `op`(第几步惹出来的):对不上某一步的(拓展自己的校验里跨格的规矩)
 * 就没有。
 *
 * 版本号对不上(409)是普通的 `{ code: "conflict", message }`,不带别的:面板据 `code` 重读一遍再改。
 */
export type ExtensionSettingsIssue = Issue & { op?: number };

/**
 * `POST /api/ext/install` 装完之后的回话。
 *
 * ⛔ 面板上**没有**常驻的「重启」按钮(ADR-0005 决策 22)—— 要不要给那颗按钮,由这份回话
 * 说了算:只有刚做完一件确实需要重启的事,才就地提示一次。
 */
export interface ExtensionInstallResponse {
	id: string;
	name: string;
	version: string;
	/**
	 * 装完重扫之后,装载器那一行带不带 `staged`(`ExtensionDTO.staged`,ADR-0012 决策 47)——
	 * 盖掉了一份这个进程**跑过的**代码,ESM 在这个进程里干净地换不掉(决策 10)。出口有两个:
	 * 重启 BN,或只重载这个拓展(后者只在开着时给)。
	 *
	 * 🔴 **不等于「盖掉了一份」**:关着、从没跑过的那份盘上换了就是换了;原样再传一遍的也没什么
	 * 可换。全新装进来的是热的 —— 都是 `false`。反过来,**关着、但这个进程跑过它别的代码**的
	 * 那份是 `true`(配 `enabled: false`,那一行也带着 `staged`):拨开开关也只会停在「新版等着
	 * 换上」,装完就得说。
	 */
	staged: boolean;
	/**
	 * 装完这一刻它的开关是开是关。
	 *
	 * **头一回装进来的一律是关的** —— `enabled` 缺失即关(`isExtensionEnabled` 只认
	 * `=== true`),开关是用户按的,不该因为装了一下就自己开起来。重装一份从前开过的
	 * 则仍是开的(配置里那一格不随目录删掉)。
	 *
	 * 装完那句话要照这一格说:一律说「已经在跑」的话,主人转头在卡片上看到「已停用」,
	 * 两句话当场打架。
	 */
	enabled: boolean;
	/** 要重启时,这台机器上按下去回不回得来。判据见 ADR-0005 决策 22。 */
	restart: RestartAbility;
	/**
	 * 这个包里带没带那两份说明 —— **拆包时就知道**,所以直接说,别让界面去猜或者再拉一次。
	 * 装完那句话后面要不要挂一句「看看说明 / 看看更新了什么」,凭的就是这一格。
	 */
	/**
	 * 🔴 **可选**:这个 app 能应用内自更新,面板与服务端在那几秒里版本可能对不上,老服务端
	 * 的回应里压根没有这一格。写成必填的话,下一个人照契约写 `done.docs.readme` 会一路绿到
	 * 用户那里当场 TypeError —— 少一颗钮是小事,把整块「装好了」炸掉是大事。
	 */
	docs?: { readme: boolean; changelog: boolean };
}

export interface ExtensionsResponse {
	extensions: ExtensionDTO[];
	/**
	 * 这台机器上「重启 BN」按下去回不回得来(ADR-0005 决策 22)。详情页上某个拓展有新版等着换上
	 * 时,据此决定并排的那颗「重启 BN」给不给;不给就换成那句手动重启的说明。
	 *
	 * 只在某一行带着 `staged` 时才被读 —— 老服务端两格都没有,面板也就不会去读它。
	 */
	restart: RestartAbility;
	/**
	 * 装载根的绝对路径:在用那一代的 `extensions/`(ADR-0022 决策 8),装载器读的就是这一个。「装拓展」
	 * 弹窗照它印出「自己放进去」该放到哪儿 —— 1.0 起数据在 `<dataDir>/generations/<序号>/` 里,主人
	 * 自己猜不出序号,照老路放进 `<dataDir>/extensions/` 的包永远不会被装上。
	 *
	 * **可选**,同 {@link ExtensionInstallResponse.docs}:回退到老版本时,面板可能是新的、服务端是老的。
	 * 缺这一格的服务端正是还用 `<dataDir>/extensions/` 的那种,面板照老说法写就是对的。没接装载器的构建
	 * 也没有这一格(那里装了也没人加载)。
	 */
	root?: string;
}

/**
 * `GET /api/ext/:id/docs` —— 拓展自己带的那两份说明。
 *
 * **两格都可选**:没写不是错,面板据此整块不画(空的 README 和没有 README 在屏幕上是
 * 两回事)。拓展没装才是 404。
 *
 * 这条读的是**装载目录里的文件**,与拓展跑没跑起来无关 —— 关着的、加载失败的照样给得
 * 出来,而那正是人最想读它的时候。
 */
export interface ExtensionDocsResponse {
	readme?: string;
	changelog?: string;
}

// ---- /api/ext/marketplace(ADR-0013)--------------------------------------------

/** 一个源:内置的官方源(`id: "official"`)或主人自己加的第三方源。 */
export interface MarketplaceSourceDTO {
	id: string;
	name: string;
	official: boolean;
	/** 第三方源的地址;官方源不下发(它是内置常量)。 */
	url?: string;
	/** 第三方源声明的命名空间;它列的每个 id 都在这底下。 */
	namespace?: string;
	/** 索引拿到了、验过了。不 ok 时 `err` 是那句要原样给主人看的原因。 */
	ok: boolean;
	err?: string;
}

/**
 * 一条条目在**这台机器上**的状态 —— 面板上那颗钮画什么全看它:
 * - `installable`:没装,能装;
 * - `installed`:从这个源装的,就是这一版;
 * - `updatable`:从这个源装的,索引里有更新的版本(装着那版被撤回了的,`installed.revoked` 标着);
 * - `installed-elsewhere`:装着,但不是从这个源装的(手放的 / devtools 链的 / 别的源)—— 不提示更新;
 * - `incompatible`:它要的宿主契约(档位或契约小号)对不上,先升级 BN;
 * - `revoked`:装着的那一版被这个源撤回了、又没有能换过去的新版(或索引里这一版本身就在撤回
 *   名单上)。
 */
export type MarketplaceEntryState =
	| "installable"
	| "installed"
	| "updatable"
	| "installed-elsewhere"
	| "incompatible"
	| "revoked";

export interface MarketplaceEntryDTO {
	/** 来自哪个源(`MarketplaceSourceDTO.id`)。 */
	source: string;
	official: boolean;
	id: string;
	name: string;
	description: string;
	/** 索引里列的(最新)版本。 */
	version: string;
	apiVersion: number;
	/**
	 * 它要的契约小号(ADR-0019 决策 59);索引里没写就没有这一格,按 0 算。`incompatible` 的卡
	 * 靠它说清要几号。
	 */
	apiRevision?: number;
	prerelease: boolean;
	notes?: string;
	releaseUrl?: string;
	/** 包多大(字节)。 */
	size: number;
	/** 这台机器上装着的那份(没装就没有)。`source` 缺 = 不是从市场装的。 */
	installed?: {
		version?: string;
		source?: string;
		/**
		 * 装着的这一版被这个源撤回了,而索引里有能换过去的新版 —— 只跟 `updatable` 一起出现。
		 * 这时恰恰最该更新,所以状态照 `updatable` 给(那颗「更新」得在),红字另靠这一格说;
		 * 没有能换过去的新版就是 `revoked` 那一档,用不着它。
		 *
		 * 🔴 **可选**:面板与服务端在应用内更新那几秒里版本可能对不上,老服务端的回应里压根没有
		 * 这一格 —— 缺了就当没撤回,照常画「有新版」,不许因此出错。
		 */
		revoked?: true;
	};
	state: MarketplaceEntryState;
}

export interface MarketplaceResponse {
	/** 这个构建有没有官方源(fork 出去没有信任公钥的构建没有)。 */
	available: boolean;
	sources: MarketplaceSourceDTO[];
	extensions: MarketplaceEntryDTO[];
	/** 索引是什么时候拉的(epoch 毫秒)。 */
	fetchedAt: number;
}

export interface MarketplaceInstallRequest {
	source: string;
	id: string;
}

// ---- /api/subscriptions ------------------------------------------------------------

/**
 * `Subscription` 的 wire 形状:internal 域模型 + 服务端 SubRuntimeStore join
 * 回来的外置运行时字段(cachedProfile / state / 关注状态)。
 *
 * 只有这一种形状(ADR-0021 决策 14、15):B 站与拓展提供的订阅同一个形状,订的是谁只读
 * `identity`(`sourceKey` + `externalId`)。
 *
 * `identity.sourceKey` 是拓展 id 时:
 *
 * - `cachedProfile.avatar` 是存进图库的头像,即 `ImageRef`(决策 49:头像进图库,面板从 `/api/images/<ref>` 取,
 *   走面板鉴权;引用随内容变,可以放心缓存),没有头像就**缺这一格**(不再写空串)。B 站订阅的头像由服务端抓进图库,
 *   同样放 `cachedProfile.avatar`,`cachedProfile.avatarUrl` 记抓图用的来源地址(抓不到时可能只有它);拓展订阅没有 `avatarUrl`。
 *   `cachedProfile.fans` 可能没有 —— 拓展不一定知道粉丝数,别补成 0。
 * - **新建**(`POST /api/subscriptions`,`id` 还不存在):body 是整条订阅,外加可选的 `cachedProfile` —— 放面板
 *   从解析门(`GET /api/ext/:id/lookup`)挑中的那个候选的 `{ name, avatarUrl?, fans? }`,`avatarUrl` 就是候选
 *   里那个位图 data URL(它是个网址,所以叫 `avatarUrl`)。服务端只收这三格(`sign` / `lastRefreshedAt` 它自己填),
 *   头像存进图库后资料里换成图库引用 `avatar`、不再带那个 data URL。宿主先核,都过了才落盘:`identity.sourceKey`
 *   这个拓展得是装着的 v2 订阅源
 *   (**不要求在跑**,决策 10),没装是 404 `not_found`,装着但不是订阅源(v1 清单 / 没开订阅源那一口 /
 *   清单读不出来)是 400 `unsupported`;同一身份已经有了 → 409 `conflict`;资料不合规矩(头像不是
 *   png / jpeg / webp、魔数对不上、超过 128 KiB……)→ 400 `invalid`,`issues` 点名 `cachedProfile.*`。
 *   失败体一律是 {@link ErrorResponse}。已有的整份 POST 回来(启用开关)照旧,带来的 `cachedProfile`
 *   不收。
 */
export type SubscriptionDTO = Subscription &
	SubscriptionRuntimeDTO & {
		/**
		 * **followed 决定订阅能不能工作**:动态走 `feed/all`(关注流),没关注就一条动态都收不到。
		 * `undefined` = 服务端还没检查过(老数据 / 当时未登录),**不等于**「未关注」—— 别拿它去吓用户。
		 * 只对需要关注的订阅有意义:B 站的、启用中的、作品开关开着的(直播用不着关注,「关了就不查」);
		 * 别的来源、停用的、没开作品的订阅这一格与 `followError` 缺着,运行时状态里留着的旧「未关注」不外泄。
		 */
		followed?: boolean;
		/** `followed === false` 时的原因(风控 / 被拉黑 / 断网…),直接展示给用户。 */
		followError?: string;
	};

/** 外置运行时字段(服务端 SubRuntimeStore join 回来的)。 */
interface SubscriptionRuntimeDTO {
	cachedProfile?: CachedProfile;
}

// ---- /api/history ----------------------------------------------------------

/**
 * 一行历史里的一条消息:文案 / 图 / 这条对这个目标的结果。
 *
 * 结果那几格铺平在消息上,和核心的投递结果同名同义(ADR-0026):送达是 `ok: true`,没送达是
 * `ok: false` + `code` + `message`(+ 平台自己的码 `upstreamCode`)。耗时是内部字段,不过线。没有 `ok` = 这条没有结果:
 * 无目标行的每一条,被前一条失败中止、从没发出去的,或者被全局静音 / 免扰时段挡下的(那种另带 `isSilenced`)。
 */
export type HistoryMessageView = HistoryMessageBase &
	(
		| {
				ok?: undefined;
				/**
				 * 这条被全局静音或免扰时段挡下了:本来会发给这个目标,没发。只在被挡时出现(值恒为 true),
				 * 不区分静音还是免扰;面板把它标成「已静音」而不是「未发送」。
				 */
				isSilenced?: true;
		  }
		| { ok: true }
		| { ok: false; code: FailureCode; message: string; upstreamCode?: number | string }
	);

interface HistoryMessageBase {
	text?: string;
	/**
	 * 这条消息本来是哪一类(纯文字 / 一张图 / 图文混合)。过了保留期的老行,迁移时图格被拿掉了(`image` 缺着),
	 * 面板靠 `kind === "image"` 在原来画图的位置写「图已清理」;`image` 在则同样算有图。
	 */
	kind: HistoryPayload["kind"];
	/** 这条消息的配图(图库引用),面板从 `/api/images/<ref>` 取。composite 只有第一张。缺着 = 没有、或图库没收下、或迁移时已拿掉。 */
	image?: ImageRef;
	role: PushMessageRole;
	/**
	 * 这条是**哪一条的重投**(人工重推补的):值是被补的那条在本行 `messages` 里的下标。
	 * 缺省 = 这条不是重投。面板拿它标「第 N 次尝试」。
	 */
	repushOf?: number;
}

/**
 * 推送历史的一行 = 一次推送 × 一个目标。`GET /api/history` 与 WS `push-events` 的
 * `history-recorded` / `history-updated` 共用这一个形状;后者是同一行追加消息后的整行,
 * 前端按 `id` 换缓存。
 */
export interface HistoryEntryView {
	id: string;
	/** 同一次推送落到几个目标就有几行,它们共用这一个。 */
	pushId: string;
	/** 建行时刻(ISO 字符串)。 */
	createdAt: string;
	/** 这一行是哪一类推送:特性键(补报记 `liveStart`、周期记 `liveStreaming`)。 */
	feature: FeatureKey;
	status: PushStatus;
	/** 替谁发的:订阅的身份(来源键 + 外部 id),B 站行与拓展行同一种形状。 */
	identity: Identity;
	subscriptionId: string;
	/**
	 * null = 这一行没有目标:无目标行(这类推送没配目标,或配的全停用),或者被过滤的行(只留痕,见 `filteredBy`)。
	 * 分哪一种看 `status`。
	 */
	targetId: string | null;
	/** 首条本体是面板上显示的文案;其余展开看。 */
	messages: HistoryMessageView[];
	/**
	 * 写入时 snapshot 的 UP 主名称 / 头像;老 entry 无此字段。头像快照是图库引用,只有拓展行有(B 站行缺着,
	 * 抓图服务在 3a):面板对缺着的退到订阅现在的头像、再退到首字;对**过了保留期**的行也不用它(那几天的行已经不是
	 * 图库的引用方,图随时可能被清扫收走)。
	 */
	nameSnapshot?: string;
	avatarSnapshot?: ImageRef;
	/**
	 * 这条作品被哪一类过滤规则挡下的 —— 只有被过滤的行(`status: "filtered"`)带。那种行只是留痕:
	 * `targetId` 是 null(**不是**无目标行,分哪一种看 `status`)、只有一条文字(摘要与链接)、不能补。
	 */
	filteredBy?: PostFilterReason;
	/**
	 * 这一行能不能人工补一次(ADR-0017)。**缺省 = 没得补**:无目标,或者行里每一条都送到了;带着的行
	 * 才有按钮(决策 6:有目标、且行里还有没送到的或被挡下的消息,看的是消息不是 `status`)。
	 *
	 * 两条路给的把握不一样:**WS 推来的行是没查盘的那一半**,一律 `can: true`(一条刚落、刚追加的行,
	 * 它的原件必然还在);**列表(REST)给的核实过** —— 原件还在不在、路由里还有没有这个目标、目标停没停用、
	 * 是不是正在补,不能补就是 `can: false` 带原因。
	 */
	repush?: HistoryRepushInfo;
	/**
	 * 这一行过了保留期(ADR-0022 决策 9):它的图和重推原件已经清掉,文字还在。**过了才带**(值恒为 true),
	 * WS 推来的新行不带 —— 刚落的行不可能过期。面板在原来画图的位置写「图已清理」。
	 */
	isPastRetention?: boolean;
}

/**
 * 能不能补,以及补几条。**条数由服务端算**(`originalCount` / `unsentIndices`,按身份号
 * 而不是按消息条数)—— 面板自己再算一遍就是第二份实现,判定规则一改两边就漂。
 */
export type HistoryRepushInfo =
	| {
			can: true;
			/** 整行**本来**有几条(重投不算)——「重推全部」发这么多。 */
			total: number;
			/** 还有几条没到 ——「只补没到的」发这么多。 */
			missing: number;
	  }
	/** 不能补,`message` **就是原因**(面板把按钮灰掉并写上它,决策 9)。码按 ADR-0026 决策 2。 */
	| { can: false; code: FailureCode; message: string };

/**
 * `POST /api/history/:id/repush` 请求 —— 人工把一行没送到的推送补一遍。
 *
 * 回 **202** 表示「收下了」:消息一条都还没发出去(发送层光退避就可能走 190s),真正的
 * 结果随后经 WS 的 `history-updated` 一条条回来。
 *
 * 拒了(没这一行 404 `not_found`、现在补不了 409 `conflict`、请求不成形 400 `invalid`)是非 2xx 的
 * {@link ErrorResponse}:`message` 是**给人看的原话**,直接显示 —— 自编一句「重推失败」等于让人对着黑盒猜。
 */
export interface HistoryRepushRequest {
	/** 这一行的 `createdAt` —— 服务端拿它定位日文件。 */
	createdAt: string;
	/** `all` = 整行从头再发一遍(含已经送达的);`missing` = 只补没到的。 */
	mode: "all" | "missing";
}

/** 收下了(202)。`count` = 这一趟要补几条 —— 回来时一条都还没发出去。 */
export type HistoryRepushResponse = { ok: true; count: number };

export interface HistoryResponse {
	entries: HistoryEntryView[];
}

/** `GET /api/history/daily` 的单日桶,日界按请求携带的 tzOffset(客户端时区)。 */
export interface DailyHistoryCount {
	/** 按 tzOffsetMin 口径的本地日 YYYY-MM-DD。 */
	d: string;
	/** 按特性键分的推送数(八把键都在,没有的是 0)。 */
	counts: Record<FeatureKey, number>;
	total: number;
	failures: number;
}

export interface HistoryDailyResponse {
	days: DailyHistoryCount[];
}

// ---- /api/system/logs -------------------------------------------------------------

/** Archived line shape. `args` kept as opaque JSON (already redacted). */
export interface LogArchiveEntry {
	ts: string;
	level: LogLevel;
	name?: string;
	msg: string;
	args?: unknown[];
}

export interface LogsResponse {
	entries: LogArchiveEntry[];
}

// ---- /api/stats ------------------------------------------------------------

/**
 * 数据统计页的单个 UP 行 —— 一条订阅一行,B 站与拓展订阅都在(ADR-0020)。
 *
 * **`null` 一律表示「没有记录」,不是 0**:统计数据都是上线后才开始采集的,
 * 分不清「那天没涨粉」和「那天服务没跑」会让图表撒谎。前端对 null 的处理是
 * 不渲染,而不是补 0。「那天有没有记录」两支各算各的(决策 9):B 站行看 B 站的粉丝采样,
 * 拓展行看它自己的「在记」上报,开始记录之前的日子不画 0。
 */
export interface UpStatsRow {
	/**
	 * 行的键(ADR-0020 决策 1 的 🔗 / 18):订阅自己的 id。面板按它选中、做键。统计随订阅一起删、
	 * 从不比订阅活得久,所以认订阅就够(历史行要在订阅删了之后还认得出人,那边才认人)。
	 */
	subscriptionId: string;
	/**
	 * 这是谁(决策 1,同推送历史 / ADR-0019 决策 73):订阅的身份(来源键 + 外部 id),B 站行与拓展行
	 * 同一种形状,与推送历史那一行是同一个类型。只管颜色、名字兜底、页头写 UID 还是平台 + 外部 id —— 键是上面那个。
	 */
	identity: Identity;
	/**
	 * 此刻的粉丝数:B 站取粉丝轮询的最新快照、拓展取它最近报的资料(停用的两支都退回粉丝时序的末值);
	 * 从未采到为 null —— 平台不报粉丝数的拓展订阅恒为 null(ADR-0020 决策 8)。
	 */
	followers: number | null;
	/**
	 * 近 1 / 7 个本地日的净增 —— **口径固定,不随请求的 days 变**。
	 * 窗口比该口径还短时为 null(窗口里根本没有那么多天可加)。
	 */
	net1d: number | null;
	net7d: number | null;
	/**
	 * **整个请求窗口**的净增合计。UI 上标「近 N 日净增」的就是它。
	 *
	 * 曾经叫 `net30d` 并且恒取末 30 天,于是选「近90日」时标签写着 90 天、
	 * 数字却只加了 30 天。名字改掉是为了让这种错对不上号。
	 */
	netWindow: number | null;
	/** 每日净增序列,长度等于请求的 days,末位是今天。 */
	series: Array<number | null>;
	/**
	 * 每日**末值**(累计粉丝数)序列,长度同 `series`;`null` = 那天没有采样。
	 *
	 * 与 `series` 看似冗余,其实不是:净增的口径是「当日末值 − 前一个有数据的日的
	 * 末值」,窗口内第一个有数据的日没有基线、净增恒为 null,所以光靠净增反推累计
	 * 曲线会丢掉那一天,而今天还没采到样本时更是整条线都推不出来。索引信息在只传
	 * 净增的那一刻就丢了,补不回来 —— 详见 web 侧 `cumulativeFans`。
	 */
	cumulative: Array<number | null>;
	/**
	 * 每日活动次数(作品 + 开播),长度同 `series`,热力图用。每天加的是**那天在记的那几项**的计数
	 * (见 `recording`);`null` = 那天作品与直播都没在记,与「当天没活动」的 0 区分。
	 */
	activity: Array<number | null>;
	/**
	 * 「在记」账(ADR-0027 决策 2 / 13):作品、直播、粉丝三项各自**每个本地日**在不在记,长度与对齐方式同 `activity`
	 * (末位是今天,日界按请求的时区切)。那天与这一项的任何一段在记区间有交集就是 `true`。
	 * 各格的「没记录」(null)都从这里推:窗口里一天都没在记的那一项,它的计数就是 null。
	 */
	recording: { posts: boolean[]; live: boolean[]; followers: boolean[] };
	/**
	 * 以下计数一律与 `activity` 同口径:窗口内**完全没有采集覆盖**时为 `null`,
	 * 而不是 0。
	 *
	 * 0 的意思是「我们在记,这段时间他确实什么都没发」;`null` 的意思是「我们
	 * 那阵子根本没在记」。曾经这几项恒为 number,于是老库升级后点开近 90 日,
	 * 一位实际投了 40 个稿的 UP 会显示「投稿 0 个」—— 而同一行的热力图正诚实地
	 * 画着一片「无记录」空格,两个数在同一屏里互相打脸。AI 锐评那边也一样:
	 * prompt 里「标注为无记录的字段不要据此判定该 UP 偷懒」对这几项从来没生效过。
	 */
	/**
	 * 窗口内**带视频**的作品数 —— 面板与 CSV 上的「投稿」。B 站是视频投稿,拓展是带视频的作品,
	 * 跨平台同一件事。与 `posts` 同时为 null 或同时为数。
	 */
	videoPosts: number | null;
	/**
	 * 窗口内**全部**作品数(带视频的也算在内:图文、纯文字、转发……)。面板与 CSV 上的「动态」是它减去
	 * `videoPosts`(面板上只在 `services/stats.ts` 的 `plainPostCount` 那一处相减)。B 站动态流里的开播
	 * 公告不是作品、不计入。
	 */
	posts: number | null;
	/** 窗口内的开播场次(含仍在进行的那场)。 */
	liveSessions: number | null;
	/** 已闭合场次的总时长(小时)。 */
	liveHours: number | null;
	/**
	 * `liveSessions` 中**时长已知**的场次数 —— 求场均时长时用它当分母。
	 *
	 * 硬杀进程会留下没有下播帧的场次:它确实发生过,但时长无从得知。拿
	 * `liveSessions` 当分母会把这种场次当成「0 小时」,平白稀释场均值。
	 */
	liveTimedSessions: number | null;
	/**
	 * 窗口内**单场最高观看** / **场均观看**(ADR-0020 决策 7 / 18)。每场的数是这一场的**累计观看**
	 * (看过的人数:B 站的「X 人看过」、拓展报的 `totalViewers`),不是同时在线的峰值 —— 所以不再叫
	 * `peakViewers` / `avgPeakViewers`(同当年 `net30d` 改 `netWindow`,名字对不上号才看得出错)。
	 * 只算采到了这个数的场次;一场都没采到为 null。平台只报此刻在线、不报累计的,那几场空着,不拿在线人数顶替。
	 */
	maxViewers: number | null;
	avgViewers: number | null;
	/** 最近一次可见活动(发动态或开播)的时间;窗口内没有则 null。 */
	lastActivityAt: string | null;
	/** 当前是否在直播。 */
	live: boolean;
}

/**
 * AI 锐评的结构化结果。所有 UP 引用都是**订阅 id**(ADR-0020 决策 18):一张榜上 B 站与拓展混着比
 * (决策 12),订阅 id 是两支共有的键,与统计行的键是同一个。前端据此 join 名称、头像与颜色。
 */
export interface StatsRoastResult {
	pigeon: { subscriptionId: string; reason: string };
	diligent: { subscriptionId: string; reason: string };
	roast: Array<{ subscriptionId: string; comment: string }>;
	/** 综合勤奋度 0-100。 */
	scores: Array<{ subscriptionId: string; score: number }>;
	/** 可直接推送到群里的周报文本。 */
	pushText: string;
}

/**
 * `POST /api/stats/roast` 响应(200)。生成没成 —— 没开智能女仆 / 订阅不够 / 取数或模型出错 / 回复读不懂 ——
 * 一律是非 2xx 的 {@link ErrorResponse}(`message` 是给人看的原因,面板原样显示),不在这里。
 */
export interface StatsRoastResponse {
	ok: true;
	result: StatsRoastResult;
}

/**
 * 单 UP 锐评的结果 —— `POST /api/stats/roast/:subscriptionId`(两支订阅都行,ADR-0020 决策 18)。
 *
 * 与榜单式的 {@link StatsRoastResult} 是**两种形状**,不要试图合并:榜单讲的是
 * 「谁比谁强」,单人讲的是「他自己这段时间干了什么」,前者离开对照组就不成立。
 */
export interface StatsSoloRoastResult {
	/** 评的是哪条订阅。 */
	subscriptionId: string;
	/** 一句话总评。 */
	verdict: string;
	/** 综合勤奋度 0-100。 */
	score: number;
	/** 分维度点评(涨粉 / 投稿 / 直播…),标题由模型自拟。 */
	highlights: Array<{ label: string; comment: string }>;
	/** 可直接推送到群里的短评。 */
	pushText: string;
}

/** `POST /api/stats/roast/:subscriptionId` 响应(200);失败同 {@link StatsRoastResponse},是非 2xx 的 {@link ErrorResponse}。 */
export interface StatsSoloRoastResponse {
	ok: true;
	result: StatsSoloRoastResult;
}

/**
 * `POST /api/stats/roast/push` 请求 —— 把**页面上已经生成的那一份**锐评推出去。
 *
 * 结果由前端回传,服务端不重新调模型:主人是看过卡片内容才决定推送的,重新生成会
 * 推出一份谁都没审过的文本(还要再烧一次 token、再等一轮)。服务端只信订阅 id,名称 /
 * 头像 / 配色一律自己 join —— 那几项前端说了不算。
 */
export type StatsRoastPushRequest = {
	targetId: string;
	/** 统计窗口天数,标在卡片上。 */
	days: number;
} & ({ kind: "board"; result: StatsRoastResult } | { kind: "solo"; result: StatsSoloRoastResult });

/**
 * `POST /api/stats/roast/push` 响应:试了一次、回报结果,**照旧回 200**,体是 `Result<{ mode }>` ——
 * 送达了是 `{ ok: true, mode }`,一个目标都没送到是 `{ ok: false, code, message }`(原因是投递那头给的原话),
 * 面板读 `message` 显示。
 *
 * 请求本身不成 —— 引擎没起、体不对、没这个目标、目标已停用 —— 是非 2xx 的 {@link ErrorResponse}。
 */
export type StatsRoastPushResponse = Result<{
	/**
	 * 实际投递形态。图片渲染开着且渲染成功 = `"image"`,否则回退 `"text"` ——
	 * 前端据此告诉用户「推的是图还是文字」,渲染悄悄失败时不至于看起来一切正常。
	 */
	mode: "image" | "text";
}>;

/**
 * 一轮定时周报跑完的结局。与服务端 `RoastRunOutcome` 同构 —— 那边是权威定义,
 * 这里是过 wire 的那份契约。
 *
 * **业务性失败不是 HTTP 失败**:生成不出来、没配目标都是 200 + 这里的 kind。
 * 用 4xx 表达的话,前端 error 分支只拿得到一句 HTTP 错误,原因就丢了。
 */
export type StatsRoastRunOutcome =
	/** 一个推送目标都没配,连模型都没调。 */
	| { kind: "no-targets" }
	/** 生成这一步就没过去(AI 没开、数据不够、模型报错…)。 */
	| { kind: "gen-failed"; code: FailureCode; message: string }
	/** 审批开着:已经生成并私聊给主人了,群里还没发,等主人回 y。 */
	| { kind: "pending-approval"; draftId: string }
	/** 发了。`failed` 非空 = 部分目标没成,那也算发过了,不是整轮失败。 */
	| {
			kind: "sent";
			mode: "text" | "image";
			sent: number;
			/** 因停用而跳过的目标 id —— 不算失败,面板单独说一句「跳过 N 个已停用」。 */
			skipped: string[];
			failed: Array<{ targetId: string; message: string }>;
	  };

/**
 * `POST /api/stats/roast/run` 响应(200):这一轮跑完的结局。服务还没就绪是非 2xx 的
 * {@link ErrorResponse};这一轮里抛了异常是 bug,交给全局出错处理(原话进日志,面板只拿一句固定的话)。
 */
export interface StatsRoastRunNowResponse {
	ok: true;
	outcome: StatsRoastRunOutcome;
}

export interface StatsOverviewResponse {
	/** 实际使用的窗口天数(服务端会 clamp)。 */
	days: number;
	rows: UpStatsRow[];
}

// ---- /api/stats/followers -------------------------------------------------------------

export interface FansResponse {
	entries: FansRefreshEntry[];
}

// ---- 测试推送类端点(/api/targets/:id/test /api/cards /api/ai) ---------------

/**
 * `POST /api/targets/:id/test` 响应(目标 id 在路径里):试了一次、回报结果,**照旧回 200**,
 * 体是 `Result<{ latencyMs }>` —— 送达了是 `{ ok: true, latencyMs }`,没送达是 `{ ok: false, code, message }`,
 * 面板读 `message` 显示。耗时只在成功那一支:没真发出去的失败不带一个假的 `latencyMs: 0`。
 *
 * 请求本身不成(体不对、没这个目标、引擎没起)是非 2xx 的 {@link ErrorResponse},不在这里。
 */
export type TestResponse = Result<{ latencyMs: number }>;

/**
 * `POST /api/connections/:id/probe` 响应:探一次连接通不通,形状同 {@link TestResponse}。
 * 这个平台没有探测协议(比如 webhook)是失败那一支的 `unsupported`,不是通、也不是不通。
 */
export type ConnectionTestResponse = Result<{ latencyMs: number }>;

/**
 * `POST /api/cards/test` 响应:渲染一张卡片推给所选目标,试了一次、回报结果,**照旧回 200**,
 * 体是 `Result<{ latencyMs }>` —— 形状同 {@link TestResponse}(送达带耗时,没送达带码和原话,不带假的耗时)。
 * 渲染没成也是失败那一支(`unavailable`,原话进 `message`)。
 *
 * 请求本身不成(体不对、没配浏览器、引擎没起、没这个目标)是非 2xx 的 {@link ErrorResponse}。
 */
export type TestPushResponse = Result<{ latencyMs: number }>;

/**
 * `POST /api/ai/test` 响应:让女仆回一句、真实推给所选目标,试了一次、回报结果,**照旧回 200**,
 * 体是 `Result<…>` —— 送达了是 `{ ok: true, latencyMs, reply }`(`reply` 供页面回显,耗时只在成功那一支),
 * 女仆没答上来(模型那头的错、网络)或没送达是 `{ ok: false, code, message }`,`message` 带对端给的原因。
 *
 * 请求本身不成(体不对、引擎没起、没这个目标)是非 2xx 的 {@link ErrorResponse}。
 */
export type AiTestPushResponse = Result<{ latencyMs: number; reply: string }>;

// ---- /api/ai/conversations(女仆 AI 聊天)------------------------------------

/**
 * 女仆为了答这一句而调过的一个工具。
 *
 * 会跟着回复一起落盘,而不是只活在那次流里 —— 只在流里显示的话,`done` 一到、
 * 真身把在途副本换下来的那一刻,这几条就凭空消失了,刷新之后也再看不到她当时
 * 查过什么。
 */
export interface AiToolTraceDTO {
	/** 工具名(`list_subscriptions` 之类),界面上翻成中文再显示。 */
	name: string;
	/** 归一成字符串的入参,与真正交给工具的那份一致。 */
	args: Record<string, string>;
	/** 执行成没成。失败的那次也留着 —— 「查了但没查到」和「压根没查」不一样。 */
	ok: boolean;
	/**
	 * `web_search` 专属:这次搜到的来源(标题 + 链接),给消息里的「来源」折叠
	 * 列表用。别的工具没有这个字段。
	 */
	sources?: Array<{ title: string; url: string; siteName?: string }>;
}

/** 一条聊天消息。`id` 供前端当列表 key,`ts` 是服务端落盘时刻(ISO)。 */
export interface AiChatMessageDTO {
	id: string;
	role: "user" | "assistant";
	content: string;
	ts: string;
	/** 助手消息专有:答这一句时调过的工具。没调过就整个字段缺席。 */
	tools?: AiToolTraceDTO[];
	/**
	 * 助手消息专有:答这一句之前的思考过程(思考模型的那段草稿)。前端折叠展示,
	 * 永不回传给模型。没思考就整个字段缺席。
	 */
	reasoning?: string;
	/**
	 * 用户消息专有:这一问带的图,装图库引用。前端拿它拼
	 * `/api/images/<ref>` 显示缩略图。没带图就整个字段缺席。
	 */
	images?: ImageRef[];
	/**
	 * 助手消息专有:卡片工坊里这条回复碰过的皮肤,按先后。消息末尾的预览块照它画
	 * (ADR-0015 决策 20 的 🔗)。没碰过就整个字段缺席。
	 */
	cardSkins?: AiCardSkinTouchDTO[];
}

/** 一条回复碰过的一套卡片皮肤。`kinds` 是这条回复写过的卡种,按先后;只改了名字时为空。 */
export interface AiCardSkinTouchDTO {
	id: string;
	kinds: CardKind[];
}

/**
 * 侧栏「最近」的一项 —— 只有元信息,**不驮消息体**。
 *
 * 列表与详情分开是刻意的:侧栏一次要列几十个会话,把每个会话的整段对话都带上,
 * 光为了显示一行标题就要传几百 KB。点进某个会话时再 `GET /:id` 取全文。
 */
/**
 * 一场对话的**面孔**:`chat` = 日常聊天(女仆人格 + B 站只读工具),
 * `skin` = 皮肤工坊(人格与只读工具全收,只留 create_skin)。
 *
 * 它是**会话级且锁定**的:开局定下,整场不再改 —— 聊到一半换面孔,前半段的
 * 上下文与后半段的工具表对不上,主人也说不清自己在跟谁说话。
 */
export type AiChatMode = "chat" | "skin";

/**
 * 皮肤工坊做的是哪种皮肤(ADR-0015 决策 11 / 12):`dashboard` = 面板皮肤(`create_skin`),
 * `card` = 推送卡片皮肤({@link AI_CARD_WORKSHOP_TOOLS})。与 {@link AiChatMode} 同样开局即锁;
 * 只在 `mode: "skin"` 时有意义,日常聊天里它恒为 `dashboard`、没人读。
 */
export type AiSkinTarget = "dashboard" | "card";

/**
 * 「做一套皮肤」那把工具的名字 —— **三层共用的 wire 标识**,与 {@link AiChatMode}
 * 同层。
 *
 * 服务端拿它建工具;web 拿它判断「这轮跑完要不要回灌皮肤状态」。两处各写一份字面量的话,
 * 改名会**静默**失效一处:聊完的状态回灌不报错,只是不生效。(迁移器给 0.x 老会话认面孔用的
 * 是自己冻住的那份 0.x 工具名,不跟着这里改。)
 */
export const AI_TOOL_CREATE_SKIN = "create_skin";

/**
 * 卡片皮肤工坊的工具名(ADR-0015 决策 13 / 14 与它们的 🔗)—— 与 {@link AI_TOOL_CREATE_SKIN}
 * 同理是**三层共用的 wire 标识**:服务端拿它建工具,web 拿它配中文标签、判断这轮跑完要不要
 * 刷新卡片皮肤库。
 */
export const AI_CARD_WORKSHOP_TOOLS = {
	listSkins: "list_skins",
	readCard: "read_card",
	readBlock: "read_block",
	lookCard: "look_card",
	writeCard: "write_card",
	setBlock: "set_block",
	removeBlock: "remove_block",
	setSkinMeta: "set_skin_meta",
} as const;

export interface AiConversationMetaDTO {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
	/**
	 * 见 {@link AiChatMode}。**必填** —— 0.x 早期的会话文件里没有这个字段,迁移器已经补齐,
	 * wire 上永远带着。契约描述的是线上真会出现的形状,把「可能缺」写进来只会让边界另一侧
	 * 再各判一遍。
	 */
	mode: AiChatMode;
	/** 见 {@link AiSkinTarget}。与 `mode` 同理,wire 上永远带着。 */
	skinTarget: AiSkinTarget;
	/**
	 * 带不带女仆人格。同 `mode`(0.x 的老会话迁移时按 `true` 补,那正是它们一直以来的
	 * 样子)。皮肤工坊那一档本来就没有人格,这个字段在那儿不起作用。
	 */
	persona: boolean;
	/**
	 * 标题是否已由 AI 起过。缺失(旧会话)按 false 算 —— 前端据此决定要不要去要
	 * 一个标题,所以「不知道」必须落在「还没起过」这一边,否则老会话一个都轮不上。
	 */
	autoTitled?: boolean;
}

/** 一整个会话(含消息)。`GET /api/ai/conversations/:id` 的载荷。 */
export interface AiConversationDTO extends AiConversationMetaDTO {
	messages: AiChatMessageDTO[];
}

/** `GET /api/ai/conversations` 响应,按最近聊过的排在前。 */
export interface AiConversationListResponse {
	conversations: AiConversationMetaDTO[];
}

/** `POST /api/ai/conversations` / `GET /api/ai/conversations/:id` 响应。 */
export interface AiConversationResponse {
	conversation: AiConversationDTO;
}

/**
 * `POST /api/ai/conversations/:id/title` 响应 —— 起完标题后的会话元信息。
 *
 * 起名失败也回 200 + **当前**标题(等于没变)。标题是装饰,不值得为它弹红字;
 * 前端照常拿它更新侧栏那一行就行。
 */
export interface AiConversationMetaResponse {
	conversation: AiConversationMetaDTO;
}

/**
 * `POST /api/ai/conversations/:id/chat` 响应。
 *
 * 回的是**两条**消息而不只是回复:用户那条的 id / ts 由服务端生成,前端乐观
 * 渲染的那条只是占位,拿回真身才能把 key 对上,刷新后也不会出现两条一样的话。
 *
 * 响应是 SSE(`delta` / `reasoning` / `tool` / `done` / `error`),这个类型是 `done` 帧的体。开流之前的拒绝
 * (没配模型 / 没开开关 / 会话不存在 / 消息不对)是非 2xx 的 {@link ErrorResponse};开流之后聊到一半出错
 * (模型那头的错、会话被删)是 `error` 帧,帧体与它**同形**(`{ code, message, issues? }`),面板一并解析成 `ApiError`。
 */
export interface AiChatReplyResponse {
	/** 落盘后的用户消息(id / ts 已定)。 */
	user: AiChatMessageDTO;
	/** 女仆的回复。 */
	reply: AiChatMessageDTO;
	/** 更新后的会话元信息 —— 标题可能刚由这条首问定下来,侧栏要跟着改。 */
	conversation: AiConversationMetaDTO;
}

/**
 * `POST /api/cards/preview` 响应:画一张预览卡,**照旧回 200**,体是 `Result<{ dataUrl }>` ——
 * 画出来是 `{ ok: true, dataUrl }`,画不出来(渲染抛错)是 `{ ok: false, code, message }`。
 *
 * 请求本身不成是非 2xx 的 {@link ErrorResponse}:体不对 `invalid`,**没配浏览器 `not_configured`**
 * (面板据此摆出「一键检测并启用 Chrome」),引擎没起 `unavailable`。
 */
export type PreviewResponse = Result<{ dataUrl: string }>;

/** 卡片渲染的浏览器来源(二选一;都在时 endpoint 生效)。 */
export interface ChromeSourceDTO {
	chromePath?: string;
	chromeEndpoint?: string;
}

/** `GET /api/cards/renderer` 响应 —— System 页「卡片渲染浏览器」区的数据源。 */
export interface RenderSourceResponse {
	/** 渲染器当前是否可用(有 adapter 在位)。 */
	enabled: boolean;
	/** 在用来源;未启用时 null。 */
	source: ChromeSourceDTO | null;
	/** false = 无可写 bootstrap 配置(legacy/desktop),切换生效但重启不保留。 */
	persistable: boolean;
}

/**
 * `POST /api/cards/renderer` 响应(成功那一支)。启用不成(体不对、引擎没起、浏览器连不上、
 * 配置写不进去)一律是非 2xx 的 {@link ErrorResponse},这里不再有 `ok: false`。
 */
export interface EnableRenderingResponse {
	ok: true;
	alreadyEnabled?: boolean;
	chromePath?: string;
	chromeEndpoint?: string;
}

// ---- /api/adapters ------------------------------------------------------------

/** `POST /api/adapters/:adapterKey/auth` 响应 —— 发起一次扫码建连接。 */
export interface ConnectionAuthBeginResponse {
	/** 这次认证的任务号(适配器发的),后两个口的路径里带它。 */
	taskId: string;
	/** 此刻的状态;刚发起通常是 awaiting-scan,带二维码。 */
	state: AuthState;
	/** 建议的问询间隔,秒。消费方**必须**夹一道再用,见 web 的 pollDelayMs。 */
	pollIntervalSeconds: number;
}

/**
 * `GET /api/adapters/:adapterKey/auth/:taskId` 响应 —— 只有状态,永远不带草稿。
 *
 * web 端按 `state.status` 做**穷尽** switch(default 里 `never` 兜底):`AuthState` 将来多一条
 * status,前端会直接编译不过,而不是静静地当「还在等」接着问。
 */
export interface ConnectionAuthStateResponse {
	state: AuthState;
}

/**
 * `POST /api/adapters/:adapterKey/auth/:taskId/draft` 响应 —— 取走这次认证拿到的那几格设置,
 * 取走即清。⚠️ 里面可能有密钥(QQ 是 `appSecret`):只填进新建连接的表单,不进任何会被持久化或打印的状态。
 */
export interface ConnectionAuthDraftResponse {
	settings: Record<string, unknown>;
}

// ---- /api/sources ------------------------------------------------------------

/**
 * `GET|POST|DELETE /api/sources/:sourceKey/auth` 响应 —— 这个来源此刻的登录状态与登录着的账号。
 * `account` 没登录或还没取到时不出现;`avatar` 是图库引用(面板对着 `/api/images/<引用>` 取),抓好之前没有。
 * 里面没有 cookie 与令牌。
 */
export interface SourceAuthResponse {
	state: AuthState;
	account?: SourceAccount;
}

// ---- /api/system/backup ------------------------------------------------------------

/** What an import did — or, under `dryRun`, what it *would* do. */
export interface ImportResult {
	subscriptions: { upserted: number; deleted: number };
	connections: { upserted: number; deleted: number };
	targets: { upserted: number; deleted: number };
	globalsApplied: boolean;
	/** 密钥恢复了(演练时:会恢复)的集成,集成键。 */
	restoredIntegrations: string[];
	/** 备份里有、但没带回来的集成与原因。 */
	unrestoredIntegrations: { key: string; message: string }[];
}

// ---- /api/live -------------------------------------------------------------

/**
 * `GET /api/live/listening` 的一行:B 站的直播间,或者一条拓展订阅的在播(ADR-0019 决策 12)。
 * 按 `kind` 分 —— B 站那几行没有这一格,形状与从前一格不差。
 */
export type LiveListeningEntry = LiveListenerSnapshot | ExtensionLiveSnapshot;

/** `GET /api/live/listening` 的单房间条目,由 LiveEngine 的 per-session 快照投影。 */
export interface LiveListenerSnapshot {
	/** B 站那几行没有这一格;有的是拓展订阅的在播({@link ExtensionLiveSnapshot})。 */
	kind?: undefined;
	/**
	 * 这间直播间是替哪条订阅开的 —— 订阅自己的 id,运行期键(ADR-0019 决策 50)。面板拿它对订阅:
	 * 同一个 UP 配了几条订阅时,按 uid 对不出是哪一条。
	 */
	subscriptionId: string;
	uid: string;
	roomId: string;
	isLive: boolean;
	title?: string;
	cover?: string;
	areaName?: string;
	startedAt?: string;
	/** B 站 WATCHED_CHANGE 帧给出的累计观看,精确数(面板排成「1.2万」);还没收到过帧就没有这个键。 */
	viewers?: number;
}

/**
 * 一条拓展订阅此刻在播(ADR-0019 决策 12 / 57):BN 按拓展报的开播 / 下播 / 直播状态记着,按订阅
 * 自己的 id 认。
 *
 * 没有 `uid` / `roomId`(那是 B 站的东西,决策 9),也没有封面 —— 首页那块不画封面,几 MB 的图不该
 * 跟着这份会被反复拉的 JSON 走。
 */
export interface ExtensionLiveSnapshot {
	kind: "extension";
	subscriptionId: string;
	/** 哪个拓展报的 —— 订阅列表还没回来时,平台徽章照它认。 */
	extensionId: string;
	/** 拓展行没有。写出来是为了让按 `uid` 做事的地方先收窄,别把它当 B 站 uid 用。 */
	uid?: undefined;
	roomId?: undefined;
	/** 在表里的就是在播;留这一格与 B 站那几行同形。 */
	isLive: true;
	title?: string;
	/** 分区(拓展报的 `category`),与 B 站那几行同名好画。 */
	areaName?: string;
	/** 开播时刻(ISO)。拓展没报过就没有 —— BN 不拿「收到的时刻」冒充。 */
	startedAt?: string;
	/**
	 * 本场累计观看(拓展报的 `totalViewers`),数字、没排版 —— 与 B 站那几行的 `viewers`(帧里的精确数,
	 * 同样没排版)同一个口径,面板那一列一个含义,同走 `formatCount`(ADR-0019 决策 75)。拓展报的此刻在线(`viewers`)不上面板,
	 * 也就不在这里:它每轮都在变,放进来会让面板为一个看不见的数反复重取。
	 */
	totalViewers?: number;
}
