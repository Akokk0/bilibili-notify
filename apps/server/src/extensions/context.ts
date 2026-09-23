import type {
	ExtensionBotView,
	ExtensionConnectionView,
	ExtensionContext,
	ExtensionOwnSubscription,
	ExtensionPushView,
	ExtensionSettings,
	ExtensionSubscriptionCandidate,
	ExtensionSubscriptionView,
	ExtensionView,
	SubscriptionSourceDef,
} from "@bilibili-notify/extension";
import {
	type Connection,
	checkReportedExternalId,
	checkSubscriptionReport,
	type Disposable,
	EXTENSION_API_RANGE,
	type ExtensionManifest,
	formatZodIssues,
	type InboundMeta,
	type InboundSinks,
	isExtensionConnection,
	isSecretField,
	type Logger,
	manifestProvides,
	type PlatformAdapter,
	type ServiceContext,
	SubscriptionCandidatesSchema,
	type SubscriptionReport,
	type SubscriptionReportDelivery,
	type SubscriptionReportKind,
	undeclaredReportReason,
} from "@bilibili-notify/internal";
import type { ZodType } from "zod";
import type { AdapterRegistry } from "../platforms/registry.js";
import { assertConfigFieldsMatchSchema } from "./config-fields.js";
import { displayFromV1, fieldFromV1 } from "./legacy-v1.js";
import { type ExtensionMounts, extensionMountPrefix } from "./mount.js";
import {
	judgeStoredSettings,
	judgeStoredSettingsSync,
	type StoredSettingsVerdict,
} from "./settings-io.js";
import type { ExtensionUpgrades } from "./upgrade.js";
import { checkExtensionView, faultedExtensionView, type ViewCheck } from "./view-check.js";

/**
 * ⚠️ **交给拓展的那一面住 `@bilibili-notify/extension`**,不在这里 —— 拓展与宿主都要
 * 认得它,所以它得在一个双方都够得到的公共包里(见那个包的文件头)。这里只有**宿主这一侧**:
 * 谁来造 ctx、谁来收摊。
 */
export type {
	ExtensionConnectionView,
	ExtensionContext,
	ExtensionPushView,
	PushExtensionDef,
	PushSourceHandle,
	SubscriptionSourceDef,
	SubscriptionSourceHandle,
} from "@bilibili-notify/extension";

/**
 * 跑一个动作的结果。失败分五种,各有各的说法 —— 并成一句「出错了」的话,面板只能对着黑盒猜:
 * 清单里没这个名字、声明了代码却没接、拓展自己抛了(带原话)、超时、同一个动作还在跑。
 */
export type ActionOutcome =
	| { ok: true }
	| { ok: false; reason: "undeclared" | "unhandled" | "timeout" }
	| { ok: false; reason: "failed"; message: string }
	/**
	 * 同一个动作的上一发还没回来(决策 42:不排队、不并发)。`aborted`:上一发超时后已经叫停过,
	 * 它却还没停 —— 主人要知道这不是自己按得太快。
	 */
	| { ok: false; reason: "busy"; aborted: boolean };

/**
 * `ctx.settings(schema)` 那一下,存着的那份过不了这份 zod(ADR-0019 决策 36)—— 拓展不该拿着
 * 它接着往下起。
 *
 * ⚠️ 装载器认的不是这一抛(拓展 try/catch 吞了它也照样作数),是记在 runtime 上的那一格
 * ({@link ExtensionRuntime.settingsProblem})。它是单独一类,只为了日志里一眼分得出。
 */
export class ExtensionSettingsUnreadable extends Error {}

/**
 * 问一次解析门的结果(ADR-0019 决策 52)。失败分三种,各有各的说法:超时、拓展自己抛了(带原话)、
 * 交回来的候选形状不对(带点名哪儿不对的原因)—— 并成一句「出错了」的话,面板只能对着黑盒猜。
 */
export type LookupOutcome =
	| { ok: true; candidates: readonly ExtensionSubscriptionCandidate[] }
	| { ok: false; reason: "timeout" }
	| { ok: false; reason: "failed" | "invalid"; message: string };

/** 一个动作最多等多久。面板那头的按钮一直转着,比报一句超时更难受。 */
export const ACTION_TIMEOUT_MS = 30_000;

/**
 * 解析门最多等多久(ADR-0019 决策 52)。主人粘完链接等着挑人;平台那头慢(风控、重定向)的
 * 十几秒还算正常,再久就是卡住了。
 */
export const LOOKUP_TIMEOUT_MS = 15_000;

/**
 * 宿主递给 ctx 的一行**拓展订阅**:归属(`extensionId`)加拓展要的那三格。
 *
 * 按结构定,不引订阅存储的类型 —— 存储那头的一行对得上这几格就能直接递过来;筛「是不是它的」
 * 在 ctx 这一层做,归属是宿主的判断(ADR-0019 决策 9 / 50)。
 */
export interface ExtensionSubscriptionRow {
	/** BN 这条订阅自己的 id(uuid)。 */
	id: string;
	/** 记在哪个拓展名下 —— 由 BN 填,不由拓展报。 */
	extensionId: string;
	/** 那个人在平台上的 id,BN 不解读。 */
	externalId: string;
	enabled: boolean;
}

/**
 * 一条「上报问题」(ADR-0019 决策 60):订阅源拓展报上来的东西,整条拒了或者丢了几格。
 *
 * 丢格与拒绝**只从一个出口出去**(ctx 里的 `reportProblem`):记一行 warn(带 `[ext:<id>]` 与原因),
 * 再交给 {@link CreateExtensionContextOptions.onSubscriptionReportProblem} —— 拓展详情页那个「上报问题」框
 * 接的就是它。散着写的话,框里迟早缺一类。
 */
export interface SubscriptionReportProblem {
	extensionId: string;
	/** 什么时候(毫秒)。 */
	at: number;
	/** 报的哪一种。 */
	kind: SubscriptionReportKind;
	/** 拓展报的外部 id(不是字符串 / 太长的,截成一段能看的)。 */
	externalId: string;
	/** 它名下指向这个人的订阅(停用的也算)—— 「哪条订阅」那一栏。一条都没对上就是空表。 */
	subscriptionIds: readonly string[];
	/** `rejected`:整条拒了(`reasons` 只有一句);`dropped`:收下了,丢了这几格(每格一句)。 */
	outcome: "rejected" | "dropped";
	reasons: readonly string[];
}

/**
 * `ctx.statusChanged()` 按拓展合并的窗口:第一喊起算,窗口里的连喊只在尾沿发**一次**。
 *
 * 为什么是 250ms:一阵连喊(桥上两百个 bot 陆续报上来、一次握手连着「会话 + 名单」两声)彼此只隔
 * 几毫秒到几十毫秒,四分之一秒兜得住;而单独一声(一条接入连上、扫码状态变了)的代价就是晚这么一点
 * 才重读,人眼里仍是「当场变了」。每个拓展最多每秒四次整份重读。
 *
 * 🔴 窗口**不因为又喊了一声就往后推**(不是防抖):一个一直在喊的拓展那样永远发不出去,面板上那张卡
 * 一直是旧的。
 */
export const STATUS_CHANGED_COALESCE_MS = 250;

/**
 * 收摊钩子(`ctx.onDispose`)一共最多等多久。收摊排在装载器那条队里:一个钩子挂住,之后的开关、
 * 装包、只重载全卡在它后面,关机也关不下去(ADR-0019 决策 45)。
 */
export const DISPOSE_TIMEOUT_MS = 30_000;

/**
 * v2 清单里推送源那一口的外观 + 连接配置项(ADR-0019 决策 17 / 41)。v1(写在代码里)或没开这一口
 * 就是 `undefined`。
 *
 * 注册推送源时与拓展列表下发时**共用这一份翻译** —— 停着的拓展列表照清单给,跑着的照注册时收下的给,
 * 两处各写一遍的话,哪天清单多一格,两边就说成两种样子。
 */
export function manifestPushView(manifest: ExtensionManifest): ExtensionPushView | undefined {
	if (manifest.apiVersion !== 2) return undefined;
	const push = manifest.contributes.push;
	return push && { display: push.display, connectionFields: push.connection?.fields ?? [] };
}

/**
 * v2 清单里订阅源那一口给面板的东西:外观 + 会报哪几种事件(ADR-0019 决策 41)。v1 或没开这一口就是
 * `undefined` —— v1 的契约里没有订阅源。
 *
 * 只从清单来、不问代码:停用的拓展名下的订阅照样画得出是哪个平台的(决策 10 的置灰)。自带皮肤的
 * 包内路径(`cardSkin`)不给面板 —— 那是装包那头的事。
 */
export function manifestSubscriptionView(
	manifest: ExtensionManifest,
): ExtensionSubscriptionView | undefined {
	if (manifest.apiVersion !== 2) return undefined;
	const subscription = manifest.contributes.subscription;
	return subscription && { display: subscription.display, events: subscription.events };
}

/** 宿主这边握着的把手 —— 拓展拿不到它,所以拓展没法把自己从卸载里摘出去。 */
export interface ExtensionRuntime {
	readonly ctx: ExtensionContext;
	/**
	 * 拓展交上来的那份面板数据 —— 没交过就是 `undefined`。现取。
	 *
	 * v2 是宿主核过的视图(`ExtensionPanelView`:坏块 / 坏项换成了宿主的提示,见 `view-check.ts`);
	 * v1 是它 `publishStatus` 交的任意 JSON,原样。
	 */
	status(): unknown;
	/**
	 * 推送源那一口给面板的东西:外观 + 连接配置项。没注册过推送源就是 `undefined`。
	 *
	 * 🔴 **收下就得能拿出来**:面板要靠外观给拓展那一档一张脸(丢掉的话 web 只能自己手抄
	 * 一份短名与颜色,而手抄的副本迟早跟拓展报的漂开 —— 且那种漂移门禁一片绿);连接配置项
	 * 交上来是为了**被画出来**(决策 33),推送目标页照它画「新建连接」的表单。
	 */
	pushSource(): ExtensionPushView | undefined;
	/**
	 * 现在能借来当连接的 bot。拓展没给 `listBots` 就是 `undefined`(与「空名单」分开:
	 * 前者是「这种推送源没有 bot 这回事」,后者是「现在一个都没连着」)。
	 */
	bots(): readonly ExtensionBotView[] | undefined;
	/**
	 * 它在字段表里声明成密钥的那些键 —— **备份脱敏照这个抹**。
	 *
	 * 脱敏本来靠一份键名黑名单,而拓展的 config 形状归它自己定:叫 `botKey` 的密钥
	 * 黑名单看不见,会原样进备份文件。密钥要声明出来,不能靠猜。
	 */
	secretConfigCodes(): readonly string[];
	/**
	 * 它经 `ctx.settings(schema)` 交过的 zod(可能不止一份,按交的次序)—— 写设置时再过一道
	 * (ADR-0019 决策 35):清单造出来的校验表达不了整数、正则、跨字段规则,放行的值拓展一读就整份
	 * 失败。没交过就是空表,收摊之后也是。
	 */
	settingsSchemas(): readonly ZodType[];
	/**
	 * 存着的设置眼下过不了它交过的 zod 的原因(ADR-0019 决策 36);解得开 / 没设过是 `undefined`。
	 *
	 * 🔴 宿主认的是**这一格**,不是 `ctx.settings()` 那一抛:拓展 try/catch 吞了那一抛也照样作数。
	 * 跑着时设置被旁路写坏,也记在这里,并经 `onSettingsInvalid` 喊装载器来收。
	 */
	settingsProblem(): string | undefined;
	/**
	 * 拿交过的每一份 zod 把存着的那份再判一次(同步判不完的走异步),回 {@link settingsProblem}。
	 * 装载器在 activate 之后叫 —— 带异步 refine 的 zod 在 `ctx.settings()` 那一刻判不完,只有这一道。
	 */
	verifySettings(): Promise<string | undefined>;
	/**
	 * 跑面板按下的那个动作(ADR-0019 决策 22 / 42)。超时与收摊时经 `signal` 叫停 handler;同一个动作
	 * 在跑时回 `busy`,不同的动作互不相干。
	 */
	runAction(name: string, opts?: { timeoutMs?: number }): Promise<ActionOutcome>;
	/**
	 * 问一次解析门(ADR-0019 决策 52):主人输入的原话交给拓展,交回来的候选**先核形状**。超时与收摊
	 * 时经 `signal` 叫停;**不挡并发**(查询可以同时好几发)。没注册过订阅源 / 已经收摊就是 `undefined`。
	 */
	lookup(query: string, opts?: { timeoutMs?: number }): Promise<LookupOutcome | undefined>;
	/** 收回这个拓展注册过的一切。幂等。 */
	dispose(): Promise<void>;
}

export interface CreateExtensionContextOptions {
	id: string;
	/**
	 * 它的清单 —— 注册时按它核对「开没开这一口」,v2 的外观、连接配置项、设置项都从这儿读
	 * (ADR-0019 决策 16)。
	 */
	manifest: ExtensionManifest;
	/** 宿主的 ServiceContext —— 定时器与日志的真身。 */
	host: ServiceContext;
	mounts: ExtensionMounts;
	/** 出口的活注册表。拓展注册的推送源往这里进。 */
	adapters: AdapterRegistry;
	/** 全部连接,**现读**。属于谁由宿主筛。 */
	connections: () => readonly Connection[];
	/**
	 * 按 id 取**一条**连接。入站每条消息都要校验一次归属,而「全表」那口在宿主那头是
	 * deepClone 整张表 —— 给了这口就只拷命中的那一条。不给就退回扫全表。
	 */
	connection?: (connectionId: string) => Connection | undefined;
	/** 订阅「连接配置动过了」。⛔ 拿不到 bus —— 宿主替它订,只把结果转给它。 */
	onConnectionsChanged: (fn: () => void) => Disposable;
	/** 全部拓展订阅,**现读**。属于谁由宿主筛(ADR-0019 决策 52)。 */
	subscriptions: () => readonly ExtensionSubscriptionRow[];
	/** 订阅「订阅动过了」。同 {@link onConnectionsChanged}:宿主替它订,只把结果转给它。 */
	onSubscriptionsChanged: (fn: () => void) => Disposable;
	/**
	 * 订阅源拓展报上来一条、核过形状、对上了它名下的订阅(ADR-0019 决策 7 / 62)—— 宿主把它发到 bus。
	 * `subscriptionIds` 已经按开关筛过(见 `SubscriptionReportDelivery`)。不给就只是没人收。
	 */
	onSubscriptionReport?: (delivery: SubscriptionReportDelivery) => void;
	/** 「上报问题」的出口(见 {@link SubscriptionReportProblem})。日志 ctx 已经记了;不给就只记日志。 */
	onSubscriptionReportProblem?: (problem: SubscriptionReportProblem) => void;
	/** 它自己那份设置(`globals.extensions.<id>.settings`),**现读**、原样。 */
	settings: () => unknown;
	/** 订阅「globals 落盘了」—— 内容变没变由 ctx 自己判,再转给拓展。 */
	onSettingsChanged: (fn: () => void) => Disposable;
	/**
	 * 存着的设置变得过不了它交过的 zod 了(跑着时被旁路写坏,或之后才交的那份判坏了)—— 装载器
	 * 该来把它收掉。原因在 {@link ExtensionRuntime.settingsProblem}。不给就只是没人收。
	 */
	onSettingsInvalid?: () => void;
	/**
	 * 拓展喊「面板数据变了」(`ctx.statusChanged`)时转给宿主;不给就只是没人听。**已经合并过**:一个
	 * 窗口里的连喊只叫它一次,见 {@link STATUS_CHANGED_COALESCE_MS}。
	 */
	onStatusChanged?: () => void;
	/** 入站的两路收口。 */
	inbound: InboundSinks;
	/** WS upgrade 的分发表。 */
	upgrades: ExtensionUpgrades;
	hostApiVersion?: number;
	/** 载荷版本号。测试里可以不给。 */
	hostVersion?: string;
	/** 收摊钩子一共等多久,见 {@link DISPOSE_TIMEOUT_MS}。只有测试会换。 */
	disposeTimeoutMs?: number;
}

function prefixed(logger: Logger, id: string): Logger {
	const tag = `[ext:${id}]`;
	return {
		info: (msg, ...args) => logger.info(`${tag} ${msg}`, ...args),
		warn: (msg, ...args) => logger.warn(`${tag} ${msg}`, ...args),
		error: (msg, ...args) => logger.error(`${tag} ${msg}`, ...args),
		debug: (msg, ...args) => logger.debug(`${tag} ${msg}`, ...args),
	};
}

/** 拓展交回来的是不是一个 Promise(或别的 thenable)—— `publishView` 要的是同步交回的视图。 */
function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (
		(typeof value === "object" || typeof value === "function") &&
		value !== null &&
		typeof (value as { then?: unknown }).then === "function"
	);
}

/** 已经卸载了还来注册的东西,给它一个什么都不做的把手。 */
const NOOP_DISPOSABLE: Disposable = { dispose() {} };

/**
 * 给一个拓展开一面 ctx,外加宿主收回它的那个把手。
 *
 * 注册进来的每一样都记在这一份名册上,`dispose()` 一次清空 —— 这就是「启用 / 停用热」
 * 做得到的原因(决策 10:热的是**副作用**,不是代码;代码换不掉,那要重启)。
 */
export function createExtensionContext(opts: CreateExtensionContextOptions): ExtensionRuntime {
	const { id, host, mounts, adapters } = opts;
	const logger = prefixed(host.logger, id);
	const registered = new Set<Disposable>();
	const hooks: Array<() => void | Promise<void>> = [];
	let disposed = false;

	/** 卸载之后还来注册 —— 不生效,但要留一行:那是拓展没收干净自己的异步尾巴。 */
	function refuse(what: string): Disposable {
		logger.warn(`已经卸载了,${what} 不再受理`);
		return NOOP_DISPOSABLE;
	}

	function track(inner: Disposable): Disposable {
		registered.add(inner);
		return {
			dispose() {
				registered.delete(inner);
				inner.dispose();
			},
		};
	}

	/** v1 `publishStatus` 交的回调 —— 任意 JSON,原样下发。 */
	let statusOf: (() => unknown) | undefined;
	/** v2 `publishView` 交的回调 —— 每问一次叫一次,核过再下发。 */
	let viewFn: (() => ExtensionView) | undefined;
	const isV2 = opts.manifest.apiVersion === 2;
	let pushSourceRegistered = false;
	let pushView: ExtensionPushView | undefined;
	/**
	 * 清单声明过的动作名(决策 42:清单里只有名字的一串);清单里没有 `actions` 这一段(v1 一律
	 * 没有)就是 `undefined`。建成 Set 查:名字是拓展与面板给的,拿普通对象按下标查会顺着原型链把
	 * `constructor` / `toString` 判成声明了。
	 */
	const declaredActions: ReadonlySet<string> | undefined =
		opts.manifest.apiVersion === 2 && opts.manifest.actions
			? new Set(opts.manifest.actions)
			: undefined;
	/** 代码接了的动作。卸载时清空 —— 之后面板再按,就是「声明了却没接」。 */
	const actionHandlers = new Map<string, (signal: AbortSignal) => void | Promise<void>>();
	/**
	 * 在跑的动作 → 叫停它的那个把手。「在跑」算到 handler 真的回来为止(超时叫停了却不停的也算);
	 * 收摊时逐个叫停。
	 */
	const runningActions = new Map<string, AbortController>();
	let listBots: (() => readonly ExtensionBotView[]) | undefined;
	let secretCodes: readonly string[] = [];
	let subscriptionSourceRegistered = false;
	/** 注册上来的订阅源(解析门在它身上);收摊时摘掉。 */
	let subscriptionSource: SubscriptionSourceDef | undefined;
	/** 在跑的解析 —— 收摊时逐个叫停。**不按名字挡并发**(决策 52:查询可以同时好几发)。 */
	const runningLookups = new Set<AbortController>();
	/** 挂着的那一发「面板数据变了」(合并窗口,见 {@link STATUS_CHANGED_COALESCE_MS});没有就是 `undefined`。 */
	let statusTimer: ReturnType<typeof setTimeout> | undefined;

	/** 属于这个拓展、且 config 解得出来的那些。解不出的当它不存在并记一行。 */
	function ownConnections<TConfig>(
		schema: ZodType<TConfig>,
	): readonly ExtensionConnectionView<TConfig>[] {
		const views: ExtensionConnectionView<TConfig>[] = [];
		for (const connection of opts.connections()) {
			if (!isExtensionConnection(connection, id)) continue;
			const parsed = schema.safeParse(connection.config);
			if (!parsed.success) {
				logger.warn(`连接 ${connection.id} 的配置形状不对,这一条不交给它:${parsed.error.message}`);
				continue;
			}
			views.push({
				id: connection.id,
				name: connection.name,
				enabled: connection.enabled,
				config: parsed.data,
			});
		}
		return views;
	}

	/**
	 * 记在这个拓展名下的订阅,**全部**(停用的也在,跳不跳过由它自己定)。只交它要的三格 —— 推不推、
	 * 推给谁它不需要知道(ADR-0019 决策 1 / 52);每次都是新抄的一份,拓展改不着宿主手里那份。
	 */
	function ownSubscriptions(): readonly ExtensionOwnSubscription[] {
		return opts
			.subscriptions()
			.filter((row) => row.extensionId === id)
			.map((row) => ({ id: row.id, externalId: row.externalId, enabled: row.enabled }));
	}

	/**
	 * 订阅源那一口开没开 —— 「注册的口 ⊆ 清单开的口」(ADR-0019 决策 16),同 {@link pushViewOf}。
	 * v1 的契约里没有订阅源:它的 `provides` 里写着 `subscription` 也注册不了。
	 */
	function assertSubscriptionPort(def: SubscriptionSourceDef): void {
		const { manifest } = opts;
		if (manifest.apiVersion !== 2) {
			throw new Error(
				`extension ${id}: 订阅源只有 v2 清单开得了(contributes.subscription),v1 的契约里没有这一口`,
			);
		}
		if (!manifest.contributes.subscription) {
			throw new Error(
				`extension ${id}: 清单里没开订阅源那一口(contributes.subscription),不能注册订阅源`,
			);
		}
		// 第三方 JS 不受类型约束:没交解析门的话,每一次查询都会炸成一句「不是函数」。
		if (typeof def?.lookup !== "function") {
			throw new Error(`extension ${id}: 订阅源要交解析门 lookup(query, signal)`);
		}
	}

	// ---- 订阅源的上报(ADR-0019 决策 7 / 57 / 59 / 60 / 62)------------------------------------------

	/** 清单声明的事件种类 —— 报上来的种类照它核(决策 5:清单就是能力声明)。 */
	const declaredEvents =
		opts.manifest.apiVersion === 2 ? (opts.manifest.contributes.subscription?.events ?? []) : [];

	/** 拓展报的外部 id 念给人听:不是字符串的只说类型,太长的截一段。 */
	function externalIdPreview(raw: unknown): string {
		if (typeof raw !== "string") return `(${typeof raw})`;
		return raw.length > 64 ? `${raw.slice(0, 64)}…` : raw;
	}

	/**
	 * 「上报问题」**唯一**的出口(决策 60):记一行 warn(带 `[ext:<id>]` 与原因),再交给宿主 —— 拓展
	 * 详情页那个框接的就是它。丢格、整条拒都从这里过,别散着写。
	 */
	function reportProblem(problem: Omit<SubscriptionReportProblem, "extensionId" | "at">): void {
		const what = `${problem.kind}(外部 id ${problem.externalId})`;
		logger.warn(
			problem.outcome === "rejected"
				? `上报 ${what} 整条拒了:${problem.reasons.join(";")}`
				: `上报 ${what} 丢了 ${problem.reasons.length} 格:${problem.reasons.join(";")}`,
		);
		opts.onSubscriptionReportProblem?.({ ...problem, extensionId: id, at: Date.now() });
	}

	/**
	 * 收一条上报:核外部 id → 核种类 → 核形状(规矩在 `checkSubscriptionReport`,决策 59)→ 找它名下指向
	 * 这个人的订阅 → 按开关筛 → 交给宿主。拒掉时抛带原因的错(拓展那头是一个 reject),丢格照收。
	 *
	 * **不等出卡与推送**(决策 62):交给宿主(发到 bus)那一下就回。
	 */
	async function receiveReport(
		kind: SubscriptionReportKind,
		rawExternalId: unknown,
		raw: unknown,
	): Promise<void> {
		if (disposed) {
			refuse(`上报 ${kind}`);
			throw new Error(`extension ${id} is already unloaded`);
		}
		const idCheck = checkReportedExternalId(rawExternalId);
		const externalId = idCheck.ok ? idCheck.externalId : externalIdPreview(rawExternalId);
		// 身份是 `(这个拓展, 外部 id)`(决策 50),同一个人可能有几条订阅。停用的也算「对上了」:资料更新
		// 要发给它们,问题框里「哪条订阅」那一栏也要它们。
		const matched = idCheck.ok
			? opts
					.subscriptions()
					.filter((row) => row.extensionId === id && row.externalId === externalId)
			: [];
		const subscriptionIds = matched.map((row) => row.id);
		const reject = (reason: string): never => {
			reportProblem({ kind, externalId, subscriptionIds, outcome: "rejected", reasons: [reason] });
			throw new Error(`BN 拒收这条 ${kind} 上报:${reason}`);
		};
		if (!idCheck.ok) return reject(idCheck.reason);
		const undeclared = undeclaredReportReason(kind, declaredEvents);
		if (undeclared !== undefined) return reject(undeclared);
		const checked = checkSubscriptionReport(kind, raw);
		if (!checked.ok) return reject(checked.reason);
		if (checked.dropped.length > 0) {
			reportProblem({
				kind,
				externalId,
				subscriptionIds,
				outcome: "dropped",
				reasons: checked.dropped,
			});
		}
		if (matched.length === 0) {
			// 多半是订阅刚删、变更通知还没到它那儿(决策 62):不算错。
			logger.debug(`上报 ${kind} 的外部 id ${externalId} 不在它名下的订阅里,忽略`);
			return;
		}
		// 停用的:事件与直播状态收下不往下发(也不进首页在播);资料更新照样对它们生效(决策 62)。
		const targets = kind === "profile" ? matched : matched.filter((row) => row.enabled);
		if (targets.length === 0) {
			logger.debug(`上报 ${kind} 的外部 id ${externalId} 名下的订阅都停用了,不往下发`);
			return;
		}
		// `kind` 与 `checked.value` 是一对,只是泛型收窄不到联合的某一支。
		const report = { kind, value: checked.value } as SubscriptionReport;
		try {
			opts.onSubscriptionReport?.({
				extensionId: id,
				externalId,
				subscriptionIds: targets.map((row) => row.id),
				report,
			});
		} catch (err) {
			// bus 上的消费方抛了 —— 那是 BN 自己的 bug,不该变成拓展那头的一个 reject。
			logger.error(`上报 ${kind} 交给宿主时抛了:${(err as Error).message}`);
		}
	}

	/**
	 * 把手上的一个 `report*`。🔴 拓展不接这个 Promise 时,它的 reject 不许变成 unhandledRejection ——
	 * 独立端装的处理器会把整个进程关掉;拒掉的原因已经从上报问题的出口记下了。拓展 `await` 它照样拿得到。
	 */
	function reporter(kind: SubscriptionReportKind) {
		return (externalId: unknown, raw: unknown): Promise<void> => {
			const pending = receiveReport(kind, externalId, raw);
			pending.catch(() => {});
			return pending;
		};
	}

	/** 这条连接是不是它自己的 —— 是的话把连接交出来,入站那两道校验都要用。 */
	function own(connectionId: string): Connection | undefined {
		const hit = opts.connection
			? opts.connection(connectionId)
			: opts.connections().find((connection) => connection.id === connectionId);
		return hit && isExtensionConnection(hit, id) ? hit : undefined;
	}

	// ---- 自己的设置(ADR-0019 决策 36)----------------------------------------------------

	/** 清单声明的设置项 —— 点名「哪一格」时拿它念名字。v1 清单里没有,路径原样念。 */
	const settingsFields =
		opts.manifest.apiVersion === 2 ? (opts.manifest.settings?.fields ?? []) : [];
	/** 交过的每一份(对表过了的才算),写设置时宿主拿它们再过一道。Set 保序、同一份只记一次。 */
	const handedSchemas = new Set<ZodType>();
	/**
	 * 每份 zod 解出来的**最近一份好的** —— `get()` 只从这里拿,解析在「交进来」与「落盘了」那两下
	 * 做完,不挂在 `get()` 上。
	 *
	 * 🔴 不能「每问一次现读现解」:宿主那头是 `getGlobals().extensions[id]?.settings`,每次都
	 * deepClone 一整份 globals —— 桥每握一次手问一次。
	 *
	 * 🔴 **存着的那份变得解不开时这里不动**:拓展永远看不到一份过不了它自己 zod 的设置。在装载器
	 * 把它收掉之前(那要排队),它读到的还是上一份好的 —— 从前是「按没有算」给一个 `undefined`,
	 * 对桥就是名单一空、插件收 401、永久不再重连。
	 */
	const settingsValues = new Map<ZodType, unknown>();
	/** 存着的那份眼下解不开的原因;`undefined` = 解得开或没设过。装载器凭它判「设置读不了」。 */
	let settingsProblem: string | undefined;
	/** 第几次「这一格动了」—— 异步判完回来时,中间又动过的那一次判决作废。 */
	let settingsRound = 0;

	function settingsUnreadable(detail: string): void {
		settingsProblem = detail;
		opts.onSettingsInvalid?.();
	}

	function readSettings<T>(schema: ZodType<T>): T | undefined {
		if (settingsValues.has(schema)) return settingsValues.get(schema) as T | undefined;
		// 只有一种情况走到这:交进来那一刻同步判不完(schema 里有异步 refine),异步那一道还没回来。
		// 不给 `undefined` —— 那在拓展眼里是「没设过」,正是决策 36 要堵的那种误读。
		throw new Error(
			`extension ${id}: 设置还没校验完 —— 这份 zod 带异步规则,交进来那一刻同步判不完,要等一拍再读(activate 里别急着读)`,
		);
	}

	/**
	 * 「我这一格动了」的扇出。
	 *
	 * 🔴 **去重游标只此一个,而且只在这里推**。从前是每个订阅者各自比一次同一个闭包变量:
	 * 第一个订阅者把游标推到最新,轮到第二个时「和上次一样」—— 于是**第二个订阅者永远
	 * 收不到**。宿主的通知是「globals 落盘了」,内容变没变是 ctx 的判断,判一次就够。
	 *
	 * 🔴 **先判再扇出**:新的那份过不了交过的 zod,就一个订阅者都不叫、`get()` 也不换,记下原因交给
	 * 装载器把它收掉(恢复备份、手改文件、关着时之外的旁路写入都会走到这儿 —— 面板那条写路径
	 * 在跑着时已经过过它的 zod)。
	 */
	const settingsListeners = new Set<() => void>();
	/** 上一次看见的设置(序列化),用来判「这次 globals 落盘动的是不是我这一格」。 */
	let lastSettingsSeen = JSON.stringify(opts.settings() ?? null);
	/** 上一次**扇出给拓展**的那份 —— 写坏了又改回原样的,拓展没见过中间那份,不再叫一遍。 */
	let lastSettingsDelivered = lastSettingsSeen;
	registered.add(
		opts.onSettingsChanged(() => {
			const raw = opts.settings();
			const now = JSON.stringify(raw ?? null);
			if (now === lastSettingsSeen) return;
			lastSettingsSeen = now;
			const round = ++settingsRound;
			const settle = (verdict: StoredSettingsVerdict) => {
				// 判的已经是过时的那份(中间又落了一次盘),或者已经收摊了:作废。
				if (round !== settingsRound || disposed) return;
				if (!verdict.ok) return settingsUnreadable(verdict.detail);
				settingsProblem = undefined;
				for (const [schema, value] of verdict.values) settingsValues.set(schema, value);
				if (now === lastSettingsDelivered) return;
				lastSettingsDelivered = now;
				for (const fn of [...settingsListeners]) fn();
			};
			const schemas = [...handedSchemas];
			const sync = judgeStoredSettingsSync(schemas, settingsFields, raw);
			if (sync) {
				settle(sync);
				return;
			}
			judgeStoredSettings(schemas, settingsFields, raw)
				.then(settle)
				.catch((err) => logger.error(`设置变更的订阅者抛了:${(err as Error).message}`));
		}),
	);

	/** 报错 / 作恶各记一行就够 —— 每条连接一次,不然一条帧刷一行。 */
	const platformMismatchLogged = new Set<string>();

	function feed(
		route: "private" | "group",
		meta: InboundMeta,
		deliver: (meta: InboundMeta) => void,
	): void {
		const connection = own(meta.connectionId);
		if (!connection) {
			// 冒充别人的连接 —— 丢掉。主人身份比对走「平台 + 地址 + bot」三坐标,放过去
			// 就等于让一个拓展替别人说话。
			logger.warn(
				`丢掉一条${route === "private" ? "私聊" : "群"}消息:连接 ${meta.connectionId} 不是它的`,
			);
			return;
		}
		// 🔴 **平台以连接上那一格为准。** 它是主人身份比对的另一半(`inboundIdentity` →
		// `sameChatIdentity`,「绝不能跨平台比对」那条纪律就靠它),而拓展自报的那一格我们
		// 没有任何办法核。连接现在**有** platform(决策 45,面板建目标时也从这儿抄),宿主
		// 自己答得出来 —— 于是桥那边报错一格(或者作恶)也顶不成别的平台。
		if (meta.platform !== connection.platform) {
			if (!platformMismatchLogged.has(connection.id)) {
				platformMismatchLogged.add(connection.id);
				logger.warn(
					`连接 ${connection.id} 报的平台是 ${meta.platform},与它自己那一格 ${connection.platform} 对不上;按连接算`,
				);
			}
			deliver({ ...meta, platform: connection.platform });
			return;
		}
		deliver(meta);
	}

	/**
	 * 推送源那一口给面板的东西从哪来 —— 先核对清单开没开这一口,再按档取:v2 只认清单,
	 * v1 只认代码(收下时翻译成新形状)。
	 *
	 * 🔴 「注册的口 ⊆ 清单开的口」:不核的话,一个声明成订阅源的拓展照样能挂一个出口上来,
	 * 面板按清单把它归在订阅那一栏,推送目标页却凭空多出一档。
	 */
	function pushViewOf(
		def: Parameters<ExtensionContext["registerPushSource"]>[0],
	): ExtensionPushView {
		const { manifest } = opts;
		if (!manifestProvides(manifest).includes("push")) {
			const where = manifest.apiVersion === 1 ? "provides" : "contributes.push";
			throw new Error(`extension ${id}: 清单里没开推送源那一口(${where}),不能注册推送源`);
		}
		if (manifest.apiVersion === 1) {
			if (!("descriptor" in def) || !("configFields" in def)) {
				throw new Error(
					`extension ${id}: v1 清单的外观与连接配置项写在代码里,注册推送源时要交 descriptor 与 configFields`,
				);
			}
			// v1 交的是老名字,收下这一刻翻译过来 —— 宿主里只有新形状。
			return {
				display: displayFromV1(def.descriptor),
				connectionFields: def.configFields.map(fieldFromV1),
			};
		}
		if ("descriptor" in def || "configFields" in def) {
			throw new Error(
				`extension ${id}: v2 的外观与连接配置项写在清单的 contributes.push 里,代码里别再交 —— 两份会打架`,
			);
		}
		// 上面核对过开了这一口,这里一定有。
		return manifestPushView(manifest) as ExtensionPushView;
	}

	/**
	 * 设置项的两份声明(清单一份、`ctx.settings(schema)` 交一份 zod)在拿设置的那一刻对表,
	 * 每份 schema 对一次。v1 没有这回事:桥的设置是手写页,清单里什么都没声明。
	 */
	const settingsChecked = new WeakSet<ZodType>();
	function checkSettingsSchema(schema: ZodType): void {
		const { manifest } = opts;
		if (manifest.apiVersion === 1 || settingsChecked.has(schema)) return;
		assertConfigFieldsMatchSchema(id, schema, manifest.settings?.fields ?? []);
		settingsChecked.add(schema);
	}

	const ctx: ExtensionContext = {
		id,
		hostApiVersion: opts.hostApiVersion ?? EXTENSION_API_RANGE.current,
		hostVersion: opts.hostVersion ?? "0.0.0-dev",
		logger,
		setTimeout: (fn, ms) => (disposed ? refuse("setTimeout") : track(host.setTimeout(fn, ms))),
		setInterval: (fn, ms) => (disposed ? refuse("setInterval") : track(host.setInterval(fn, ms))),
		mount(handler) {
			// 卸载之后还来挂:不进表(那才是幽灵端点),但前缀照答 —— 拓展要的只是一段字符串。
			if (disposed) {
				refuse("mount");
				return extensionMountPrefix(id);
			}
			const handle = mounts.mount(id, handler);
			registered.add(handle);
			return handle.prefix;
		},
		registerPushSource(def) {
			if (disposed) {
				refuse("registerPushSource");
				throw new Error(`extension ${id} is already unloaded`);
			}
			if (pushSourceRegistered) throw new Error(`extension ${id} already registered a push source`);
			const view = pushViewOf(def);
			// 两份 config 声明对不上就别加载了 —— 放过去的症状是「面板上填了保存不了」
			// 或者「有个必填项面板上根本没有」,两种都很难查到源头。v1 只对冻结那天对的那几样。
			assertConfigFieldsMatchSchema(id, def.configSchema, view.connectionFields, {
				picked: def.listBots !== undefined,
				v1: opts.manifest.apiVersion === 1,
			});
			pushSourceRegistered = true;
			pushView = view;
			listBots = def.listBots;
			secretCodes = view.connectionFields.filter(isSecretField).map((f) => f.key);
			// 🔴 分发键由宿主填 —— 拓展自报的那份在这里被覆盖掉。
			const adapter: PlatformAdapter = { ...def.adapter, platforms: [id] };
			registered.add(adapters.register(adapter));
			return {
				connections: () => ownConnections(def.configSchema),
				onConnectionsChanged: (fn) => {
					if (disposed) return refuse("onConnectionsChanged");
					return track(opts.onConnectionsChanged(fn));
				},
			};
		},
		registerSubscriptionSource(def) {
			if (disposed) {
				refuse("registerSubscriptionSource");
				throw new Error(`extension ${id} is already unloaded`);
			}
			// 一个拓展就是一个平台(决策 9);要两个平台的那天再加一格子键。
			if (subscriptionSourceRegistered) {
				throw new Error(`extension ${id} already registered a subscription source`);
			}
			assertSubscriptionPort(def);
			subscriptionSourceRegistered = true;
			subscriptionSource = def;
			// 收摊时摘掉:之后再问解析门就是「没在跑」,不会叫到一个已经停了的拓展身上。
			registered.add({
				dispose() {
					subscriptionSource = undefined;
				},
			});
			return {
				subscriptions: ownSubscriptions,
				onSubscriptionsChanged: (fn) => {
					if (disposed) return refuse("onSubscriptionsChanged");
					return track(opts.onSubscriptionsChanged(fn));
				},
				reportPost: reporter("post"),
				reportLiveStart: reporter("liveStart"),
				reportLiveEnd: reporter("liveEnd"),
				reportLiveStatus: reporter("liveStatus"),
				reportProfile: reporter("profile"),
			};
		},
		inbound: {
			private: (msg, meta) =>
				feed("private", meta, (checked) => opts.inbound.onInboundPrivate?.(msg, checked)),
			group: (msg, meta) =>
				feed("group", meta, (checked) => opts.inbound.onInboundGroup?.(msg, checked)),
		},
		onUpgrade(handler) {
			if (disposed) {
				refuse("onUpgrade");
				return;
			}
			registered.add(opts.upgrades.register(id, handler));
		},
		publishView(fn) {
			if (disposed) {
				refuse("publishView");
				return;
			}
			if (!isV2) {
				logger.warn("v1 清单交状态走 publishStatus,publishView 不受理");
				return;
			}
			viewFn = fn;
		},
		publishStatus(fn) {
			if (disposed) {
				refuse("publishStatus");
				return;
			}
			// v2 走专口(决策 39):旧口收任意 JSON,async 回调在它那儿静默变成一份空视图。
			if (isV2) {
				logger.warn("v2 交视图走 ctx.publishView,publishStatus 不受理 —— 面板上这个拓展不会有视图");
				return;
			}
			statusOf = fn;
		},
		statusChanged() {
			if (disposed) {
				refuse("statusChanged");
				return;
			}
			// 窗口里已经挂着一发:这一喊由它带上 —— 它在这一喊之后才发,面板重读到的是这一喊之后的样子。
			if (statusTimer !== undefined) return;
			statusTimer = setTimeout(() => {
				statusTimer = undefined;
				opts.onStatusChanged?.();
			}, STATUS_CHANGED_COALESCE_MS);
		},
		settings<T>(schema: ZodType<T>): ExtensionSettings<T> {
			checkSettingsSchema(schema);
			// 先交后判:存着的那份解不开时,这份 zod 也得留给装载器 —— 改对了没有它就判不了能不能起。
			if (!disposed) handedSchemas.add(schema);
			const raw = opts.settings();
			const verdict = judgeStoredSettingsSync([schema], settingsFields, raw);
			if (verdict?.ok) {
				settingsValues.set(schema, verdict.values.get(schema));
			} else if (verdict) {
				// 当场抛:拓展不该拿着一份解不开的设置接着往下起。吞了这一抛也作数 —— 记在上面那一格。
				settingsUnreadable(verdict.detail);
				throw new ExtensionSettingsUnreadable(
					`extension ${id}: 存着的设置过不了交进来的这份 zod(${verdict.detail})—— BN 不会起它,面板上是「设置读不了」`,
				);
			} else {
				// 同步判不完(异步 refine):activate 里交的,装载器 activate 之后还会判一次;这里补上
				// 「之后才交」的那种 —— 判完才有 `get()` 可读,判坏了照样交给装载器收掉。
				const round = settingsRound;
				void judgeStoredSettings([schema], settingsFields, raw).then((late) => {
					if (round !== settingsRound || disposed) return;
					if (!late.ok) settingsUnreadable(late.detail);
					else if (!settingsValues.has(schema)) settingsValues.set(schema, late.values.get(schema));
				});
			}
			return {
				get: () => readSettings(schema),
				onChange: (fn: () => void) => {
					if (disposed) return refuse("settings.onChange");
					// 每个订阅者只往扇出名单里加一格 —— 「内容变没变」在上面那一处判过了。
					settingsListeners.add(fn);
					return track({ dispose: () => settingsListeners.delete(fn) });
				},
			};
		},
		onAction(name, handler) {
			if (disposed) {
				refuse("onAction");
				return;
			}
			if (!declaredActions) {
				throw new Error(
					`extension ${id}: 清单里没有 actions(v1 清单没有这一段),接不了动作 ${name}`,
				);
			}
			if (!declaredActions.has(name)) {
				throw new Error(`extension ${id}: 清单的 actions 里没有 ${name} —— 先在清单里声明`);
			}
			if (actionHandlers.has(name)) {
				throw new Error(`extension ${id}: 动作 ${name} 已经接过了`);
			}
			actionHandlers.set(name, handler);
		},
		onDispose(fn) {
			if (disposed) {
				refuse("onDispose");
				return;
			}
			hooks.push(fn);
		},
	};

	/**
	 * 上一次问视图时记过的那几句 —— 面板每刷一次就问一次,同一句只记一行。只留上一次那一份(不越攒
	 * 越多):一处好了又坏,会再记一次,那正是该再看见的时候。
	 */
	let lastViewProblems: ReadonlySet<string> = new Set();

	/**
	 * v2 交的视图**先核再下发**(ADR-0019 决策 40):坏的只换掉那一块 / 那一项,每一处都点名哪儿、
	 * 为什么 —— 静默吞掉的话,面板上那块就是一片空白,谁也不知道为什么。核法在 `view-check.ts`。
	 */
	function checkedView(fn: () => ExtensionView): ViewCheck {
		const input = {
			fields: settingsFields,
			// 「调拓展」的按钮只认清单声明过的动作(决策 42)。
			actions: opts.manifest.apiVersion === 2 ? (opts.manifest.actions ?? []) : [],
			// 现读:`items` 的键认的是**现在**存着的项。
			settings: opts.settings(),
		};
		let raw: unknown;
		try {
			raw = fn();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return faultedExtensionView(`publishView 的回调抛了:${message}`, input);
		}
		if (isThenable(raw)) {
			// 🔴 接住它后来的 reject:没人接的 rejection 在 Node 里默认让整个进程退出。
			Promise.resolve(raw).catch(() => {});
			return faultedExtensionView(
				"publishView 的回调要同步交回视图,交回的却是一个 Promise(async 回调就是这样)—— BN 不等它,也不把它当成一份空视图;要等的东西先算好存着,变了喊一声 statusChanged()",
				input,
			);
		}
		return checkExtensionView(raw, input);
	}

	function viewNow(): unknown {
		if (!viewFn) return undefined;
		const { view, problems } = checkedView(viewFn);
		const now = new Set(problems);
		for (const problem of now) {
			if (!lastViewProblems.has(problem)) logger.warn(`交上来的视图:${problem}`);
		}
		lastViewProblems = now;
		return view;
	}

	return {
		ctx,
		status: () => (isV2 ? viewNow() : statusOf?.()),
		pushSource: () => pushView,
		bots: () => listBots?.(),
		secretConfigCodes: () => secretCodes,
		settingsSchemas: () => [...handedSchemas],
		settingsProblem: () => settingsProblem,
		async verifySettings() {
			if (settingsProblem !== undefined) return settingsProblem;
			const schemas = [...handedSchemas];
			if (schemas.length === 0) return undefined;
			const round = settingsRound;
			const verdict = await judgeStoredSettings(schemas, settingsFields, opts.settings());
			// 判的时候又落了一次盘:以变更那一道的判决为准。
			if (round !== settingsRound) return settingsProblem;
			if (!verdict.ok) {
				settingsProblem = verdict.detail;
				return settingsProblem;
			}
			// 带异步规则的那几份到这儿才第一次有值可读。
			for (const [schema, value] of verdict.values) {
				if (!settingsValues.has(schema)) settingsValues.set(schema, value);
			}
			return undefined;
		},
		async runAction(name, runOpts = {}) {
			if (!declaredActions?.has(name)) return { ok: false, reason: "undeclared" };
			// 收摊一开始就把在跑的都叫停了 —— 钩子还没跑完时再起一发,就没人叫停它。
			const handler = disposed ? undefined : actionHandlers.get(name);
			if (!handler) return { ok: false, reason: "unhandled" };
			// 不排队、不并发(决策 42):两发一起跑,扫码登录就是两张码、两份轮询抢着存账号;排队的话,
			// 主人连按三下就在背后多跑两轮。
			const running = runningActions.get(name);
			if (running) return { ok: false, reason: "busy", aborted: running.signal.aborted };
			const timeoutMs = runOpts.timeoutMs ?? ACTION_TIMEOUT_MS;
			const controller = new AbortController();
			runningActions.set(name, controller);
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<ActionOutcome>((resolve) => {
				timer = setTimeout(() => {
					// 🔴 宿主不等了就叫它停:主人那头只看见一句「超时」,它却在背后接着把事做完(扫码登录
					// 会多存下一份账号)。TimeoutError 是 `AbortSignal.timeout()` 那个名字,拓展照惯例认得。
					controller.abort(
						new DOMException(
							`动作 ${name} 超过 ${timeoutMs / 1000} 秒没回,BN 不等了`,
							"TimeoutError",
						),
					);
					resolve({ ok: false, reason: "timeout" });
				}, timeoutMs);
			});
			const run = (async (): Promise<ActionOutcome> => {
				try {
					await handler(controller.signal);
					return { ok: true };
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					logger.warn(`动作 ${name} 抛了:${message}`);
					return { ok: false, reason: "failed", message };
				} finally {
					// 收摊时整张表已经清掉了 —— 只摘自己这一格。
					if (runningActions.get(name) === controller) runningActions.delete(name);
				}
			})();
			try {
				return await Promise.race([run, timeout]);
			} finally {
				clearTimeout(timer);
			}
		},
		async lookup(query, lookupOpts = {}) {
			// 收摊一开始就把在跑的都叫停了 —— 这时再起一发就没人叫停它。
			const source = disposed ? undefined : subscriptionSource;
			if (!source) return undefined;
			const timeoutMs = lookupOpts.timeoutMs ?? LOOKUP_TIMEOUT_MS;
			const controller = new AbortController();
			runningLookups.add(controller);
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<LookupOutcome>((resolve) => {
				timer = setTimeout(() => {
					// 宿主不等了就叫它停:面板那头已经是一句「超时」,它接着问平台只是白白多挨一次风控。
					controller.abort(
						new DOMException(`解析门超过 ${timeoutMs / 1000} 秒没回,BN 不等了`, "TimeoutError"),
					);
					resolve({ ok: false, reason: "timeout" });
				}, timeoutMs);
			});
			const run = (async (): Promise<LookupOutcome> => {
				try {
					// 同步交回、交回 Promise、同步抛都走这一处。
					const raw: unknown = await source.lookup(query, controller.signal);
					const parsed = SubscriptionCandidatesSchema.safeParse(raw);
					if (!parsed.success) {
						// 🔴 点名哪儿不对:吞成一句「出错了」的话,拓展作者只能对着黑盒猜。
						const message = formatZodIssues(parsed.error).join(";");
						logger.warn(`解析门交回的候选形状不对:${message}`);
						return { ok: false, reason: "invalid", message };
					}
					return { ok: true, candidates: parsed.data };
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					logger.warn(`解析门抛了:${message}`);
					return { ok: false, reason: "failed", message };
				} finally {
					runningLookups.delete(controller);
				}
			})();
			try {
				return await Promise.race([run, timeout]);
			} finally {
				clearTimeout(timer);
			}
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			// 挂着的那一发不发了:收摊之后再冒出一帧,面板会去重读一个已经停了的拓展。
			clearTimeout(statusTimer);
			statusTimer = undefined;
			// 🔴 在跑的动作先叫停,再跑收摊钩子 —— 钩子里能等它们收尾;不叫停的话,拓展都停了,它的
			// handler 还在背后接着轮询平台。
			for (const controller of runningActions.values()) {
				controller.abort(new DOMException(`拓展 ${id} 停用了`, "AbortError"));
			}
			runningActions.clear();
			// 在跑的解析同一条:拓展停了,它还在背后问平台就是白挨风控。
			for (const controller of runningLookups) {
				controller.abort(new DOMException(`拓展 ${id} 停用了`, "AbortError"));
			}
			runningLookups.clear();
			// 先跑拓展自己的收摊钩子(它可能要用还活着的定时器 / 端点收尾),再拆机件。
			// 后注册的先跑 —— 后建起来的东西通常依赖先建起来的。
			const pending = [...hooks].reverse();
			hooks.length = 0;
			let overdue = false;
			const hooksDone = (async () => {
				for (const fn of pending) {
					// 过了时限就不再往下跑:机件已经拆了,后面的钩子多半要用的正是它们。
					if (overdue) return;
					try {
						await fn();
					} catch (err) {
						// 一个钩子抛了不许打断其余的回收:收一半的拓展是最难查的那种。
						logger.error(`收摊钩子抛了:${(err as Error).message}`);
					}
				}
			})();
			// 🔴 钩子挂住不许把收摊一起挂住:收摊排在装载器那条队里,等它就是整条队陪着等。
			// 过了时限按已收摊处理 —— 下面拆机件那一段照走,半个拓展不留。
			const limit = opts.disposeTimeoutMs ?? DISPOSE_TIMEOUT_MS;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const deadline = new Promise<"overdue">((resolve) => {
				timer = setTimeout(() => resolve("overdue"), limit);
			});
			try {
				if ((await Promise.race([hooksDone, deadline])) === "overdue") {
					overdue = true;
					logger.warn(`收摊钩子 ${limit / 1000} 秒没跑完 —— 按已收摊处理,排在它后面的钩子不再跑`);
				}
			} finally {
				clearTimeout(timer);
			}
			for (const entry of registered) {
				try {
					entry.dispose();
				} catch (err) {
					logger.error(`回收注册项时抛了:${(err as Error).message}`);
				}
			}
			registered.clear();
			actionHandlers.clear();
			handedSchemas.clear();
			statusOf = undefined;
			viewFn = undefined;
			secretCodes = [];
		},
	};
}
