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
	BiliSubscription,
	CachedProfile,
	CardSkinKind,
	ConnectionCapabilities,
	ExtensionProvides,
	ExtensionRunState,
	ExtensionSubscription,
	FansRefreshEntry,
	HistoryMessageRole,
	PushKind,
	PushStatus,
	SubscriptionReportKind,
	SubscriptionState,
} from "@bilibili-notify/internal";
import type { RestartAbility } from "./system";
import type { LogLevel } from "./ws";

export type { MiniAppCardSupport } from "@bilibili-notify/internal";
export type {
	ConnectionCapabilities,
	// 面板按「它开的是哪一口」分节,而 web 只认 contract —— 同 MiniAppCardSupport 那条。
	ExtensionProvides,
	FansRefreshEntry,
	HistoryMessageRole,
	PushKind,
	PushStatus,
};

// ---- /api/connections/capabilities ------------------------------------------

/**
 * `GET /api/connections/capabilities`:平台能力快照,索引是**两级** ——
 * 连接 id → 平台名 → 能力。
 *
 * 一条连接只驮一个平台的今天,第二级看着是多余的一层。但能力是**平台**的属性不是连接的:
 * 桥接那档一条 koishi 连接底下可能同时挂着 QQ 与 telegram,扁平表存不下,而两边读它的地方
 * (一个推送目标 / 一条连接)本来就带着平台名。第二级的键是**开放词表**,别拿闭集去索引它。
 *
 * 只有有能力概念的平台在表里;官机 / webhook 不在,面板据此写「这个平台不支持」。
 */
export type ConnectionCapabilitiesMap = Record<string, Record<string, ConnectionCapabilities>>;

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
	/** 它自己那个目录,绝对路径(`<dataDir>/extensions/<id>`)。 */
	dir: string;
	/**
	 * 那个目录要是条**软链**,它指到哪去。
	 *
	 * 🔴 开发版就是这么装的:devtools 把仓里的 `dist` 链进装载目录。跑的代码到底是哪一份,
	 * 只有这一格答得了 —— 少了它,面板上写着 `<dataDir>/extensions/bridge`,而那其实是
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
	 * 订阅源拓展最近的「上报问题」(ADR-0019 决策 60):丢格、整条拒 —— 一条上报一条,**新的在前**,
	 * 最多 20 条。**有才有这一格**,详情页凭它判「有问题才出现」那个框。只在服务端内存里,重启清空、
	 * 卸载清空;新记了时服务端发 `extension-report-problems-changed`(按拓展合并过),面板据此重取这张表。
	 */
	reportProblems?: ExtensionReportProblemView[];
}

/** 一条「上报问题」(见 {@link ExtensionDTO.reportProblems})。 */
export interface ExtensionReportProblemView {
	/** 什么时候(毫秒时间戳)。 */
	at: number;
	/** 报的哪一种:三种事件 + 直播状态 + 资料。 */
	kind: SubscriptionReportKind;
	/** 拓展报的外部 id(不是字符串 / 太长的已截成一段能看的)—— 订阅名对不上时就印它。 */
	externalId: string;
	/** 它名下指向这个人的订阅(停用的也算);一条都没对上是空表。 */
	subscriptionIds: string[];
	/** `rejected`:整条拒了;`dropped`:收下了,丢了几格。 */
	outcome: "rejected" | "dropped";
	/** 拒的原因(一句),或丢掉的每一格(每格一句)。 */
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
// 拓展设置自己的读写口。存储仍在 globals 的 `extensions.<id>.settings`,只是不再经
// `PATCH /api/globals` 整份写回:列表整份替换时两发交错就丢一发,`id` 不可变与密钥占位回填
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
 * PATCH 被拒(400 `{ error: "validation_failed", message, issues }`)时的一条。
 *
 * `path` 从**这个拓展的设置**那一层往下数,列表项**按 id 点名**(`["links", "<id>", "name"]`)
 * —— 增删之后下标会挪,按第几项说会指错。`add` 那一项的 id 是这次现生成的、面板不认识,
 * 所以每条尽量带上 `op`(第几步惹出来的):对不上某一步的(拓展自己的校验里跨格的规矩)
 * 就没有。
 */
export interface ExtensionSettingsIssue {
	op?: number;
	path: (string | number)[];
	message: string;
}

/**
 * PATCH 带的版本号与存着的对不上(409)。带上**现在的**版本号 —— 面板重取之后照着新的那份
 * 再改,而不是把别人刚写的盖掉。
 */
export interface ExtensionSettingsConflict {
	error: "revision_conflict";
	message: string;
	revision: string;
}

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

// ---- /api/subs ------------------------------------------------------------

/**
 * `Subscription` 的 wire 形状:internal 域模型 + 服务端 SubRuntimeStore join
 * 回来的外置运行时字段(cachedProfile / state / 关注状态)。
 *
 * 与域模型一样分两支(ADR-0019 决策 9),按 `kind` 收窄。
 */
export type SubscriptionDTO = BiliSubscriptionDTO | ExtensionSubscriptionDTO;

/** 两支都有的外置运行时字段。 */
interface SubscriptionRuntimeDTO {
	cachedProfile?: CachedProfile;
	state: SubscriptionState;
}

/**
 * B 站订阅。
 *
 * **followed 决定订阅能不能工作**:动态走 `feed/all`(关注流),没关注就一条动态
 * 都收不到。`undefined` = 服务端还没检查过(老数据 / 当时未登录),**不等于**
 * 「未关注」—— 别拿它去吓用户。关注只对 B 站订阅有意义,拓展订阅那支没有这两格。
 */
export type BiliSubscriptionDTO = BiliSubscription &
	SubscriptionRuntimeDTO & {
		followed?: boolean;
		/** `followed === false` 时的原因(风控 / 被拉黑 / 断网…),直接展示给用户。 */
		followError?: string;
	};

/**
 * 拓展订阅(ADR-0019 决策 9):身份是 `(extensionId, externalId)`,没有 uid。
 *
 * - `cachedProfile.avatar` 是同源的**相对地址** `/api/subs/<id>/avatar?v=<摘要>`(决策 49:头像存成
 *   文件,走面板鉴权;换了图 `v` 就变,可以放心缓存),没有头像是空串。`cachedProfile.fans` 可能没有
 *   —— 拓展不一定知道粉丝数,别补成 0。
 * - **新建**(`POST /api/subs`,`id` 还不存在):body 是整条订阅,外加可选的 `cachedProfile` —— 放面板
 *   从解析门(`GET /api/ext/:id/lookup`)挑中的那个候选的 `{ name, avatar?, fans? }`,`avatar` 就是候选
 *   里那个位图 data URL。服务端只收这三格(`sign` / `lastRefreshedAt` 它自己填),头像存成文件后资料里
 *   换成上面那个地址。宿主先核,都过了才落盘:`extensionId` 得是装着的 v2 订阅源(**不要求在跑**,
 *   决策 10),否则 400 `extension_not_installed` / `not_subscription_source`;同一拓展名下同一
 *   `externalId` 已经有了 → 409 `duplicate_subscription`;资料不合规矩(头像不是 png / jpeg / webp、
 *   魔数对不上、超过 128 KiB……)→ 400 `invalid_profile`。已有的整份 POST 回来(启用开关)照旧,
 *   带来的 `cachedProfile` 不收。
 */
export type ExtensionSubscriptionDTO = ExtensionSubscription & SubscriptionRuntimeDTO;

// ---- /api/history ----------------------------------------------------------

/** 一行历史里的一条消息:文案 / 图 / 这条对这个目标的结果。无目标行没有 `ok`。 */
export interface HistoryMessageView {
	text?: string;
	imageRef?: string;
	role: HistoryMessageRole;
	ok?: boolean;
	err?: string;
	/**
	 * 这条是**哪一条的重投**(人工重推补的):值是被补的那条在本行 `messages` 里的下标。
	 * 缺省 = 这条不是重投。面板拿它标「第 N 次尝试」。
	 */
	retryOf?: number;
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
	ts: string;
	kind: PushKind;
	status: PushStatus;
	uid: string;
	subscriptionId: string;
	/** null = 无目标行(这类推送没配目标,或配的全停用)。 */
	targetId: string | null;
	/** 首条本体是面板上显示的文案;其余展开看。 */
	messages: HistoryMessageView[];
	/** 写入时 snapshot 的 UP 主名称 / 头像;老 entry 无此字段。 */
	unameSnapshot?: string;
	uavatarSnapshot?: string;
	/**
	 * 这一行能不能人工补一次(ADR-0017)。**缺省 = 没问过** —— 列表只为失败 / 部分失败
	 * 的行问(每问一次是一次 stat),而 WS 推来的新行一律不带;面板对缺省按「能补」
	 * 处理,那总是对的:一条刚刚失败的推送,它的原件必然还在。
	 */
	repush?: HistoryRepushInfo;
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
	/** 不能补,**这就是原因**(面板把按钮灰掉并写上它,决策 9)。 */
	| { can: false; reason: string };

/**
 * `POST /api/history/:id/repush` 请求 —— 人工把一行没送到的推送补一遍。
 *
 * 回 **202** 表示「收下了」:消息一条都还没发出去(发送层光退避就可能走 190s),真正的
 * 结果随后经 WS 的 `history-updated` 一条条回来。
 */
export interface HistoryRepushRequest {
	/** 这一行的 `ts` —— 服务端拿它定位日文件。 */
	ts: string;
	/** `all` = 整行从头再发一遍(含已经送达的);`missing` = 只补没到的。 */
	mode: "all" | "missing";
}

export type HistoryRepushResponse =
	/** 收下了(202)。`count` = 这一趟要补几条 —— 回来时一条都还没发出去。 */
	| { ok: true; count: number }
	/** 拒了。`err` **直接显示给用户** —— 自编一句「重推失败」等于让人对着黑盒猜。 */
	| { ok: false; err: string };

export interface HistoryResponse {
	entries: HistoryEntryView[];
}

/** `GET /api/history/daily` 的单日桶,日界按请求携带的 tzOffset(客户端时区)。 */
export interface DailyHistoryCount {
	/** 按 tzOffsetMin 口径的本地日 YYYY-MM-DD。 */
	d: string;
	counts: Record<PushKind, number>;
	total: number;
	failures: number;
}

export interface HistoryDailyResponse {
	days: DailyHistoryCount[];
}

// ---- /api/logs -------------------------------------------------------------

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
 * 数据统计页的单个 UP 行。
 *
 * **`null` 一律表示「没有记录」,不是 0**:统计数据都是上线后才开始采集的,
 * 分不清「那天没涨粉」和「那天服务没跑」会让图表撒谎。前端对 null 的处理是
 * 不渲染,而不是补 0。
 */
export interface UpStatsRow {
	uid: string;
	/** 最近一次采样到的粉丝数;从未采到为 null。 */
	fans: number | null;
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
	 * 每日活动次数(动态 + 投稿 + 开播),长度同 `series`,热力图用。
	 * `null` = 那天没有任何采样记录,与「当天没活动」的 0 区分。
	 */
	activity: Array<number | null>;
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
	/** 窗口内的视频投稿数(来自动态流的 DYNAMIC_TYPE_AV)。 */
	archives: number | null;
	/** 窗口内的普通动态数(已剔除开播伪动态)。 */
	dynamics: number | null;
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
	/** 各场峰值观看的最大值 / 平均值;从未采到为 null。 */
	peakViewers: number | null;
	avgPeakViewers: number | null;
	/** 最近一次可见活动(发动态或开播)的时间;窗口内没有则 null。 */
	lastActivityAt: string | null;
	/** 当前是否在直播。 */
	live: boolean;
}

/** AI 锐评的结构化结果。所有 UP 引用都是 uid,前端据此 join 名称与头像。 */
export interface StatsRoastResult {
	pigeon: { uid: string; reason: string };
	diligent: { uid: string; reason: string };
	roast: Array<{ uid: string; comment: string }>;
	/** 综合勤奋度 0-100。 */
	scores: Array<{ uid: string; score: number }>;
	/** 可直接推送到群里的周报文本。 */
	pushText: string;
}

/** `POST /api/stats/roast` 响应。`ok:false` 时只有 `err` 有意义。 */
export interface StatsRoastResponse {
	ok: boolean;
	err?: string;
	result?: StatsRoastResult;
}

/**
 * 单 UP 锐评的结果 —— `POST /api/stats/roast/:uid`。
 *
 * 与榜单式的 {@link StatsRoastResult} 是**两种形状**,不要试图合并:榜单讲的是
 * 「谁比谁强」,单人讲的是「他自己这段时间干了什么」,前者离开对照组就不成立。
 */
export interface StatsSoloRoastResult {
	uid: string;
	/** 一句话总评。 */
	verdict: string;
	/** 综合勤奋度 0-100。 */
	score: number;
	/** 分维度点评(涨粉 / 投稿 / 直播…),标题由模型自拟。 */
	highlights: Array<{ label: string; comment: string }>;
	/** 可直接推送到群里的短评。 */
	pushText: string;
}

/** `POST /api/stats/roast/:uid` 响应。 */
export interface StatsSoloRoastResponse {
	ok: boolean;
	err?: string;
	result?: StatsSoloRoastResult;
}

/**
 * `POST /api/stats/roast/push` 请求 —— 把**页面上已经生成的那一份**锐评推出去。
 *
 * 结果由前端回传,服务端不重新调模型:主人是看过卡片内容才决定推送的,重新生成会
 * 推出一份谁都没审过的文本(还要再烧一次 token、再等一轮)。服务端只信 uid,名称 /
 * 头像 / 配色一律自己 join —— 那几项前端说了不算。
 */
export type StatsRoastPushRequest = {
	targetId: string;
	/** 统计窗口天数,标在卡片上。 */
	days: number;
} & ({ kind: "board"; result: StatsRoastResult } | { kind: "solo"; result: StatsSoloRoastResult });

/** `POST /api/stats/roast/push` 响应。 */
export interface StatsRoastPushResponse {
	ok: boolean;
	err?: string;
	/**
	 * 实际投递形态。图片渲染开着且渲染成功 = `"image"`,否则回退 `"text"` ——
	 * 前端据此告诉用户「推的是图还是文字」,渲染悄悄失败时不至于看起来一切正常。
	 */
	mode?: "image" | "text";
}

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
	| { kind: "gen-failed"; why: string }
	/** 审批开着:已经生成并私聊给主人了,群里还没发,等主人回 y。 */
	| { kind: "pending-approval"; draftId: string }
	/** 发了。`failed` 非空 = 部分目标没成,那也算发过了,不是整轮失败。 */
	| {
			kind: "sent";
			mode: "text" | "image";
			sent: number;
			/** 因停用而跳过的目标 id —— 不算失败,面板单独说一句「跳过 N 个已停用」。 */
			skipped: string[];
			failed: Array<{ targetId: string; err: string }>;
	  };

/** `POST /api/stats/roast/run-now` 响应。`ok:false` 只用于服务没就绪 / 这一轮抛了异常。 */
export interface StatsRoastRunNowResponse {
	ok: boolean;
	err?: string;
	outcome?: StatsRoastRunOutcome;
}

export interface StatsOverviewResponse {
	/** 实际使用的窗口天数(服务端会 clamp)。 */
	days: number;
	rows: UpStatsRow[];
}

// ---- /api/fans -------------------------------------------------------------

export interface FansResponse {
	entries: FansRefreshEntry[];
}

// ---- 测试推送类端点(/api/push /api/cards /api/ai) --------------------------

/** `POST /api/push/test` 响应(targetId 在 body 里);cards/test-push 与它同形。 */
export interface TestResponse {
	ok: boolean;
	latencyMs: number;
	err?: string;
}

/** `POST /api/cards/test-push` 响应 —— 与 push 的 TestResponse 同形。 */
export interface TestPushResponse {
	ok: boolean;
	latencyMs: number;
	err?: string;
}

/** `POST /api/ai/test-push` 响应 —— TestPushResponse 多一个 `reply` 供页面回显。 */
export interface AiTestPushResponse {
	ok: boolean;
	latencyMs: number;
	reply?: string;
	err?: string;
}

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
	 * 用户消息专有:这一问带的图片资产 id。前端拿它拼
	 * `/api/ai/assets/<id>` 显示缩略图。没带图就整个字段缺席。
	 */
	images?: string[];
	/**
	 * 助手消息专有:卡片工坊里这条回复碰过的皮肤,按先后。消息末尾的预览块照它画
	 * (ADR-0015 决策 20 的 🔗)。没碰过就整个字段缺席。
	 */
	cardSkins?: AiCardSkinTouchDTO[];
}

/** 一条回复碰过的一套卡片皮肤。`kinds` 是这条回复写过的卡种,按先后;只改了名字时为空。 */
export interface AiCardSkinTouchDTO {
	id: string;
	kinds: CardSkinKind[];
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
 * 服务端拿它建工具、拿它给没有 `mode` 的老会话认面孔;web 拿它判断「这轮跑完要不要
 * 回灌皮肤状态」。三处各写一份字面量的话,改名会**静默**失效两处:侧栏的「工坊」
 * 牌子和聊完的状态回灌都不报错,只是不生效。
 */
export const AI_TOOL_CREATE_SKIN = "create_skin";

/**
 * 卡片皮肤工坊的工具名(ADR-0015 决策 13 / 14 与它们的 🔗)—— 与 {@link AI_TOOL_CREATE_SKIN}
 * 同理是**三层共用的 wire 标识**:服务端拿它建工具、给老会话认「做的是哪种皮肤」,web 拿它
 * 配中文标签、判断这轮跑完要不要刷新卡片皮肤库。
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
	 * 见 {@link AiChatMode}。**必填** —— 老会话文件里没有这个字段,但缺省是在读盘
	 * 那一处补齐的(见 conversation-store),wire 上永远带着。契约描述的是线上真会
	 * 出现的形状,把「可能缺」写进来只会让边界另一侧再各判一遍。
	 */
	mode: AiChatMode;
	/** 见 {@link AiSkinTarget}。与 `mode` 同理,缺省在读盘那一处补齐,wire 上永远带着。 */
	skinTarget: AiSkinTarget;
	/**
	 * 带不带女仆人格。同 `mode`,缺省在读盘那一处补齐(老会话按 `true` 算,那正是
	 * 它们一直以来的样子)。皮肤工坊那一档本来就没有人格,这个字段在那儿不起作用。
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
 */
export interface AiChatReplyResponse {
	/** 落盘后的用户消息(id / ts 已定)。 */
	user: AiChatMessageDTO;
	/** 女仆的回复。 */
	reply: AiChatMessageDTO;
	/** 更新后的会话元信息 —— 标题可能刚由这条首问定下来,侧栏要跟着改。 */
	conversation: AiConversationMetaDTO;
}

/** `POST /api/cards/preview` 响应。 */
export interface PreviewResponse {
	ok: boolean;
	dataUrl?: string;
	err?: string;
}

/** 卡片渲染的浏览器来源(二选一;都在时 endpoint 生效)。 */
export interface ChromeSourceDTO {
	chromePath?: string;
	chromeEndpoint?: string;
}

/** `GET /api/cards/render-source` 响应 —— System 页「卡片渲染浏览器」区的数据源。 */
export interface RenderSourceResponse {
	/** 渲染器当前是否可用(有 adapter 在位)。 */
	enabled: boolean;
	/** 在用来源;未启用时 null。 */
	source: ChromeSourceDTO | null;
	/** false = 无可写 bootstrap 配置(legacy/desktop),切换生效但重启不保留。 */
	persistable: boolean;
}

/** `POST /api/cards/enable-rendering` 响应。 */
export interface EnableRenderingResponse {
	ok: boolean;
	alreadyEnabled?: boolean;
	chromePath?: string;
	chromeEndpoint?: string;
	err?: string;
}

// ---- /api/qq ----------------------------------------------------------------

/** `GET /api/qq/sessions/:connectionId` 单条 —— 网关入站事件捞到的群/C2C 会话。 */
export interface QQDiscoveredEntry {
	scope: "group" | "private";
	/** group_openid(群)或用户 openid(C2C)。 */
	openid: string;
	/** 触发者用户名等展示提示 —— 群事件不带群名,只能靠它给用户辨认。 */
	displayHint?: string;
	/** 最近见到时间戳(ms)。 */
	lastSeenMs: number;
}

/** `POST /api/qq/bind/start` 响应 —— 扫码一键建 bot(借道腾讯 lite 通道)。 */
export interface QQBindStartResponse {
	/** 轮询用的任务号(腾讯侧生成)。 */
	taskId: string;
	/** 二维码图片,data: URI。 */
	qr: string;
	/** 建议轮询间隔,秒。消费方**必须**夹一道再用,见 web 的 pollDelayMs。 */
	interval: number;
}

/**
 * `POST /api/qq/bind/poll` 响应。
 *
 * web 端按它做**穷尽** switch(default 里 `never` 兜底):这里将来多一条 status,
 * 前端会直接编译不过,而不是静静地当 pending 接着轮询。
 *
 * server 那边的 `QQBindTask` 刻意不在这份契约里 —— 它带着解 AppSecret 的
 * `bindKey`,只活在 server 内存,不出响应也不落盘。
 */
export type QQBindPollResult =
	| { status: "pending" }
	| { status: "expired" }
	| { status: "created"; appId: string; appSecret: string }
	/** 扫码侧完成但凭据缺失/解不开 —— 业务态错误,与上游故障(抛错)区分。 */
	| { status: "error"; message: string };

// ---- /api/backup ------------------------------------------------------------

/** What an import did — or, under `dryRun`, what it *would* do. */
export interface ImportResult {
	subscriptions: { upserted: number; deleted: number };
	connections: { upserted: number; deleted: number };
	targets: { upserted: number; deleted: number };
	globalsApplied: boolean;
	cookiesRestored: boolean;
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
	/** B 站 WATCHED_CHANGE 帧给出的累计观看(预格式化字符串,如 "1.2万")。 */
	viewers?: string;
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
	 * 本场累计观看(拓展报的 `totalViewers`),数字、没排版 —— 与 B 站那几行的 `viewers`(B 站排好的
	 * 字串)同一个口径,面板那一列一个含义(ADR-0019 决策 75)。拓展报的此刻在线(`viewers`)不上面板,
	 * 也就不在这里:它每轮都在变,放进来会让面板为一个看不见的数反复重取。
	 */
	totalViewers?: number;
}
