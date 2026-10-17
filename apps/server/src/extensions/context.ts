import type {
	ExtensionConnectionView,
	ExtensionContext,
	ExtensionOwnSubscription,
	ExtensionPushView,
	ExtensionSubscriptionCandidate,
	ExtensionSubscriptionView,
	ExtensionView,
	SettingsReader,
	SubscriptionSourceDef,
} from "@bilibili-notify/extension";
import {
	type Connection,
	checkReportedExternalId,
	checkSubscriptionReport,
	type Disposable,
	EXTENSION_API_RANGE,
	type ExtensionManifest,
	fail,
	formatZodIssues,
	type InboundHandlers,
	type Logger,
	manifestProvides,
	ok,
	type PlatformAdapter,
	type Result,
	type ServiceContext,
	SubscriptionCandidatesSchema,
	type SubscriptionReport,
	type SubscriptionReportDelivery,
	type SubscriptionReportKind,
	undeclaredReportReason,
} from "@bilibili-notify/internal";
import type { ZodType } from "zod";
import { t } from "../i18n/index.js";
import type { IntegrationStoreHandle } from "../integration-store/store.js";
import {
	type CreateIntegrationContextOptions,
	createIntegrationContext,
} from "../integrations/context.js";
import { LOOKUP_TIMEOUT_MS } from "../integrations/lookup-timeout.js";
import { createPlatformAdapterContext } from "../push/adapter-context.js";
import { pickAdapterMembers } from "../push/adapter-members.js";
import type { PlatformAdapterRegistry } from "../push/registry.js";
import { createKeyedCoalescer } from "../util/keyed-coalescer.js";
import { assertConfigFieldsMatchSchema } from "./config-fields.js";
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
 * 跑一个动作的结果。失败各有各的码与原话(规矩见 docs/agents/conventions/failure-results.md),
 * 并成一句「出错了」的话,面板只能对着黑盒猜:
 * - `unsupported`:清单里没这个名字,或声明了代码却没接;
 * - `timeout`:超时;
 * - `unavailable`:拓展自己抛了(`message` 是它的原话);
 * - `conflict`:同一个动作的上一发还没回来(决策 42:不排队、不并发)。上一发超时后已经叫停过、
 *   它却还没停的,话里说着 —— 主人要知道这不是自己按得太快。
 *
 * `message` 在这里造:这一层才知道动作名、拓展 id 和实际等了多久。路由原样交给 `respondFailure`。
 */
export type ActionOutcome = Result;

/**
 * `ctx.settings(schema)` 那一下,存着的那份过不了这份 zod(ADR-0019 决策 36)—— 拓展不该拿着
 * 它接着往下起。
 *
 * ⚠️ 装载器认的不是这一抛(拓展 try/catch 吞了它也照样作数),是记在 runtime 上的那一格
 * ({@link ExtensionRuntime.settingsProblem})。它是单独一类,只为了日志里一眼分得出。
 */
export class ExtensionSettingsUnreadable extends Error {}

/**
 * 问一次解析门的结果(ADR-0019 决策 52)。失败各有各的码与原话:`timeout` 超时,`unavailable` 拓展自己
 * 抛了(平台那头的事:cookie 过期、被风控),`invalid` 交回来的候选形状不对(拓展的 bug,`message`
 * 点名哪儿不对)—— 并成一句「出错了」的话,面板与作者都不知道该找谁。
 */
export type LookupOutcome = Result<{ candidates: readonly ExtensionSubscriptionCandidate[] }>;

/** 一个动作最多等多久。面板那头的按钮一直转着,比报一句超时更难受。 */
export const ACTION_TIMEOUT_MS = 30_000;

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
 * 一条「上报出入」(ADR-0019 决策 60):订阅源拓展报上来的东西,整条拒了或者动了几格(丢掉或截断)。
 *
 * 丢格与拒绝**只从一个出口出去**(ctx 里的 `recordDiscrepancy`):记一行 warn(行的标签就是拓展的 id,正文带原因),
 * 再交给 {@link CreateExtensionContextOptions.onReportDiscrepancy} —— 拓展详情页那个「上报出入」框
 * 接的就是它。散着写的话,框里迟早缺一类。
 */
export interface ReportDiscrepancy {
	extensionId: string;
	/** 什么时候(毫秒)。 */
	at: number;
	/** 报的哪一种。 */
	kind: SubscriptionReportKind;
	/** 拓展报的外部 id(不是字符串 / 太长的,截成一段能看的)。 */
	externalId: string;
	/** 它名下指向这个人的订阅(停用的也算)—— 「哪条订阅」那一栏。一条都没对上就是空表。 */
	subscriptionIds: readonly string[];
	/**
	 * `rejected`:整条拒了(`reasons` 只有一句);`dropped`:收下了,丢掉或截断了这几格(每格一句);`skipped`:周期
	 * 「正在直播」到点时上次推送之后没收到新的直播状态,这一轮没推(决策 61,`kind` 是 `liveStatus`,一句)
	 * —— 这一种不是 ctx 记的,是拓展直播的计时器(`live/live-push.ts`)记的。
	 */
	outcome: "rejected" | "dropped" | "skipped";
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

/** 单键的合并器用的那个键。 */
const STATUS_KEY = "status";

/**
 * 清单里推送源那一口的外观 + 连接配置项(ADR-0019 决策 17 / 41)。没开这一口就是 `undefined`。
 *
 * 注册推送源时与拓展列表下发时**共用这一份翻译** —— 停着的拓展列表照清单给,跑着的照注册时收下的给,
 * 两处各写一遍的话,哪天清单多一格,两边就说成两种样子。
 */
export function manifestPushView(manifest: ExtensionManifest): ExtensionPushView | undefined {
	const push = manifest.contributes.push;
	return push && { display: push.display, connectionFields: push.connection?.fields ?? [] };
}

/**
 * 清单里订阅源那一口给面板的东西:外观 + 会报哪几种事件(ADR-0019 决策 41)。没开这一口就是
 * `undefined`。
 *
 * 只从清单来、不问代码:停用的拓展名下的订阅照样画得出是哪个平台的(决策 10 的置灰)。自带皮肤的
 * 包内路径(`cardSkin`)不给面板 —— 那是装包那头的事。
 */
export function manifestSubscriptionView(
	manifest: ExtensionManifest,
): ExtensionSubscriptionView | undefined {
	const subscription = manifest.contributes.subscription;
	return subscription && { display: subscription.display, events: subscription.events };
}

/** 宿主这边握着的把手 —— 拓展拿不到它,所以拓展没法把自己从卸载里摘出去。 */
export interface ExtensionRuntime {
	readonly ctx: ExtensionContext;
	/**
	 * 拓展交上来的那份面板数据 —— 没交过就是 `undefined`。现取。
	 *
	 * 是宿主核过的视图(`ExtensionPanelView`:坏块 / 坏项换成了宿主的提示,见 `view-check.ts`)。
	 */
	status(): unknown;
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
	 * 在跑时回 `conflict`,不同的动作互不相干。
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
	 * 它的清单 —— 注册时按它核对「开没开这一口」,外观、连接配置项、设置项都从这儿读
	 * (ADR-0019 决策 16)。
	 */
	manifest: ExtensionManifest;
	/** 宿主的 ServiceContext —— 定时器的真身(日志器不从它拿,见 {@link loggerOf})。 */
	host: ServiceContext;
	/**
	 * 按集成键(拓展 id)要日志器:行的标签是它的 id、等级跟日志等级表里它自己那一格。拓展的行正文里不再拼
	 * `[ext:<id>]`。同一个 id 每次要到的是同一个日志器(装载器停了再起时等级不丢)。
	 */
	loggerOf: (id: string) => Logger;
	/**
	 * 这个拓展的两份小存储(装载器按 id 开、收摊后关)。`activate(ctx)` 与它的推送源 `start(ctx)` 拿到的是
	 * 同一对对象。
	 */
	stores: Pick<IntegrationStoreHandle, "state" | "secrets" | "redact">;
	/**
	 * 问题表的写口:拓展的 `reportProblem` 记在它的 id 名下,收摊时它名下的全清。被拒的(已停下、形状不对)
	 * 只记 warn —— 拓展自己的 bug,不进出入表(ADR-0025 决策 10 下 2026-10-15 那条)。
	 */
	problems: CreateIntegrationContextOptions["problems"];
	mounts: ExtensionMounts;
	/** 出口的活注册表。拓展注册的推送源往这里进。 */
	adapters: PlatformAdapterRegistry;
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
	/** 「上报出入」的出口(见 {@link ReportDiscrepancy})。日志 ctx 已经记了;不给就只记日志。 */
	onReportDiscrepancy?: (discrepancy: ReportDiscrepancy) => void;
	/** 它自己那份设置(`config/settings/extensions/<id>.json`),**现读**、原样。 */
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
	 * 窗口里的连喊只叫它一次,见 {@link STATUS_CHANGED_COALESCE_MS}。**只有拓展自己喊才叫它** —— 它说的是
	 * 「拓展的视图变了」;上报出入(决策 60)有自己那一声,在记录那头发,不走这里。
	 */
	onStatusChanged?: () => void;
	/**
	 * 这面 ctx **开始收摊**了(只叫一次)—— 拓展从这一刻起不在跑,再报什么都不收。停用、卸载、换代码、
	 * 加载失败、设置读不了、宿主关机都走 `dispose()`,所以「拓展不在跑了」只认这一处,不在装载器的
	 * 每条路上各记一遍(ADR-0019 决策 61:它名下的在播状态据此作废)。
	 */
	onDisposed?: () => void;
	/** 入站的两路收口。 */
	inbound: InboundHandlers;
	/** WS upgrade 的分发表。 */
	upgrades: ExtensionUpgrades;
	hostApiVersion?: number;
	/** 载荷版本号。测试里可以不给。 */
	hostVersion?: string;
	/** 收摊钩子一共等多久,见 `DISPOSE_TIMEOUT_MS`(`../integrations/context.ts`)。只有测试会换。 */
	disposeTimeoutMs?: number;
}

/** 拓展交回来的是不是一个 Promise(或别的 thenable)—— `publishView` 要的是同步交回的视图。 */
function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (
		(typeof value === "object" || typeof value === "function") &&
		value !== null &&
		typeof (value as { then?: unknown }).then === "function"
	);
}

/**
 * 给一个拓展开一面 ctx,外加宿主收回它的那个把手。
 *
 * 注册进来的每一样都记在这一份名册上,`dispose()` 一次清空 —— 这就是「启用 / 停用热」
 * 做得到的原因(决策 10:热的是**副作用**,不是代码;代码换不掉,那要重启)。
 */
export function createExtensionContext(opts: CreateExtensionContextOptions): ExtensionRuntime {
	const { id, host, mounts, adapters } = opts;
	const integration = createIntegrationContext({
		logger: opts.loggerOf(id),
		stopReason: `拓展 ${id} 停用了`,
		state: opts.stores.state,
		secrets: opts.stores.secrets,
		problems: opts.problems,
		reporter: id,
		rejectedProblemLevel: "warn",
		redactValues: (values) => opts.stores.redact("redact", values),
		disposeTimeoutMs: opts.disposeTimeoutMs,
		// 从这一刻起它的上报一概拒(`receiveReport` 先看 `disposed`),所以「不在跑了」在这里就说:
		// 之后不会再有它的上报把刚作废的在播状态又填回去。宿主那头抛了不许打断收摊。
		onStopping() {
			try {
				opts.onDisposed?.();
			} catch (err) {
				integration.ctx.logger.error(`通知宿主「拓展停了」时抛了:${(err as Error).message}`);
			}
			// 挂着的那一发不发了:收摊之后再冒出一帧,面板会去重读一个已经停了的拓展。
			statusCoalescer.cancelAll();
		},
	});
	const logger = integration.ctx.logger;

	/** `publishView` 交的回调 —— 每问一次叫一次,核过再下发。 */
	let viewFn: (() => ExtensionView) | undefined;
	let pushSourceRegistered = false;
	/**
	 * 清单声明过的动作名(决策 42:清单里只有名字的一串);清单里没有 `actions` 这一段就是
	 * `undefined`。建成 Set 查:名字是拓展与面板给的,拿普通对象按下标查会顺着原型链把
	 * `constructor` / `toString` 判成声明了。
	 */
	const declaredActions: ReadonlySet<string> | undefined = opts.manifest.actions
		? new Set(opts.manifest.actions)
		: undefined;
	/** 代码接了的动作。卸载时清空 —— 之后面板再按,就是「声明了却没接」。 */
	const actionHandlers = new Map<string, (signal: AbortSignal) => void | Promise<void>>();
	/**
	 * 在跑的动作 → 叫停它的那个把手。「在跑」算到 handler 真的回来为止(超时叫停了却不停的也算);
	 * 收摊时逐个叫停。
	 */
	const runningActions = new Map<string, AbortController>();
	let subscriptionSourceRegistered = false;
	/** 注册上来的订阅源(解析门在它身上);收摊时摘掉。 */
	let subscriptionSource: SubscriptionSourceDef | undefined;
	/** 在跑的解析 —— 收摊时逐个叫停。**不按名字挡并发**(决策 52:查询可以同时好几发)。 */
	const runningLookups = new Set<AbortController>();
	/** 「面板数据变了」的合并窗口(见 {@link STATUS_CHANGED_COALESCE_MS});整个拓展就这一个键。 */
	const statusCoalescer = createKeyedCoalescer({
		windowMs: STATUS_CHANGED_COALESCE_MS,
		onFire: () => opts.onStatusChanged?.(),
	});

	/** 属于这个拓展、且 settings 解得出来的那些。解不出的当它不存在并记一行。 */
	function ownConnections<TConfig>(
		schema: ZodType<TConfig>,
	): readonly ExtensionConnectionView<TConfig>[] {
		const views: ExtensionConnectionView<TConfig>[] = [];
		for (const connection of opts.connections()) {
			if (connection.adapterKey !== id) continue;
			const parsed = schema.safeParse(connection.settings);
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
	 */
	function assertSubscriptionPort(def: SubscriptionSourceDef): void {
		const { manifest } = opts;
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
	const declaredEvents = opts.manifest.contributes.subscription?.events ?? [];

	/** 拓展报的外部 id 念给人听:不是字符串的只说类型,太长的截一段。 */
	function externalIdPreview(raw: unknown): string {
		if (typeof raw !== "string") return `(${typeof raw})`;
		return raw.length > 64 ? `${raw.slice(0, 64)}…` : raw;
	}

	/**
	 * 「上报出入」**唯一**的出口(决策 60):记一行 warn(行的标签就是拓展的 id,正文带原因),再交给宿主 —— 拓展
	 * 详情页那个框接的就是它。丢格、整条拒都从这里过,别散着写。
	 */
	function recordDiscrepancy(discrepancy: Omit<ReportDiscrepancy, "extensionId" | "at">): void {
		const what = `${discrepancy.kind}(外部 id ${discrepancy.externalId})`;
		logger.warn(
			discrepancy.outcome === "rejected"
				? `上报 ${what} 整条拒了:${discrepancy.reasons.join(";")}`
				: `上报 ${what} 动了 ${discrepancy.reasons.length} 格:${discrepancy.reasons.join(";")}`,
		);
		opts.onReportDiscrepancy?.({ ...discrepancy, extensionId: id, at: Date.now() });
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
		if (integration.disposed) {
			integration.refuse(`上报 ${kind}`);
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
			recordDiscrepancy({
				kind,
				externalId,
				subscriptionIds,
				outcome: "rejected",
				reasons: [reason],
			});
			throw new Error(`BN 拒收这条 ${kind} 上报:${reason}`);
		};
		if (!idCheck.ok) return reject(idCheck.reason);
		const undeclared = undeclaredReportReason(kind, declaredEvents);
		if (undeclared !== undefined) return reject(undeclared);
		const checked = checkSubscriptionReport(kind, raw);
		if (!checked.ok) return reject(checked.reason);
		if (checked.dropped.length > 0) {
			recordDiscrepancy({
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
	 * 独立端装的处理器会把整个进程关掉;拒掉的原因已经从上报出入的出口记下了。拓展 `await` 它照样拿得到。
	 */
	function reporter(kind: SubscriptionReportKind) {
		return (externalId: unknown, raw: unknown): Promise<void> => {
			const pending = receiveReport(kind, externalId, raw);
			pending.catch(() => {});
			return pending;
		};
	}

	// ---- 自己的设置(ADR-0019 决策 36)----------------------------------------------------

	/** 清单声明的设置项 —— 点名「哪一格」时拿它念名字。 */
	const settingsFields = opts.manifest.settings?.fields ?? [];
	/** 交过的每一份(对表过了的才算),写设置时宿主拿它们再过一道。Set 保序、同一份只记一次。 */
	const handedSchemas = new Set<ZodType>();
	/**
	 * 每份 zod **最近一次的读法**(`get()` 回的就是它)—— 解析在「交进来」与「落盘了」那两下做完,
	 * 不挂在 `get()` 上。
	 *
	 * 🔴 不能「每问一次现读现解」:宿主那头是 `getExtensionSettings(id)`,每次都深拷贝一份、再过一遍
	 * 拓展的 zod —— 桥每握一次手问一次。
	 *
	 * 🔴 **存着的那份变得解不开时,这里换成 `invalid`**:拓展永远拿不到一份过不了它自己 zod 的值,
	 * 拿到的是带原因的失败,并且 `onChange` 叫一次(读得懂与读不懂之间翻了)。这一拍只持续到装载器
	 * 把它收掉(那要排队);拿它的人该像桥那样记着上一份好的。从前是「按没有算」给一个 `undefined`,
	 * 对桥就是名单一空、插件收 401、永久不再重连。
	 */
	const settingsReads = new Map<ZodType, Result<{ settings: unknown }>>();
	/** 存着的那份眼下解不开的原因;`undefined` = 解得开或没设过。装载器凭它判「设置读不了」。 */
	let settingsProblem: string | undefined;
	/** 第几次「这一格动了」—— 异步判完回来时,中间又动过的那一次判决作废。 */
	let settingsRound = 0;

	/** 记下「解不开」:`get()` 换成 `invalid`(交过的每一份都读不懂了,原因是整份设置的,不分哪份 zod)。 */
	function markUnreadable(detail: string): void {
		settingsProblem = detail;
		const unreadable = fail("invalid", detail);
		for (const schema of handedSchemas) settingsReads.set(schema, unreadable);
	}

	function settingsUnreadable(detail: string): void {
		markUnreadable(detail);
		opts.onSettingsInvalid?.();
	}

	/** 判决里一份 zod 的读法 → `get()` 回的结果。 */
	function readOf(read: { settings: unknown } | { notConfigured: string }) {
		return "settings" in read
			? ok({ settings: read.settings })
			: fail(
					"not_configured",
					t("extension.settings.notConfigured", { detail: read.notConfigured }),
				);
	}

	function readSettings<T>(schema: ZodType<T>): Result<{ settings: T }> {
		// 没有读法只有一种情况:交进来那一刻同步判不完(schema 里有异步 refine),异步那一道还没回来。
		// 不给「没设过」那种成功 —— 那在拓展眼里是有值可用,正是决策 36 要堵的那种误读;也不抛。
		return (settingsReads.get(schema) ??
			fail("unavailable", t("extension.settings.unavailable"))) as Result<{ settings: T }>;
	}

	/**
	 * 「我这一格动了」的扇出。
	 *
	 * 🔴 **去重游标只此一个,而且只在这里推**。从前是每个订阅者各自比一次同一个闭包变量:
	 * 第一个订阅者把游标推到最新,轮到第二个时「和上次一样」—— 于是**第二个订阅者永远
	 * 收不到**。宿主的通知是「globals 落盘了」,内容变没变是 ctx 的判断,判一次就够。
	 *
	 * 🔴 **先判再扇出**:新的那份过不了交过的 zod,`get()` 先换成 `invalid`(拓展拿不到那份坏值)、
	 * 记下原因交给装载器把它收掉,再叫订阅者(读得懂与读不懂之间翻了)(恢复备份、手改文件、关着时之外的
	 * 旁路写入都会走到这儿 —— 面板那条写路径在跑着时已经过过它的 zod)。
	 */
	const settingsListeners = new Set<() => void>();
	/** 上一次看见的设置(序列化),用来判「这次 globals 落盘动的是不是我这一格」。 */
	let lastSettingsSeen = JSON.stringify(opts.settings() ?? null);
	/** 上一次**扇出给拓展**的那份 —— 写坏了又改回原样的,拓展没见过中间那份,不再叫一遍。 */
	let lastSettingsDelivered = lastSettingsSeen;
	integration.track(
		opts.onSettingsChanged(() => {
			const raw = opts.settings();
			const now = JSON.stringify(raw ?? null);
			if (now === lastSettingsSeen) return;
			lastSettingsSeen = now;
			const round = ++settingsRound;
			const settle = (verdict: StoredSettingsVerdict) => {
				// 判的已经是过时的那份(中间又落了一次盘),或者已经收摊了:作废。
				if (round !== settingsRound || integration.disposed) return;
				if (verdict.ok) {
					settingsProblem = undefined;
					for (const [schema, read] of verdict.values) settingsReads.set(schema, readOf(read));
				} else {
					// 读不懂也是「变了」:`get()` 已经换成 invalid,订阅者要知道去重读。
					settingsUnreadable(verdict.detail);
				}
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

	/**
	 * 推送源那一口给面板的东西从哪来 —— 先核对清单开没开这一口,再取:只认清单。
	 *
	 * 🔴 「注册的口 ⊆ 清单开的口」:不核的话,一个声明成订阅源的拓展照样能挂一个出口上来,
	 * 面板按清单把它归在订阅那一栏,推送目标页却凭空多出一档。
	 */
	function pushViewOf(
		def: Parameters<ExtensionContext["registerPushSource"]>[0],
	): ExtensionPushView {
		const { manifest } = opts;
		if (!manifestProvides(manifest).includes("push")) {
			throw new Error(`extension ${id}: 清单里没开推送源那一口(contributes.push),不能注册推送源`);
		}
		if ("descriptor" in def || "configFields" in def) {
			throw new Error(
				`extension ${id}: 外观与连接配置项写在清单的 contributes.push 里,代码里别再交 —— 两份会打架`,
			);
		}
		// 上面核对过开了这一口,这里一定有。
		return manifestPushView(manifest) as ExtensionPushView;
	}

	/**
	 * 设置项的两份声明(清单一份、`ctx.settings(schema)` 交一份 zod)在拿设置的那一刻对表,
	 * 每份 schema 对一次。
	 */
	const settingsChecked = new WeakSet<ZodType>();
	function checkSettingsSchema(schema: ZodType): void {
		if (settingsChecked.has(schema)) return;
		assertConfigFieldsMatchSchema(id, schema, settingsFields);
		settingsChecked.add(schema);
	}

	/**
	 * 让一个在跑的动作 / 解析的 controller 听集成上下文的 `signal`:拓展停下时带着同一个原因叫停它,
	 * 结束时把监听摘掉(同一拓展可以同时跑好几发解析,不摘会越挂越多)。回的是那个「摘掉」。
	 */
	function linkToStop(controller: AbortController): () => void {
		const stop = integration.ctx.signal;
		if (stop.aborted) {
			controller.abort(stop.reason);
			return () => {};
		}
		const onStop = () => controller.abort(stop.reason);
		stop.addEventListener("abort", onStop, { once: true });
		return () => stop.removeEventListener("abort", onStop);
	}

	const ctx: ExtensionContext = {
		id,
		hostApiVersion: opts.hostApiVersion ?? EXTENSION_API_RANGE.current,
		hostVersion: opts.hostVersion ?? "0.0.0-dev",
		logger,
		state: integration.ctx.state,
		secrets: integration.ctx.secrets,
		signal: integration.ctx.signal,
		redact: integration.ctx.redact,
		reportProblem: integration.ctx.reportProblem,
		resolveProblem: integration.ctx.resolveProblem,
		setTimeout: (fn, ms) => {
			if (integration.disposed) return integration.refuse("setTimeout");
			// 一次性的:触发完就从名册上放掉,不然每调一次漏一个小对象,直到卸载。
			let fired = false;
			let tracked: Disposable | undefined;
			const inner = host.setTimeout(() => {
				fired = true;
				// 只从名册上摘掉:宿主那只已经跑完,不用再叫它(`fired` 之后 `tracked.dispose()` 不动 `inner`)。
				tracked?.dispose();
				fn();
			}, ms);
			tracked = integration.track({
				dispose() {
					if (!fired) inner.dispose();
				},
			});
			return {
				dispose() {
					// 触发之后再 dispose:宿主那只已经跑完,不再去叫它。
					if (!fired) tracked?.dispose();
				},
			};
		},
		setInterval: (fn, ms) =>
			integration.disposed
				? integration.refuse("setInterval")
				: integration.track(host.setInterval(fn, ms)),
		mount(handler) {
			// 卸载之后还来挂:不进表(那才是幽灵端点),但前缀照答 —— 拓展要的只是一段字符串。
			if (integration.disposed) {
				integration.refuse("mount");
				return extensionMountPrefix(id);
			}
			const handle = mounts.mount(id, handler);
			integration.track(handle);
			return handle.prefix;
		},
		registerPushSource(def) {
			if (integration.disposed) {
				integration.refuse("registerPushSource");
				throw new Error(`extension ${id} is already unloaded`);
			}
			if (pushSourceRegistered) throw new Error(`extension ${id} already registered a push source`);
			// 第三方 JS 不受类型约束:按旧契约打的适配器没有 start / stop,登记表一调就是一句「不是函数」。
			if (typeof def.adapter?.start !== "function" || typeof def.adapter?.stop !== "function") {
				throw new Error(
					`extension ${id}: 推送源的适配器要有 start(ctx) 与 stop() —— 这个拓展是按旧的契约打的,要换成配这一版 BN 的包`,
				);
			}
			// 候选口是必备成员(ADR-0024 决策 4):新建连接只能从候选里挑。旧的拓展拿 `listBots` 交 bot,
			// 现在要换成适配器的 `listConnectionCandidates`。
			if (typeof def.adapter.listConnectionCandidates !== "function") {
				throw new Error(
					`extension ${id}: 推送源的适配器要有 listConnectionCandidates(signal) —— 新建连接从它列出的候选里挑(旧契约的 listBots 换成它)`,
				);
			}
			const view = pushViewOf(def);
			// 两份 config 声明对不上就别加载了 —— 放过去的症状是「面板上填了保存不了」
			// 或者「有个必填项面板上根本没有」,两种都很难查到源头。
			// 连接一律是从候选里挑出来的(settings 由拓展交),所以按「挑出来的」对表。
			assertConfigFieldsMatchSchema(id, def.configSchema, view.connectionFields, { picked: true });
			pushSourceRegistered = true;
			// 🔴 分发键由宿主填 —— 拓展自报的那份在这里被覆盖掉。
			// `settingsSchema` 同样由宿主拿拓展交的 `configSchema` 填:宿主按它解 settings 再递给适配器。
			// 🔴 这一版不对拓展开放的成员(ADR-0024 决策 11)带了也不认:契约的类型已经排除它们,但第三方 JS 不受
			// 类型约束,原样展开的话带了就是活的 —— 没开放的口子先被人用上,以后就改不动它的形状。
			// 按成员表取、方法 bind 回拓展交上来的那个实例:拓展拿 class 写适配器(方法在原型上)是最常见的写法,
			// 展开会把原型上的方法整个丢掉。
			const adapter: PlatformAdapter = {
				...pickAdapterMembers(def.adapter, ["listAddressCandidates", "connectionAuth"]),
				adapterKey: id,
				settingsSchema: def.configSchema,
			} as PlatformAdapter;
			// 登记即 `start`。适配器拿到的上下文与交回给拓展的把手**不同形**:这里的 `ctx.connections()` 按
			// `adapterKey` 筛、`settings` 按 `configSchema` 解过、解不过的隔离;把手的 `connections()`
			// 回的是 `{ id, name, enabled, config }` 的视图(契约的字段名不在这一片改)。
			integration.track(
				adapters.register(
					adapter,
					createPlatformAdapterContext({
						integration: integration.ctx,
						adapterKey: id,
						settingsSchema: def.configSchema,
						connections: opts.connections,
						...(opts.connection ? { connection: opts.connection } : {}),
						inbound: opts.inbound,
						onConnectionsChanged: (fn) => integration.track(opts.onConnectionsChanged(fn)),
						problems: opts.problems,
						rejectedProblemLevel: "warn",
					}),
				),
			);
			return {
				connections: () => ownConnections(def.configSchema),
				onConnectionsChanged: (fn) => {
					if (integration.disposed) return integration.refuse("onConnectionsChanged");
					return integration.track(opts.onConnectionsChanged(fn));
				},
			};
		},
		registerSubscriptionSource(def) {
			if (integration.disposed) {
				integration.refuse("registerSubscriptionSource");
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
			integration.track({
				dispose() {
					subscriptionSource = undefined;
				},
			});
			return {
				subscriptions: ownSubscriptions,
				onSubscriptionsChanged: (fn) => {
					if (integration.disposed) return integration.refuse("onSubscriptionsChanged");
					return integration.track(opts.onSubscriptionsChanged(fn));
				},
				reportPost: reporter("post"),
				reportLiveStart: reporter("liveStart"),
				reportLiveEnd: reporter("liveEnd"),
				reportLiveStatus: reporter("liveStatus"),
				reportProfile: reporter("profile"),
			};
		},
		onUpgrade(handler) {
			if (integration.disposed) {
				integration.refuse("onUpgrade");
				return;
			}
			integration.track(opts.upgrades.register(id, handler));
		},
		publishView(fn) {
			if (integration.disposed) {
				integration.refuse("publishView");
				return;
			}
			viewFn = fn;
		},
		statusChanged() {
			if (integration.disposed) {
				integration.refuse("statusChanged");
				return;
			}
			// 窗口里已经挂着一发:这一喊由它带上 —— 它在这一喊之后才发,面板重读到的是这一喊之后的样子。
			statusCoalescer.touch(STATUS_KEY);
		},
		settings<T>(schema: ZodType<T>): SettingsReader<T> {
			checkSettingsSchema(schema);
			// 先交后判:存着的那份解不开时,这份 zod 也得留给装载器 —— 改对了没有它就判不了能不能起。
			if (!integration.disposed) handedSchemas.add(schema);
			const raw = opts.settings();
			const verdict = judgeStoredSettingsSync([schema], settingsFields, raw);
			if (verdict?.ok) {
				const read = verdict.values.get(schema);
				if (read) settingsReads.set(schema, readOf(read));
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
					if (round !== settingsRound || integration.disposed) return;
					if (!late.ok) settingsUnreadable(late.detail);
					else if (!settingsReads.has(schema)) {
						const read = late.values.get(schema);
						if (read) settingsReads.set(schema, readOf(read));
					}
				});
			}
			return {
				get: () => readSettings(schema),
				onChange: (fn: () => void) => {
					if (integration.disposed) return integration.refuse("settings.onChange");
					// 每个订阅者只往扇出名单里加一格 —— 「内容变没变」在上面那一处判过了。
					settingsListeners.add(fn);
					return integration.track({ dispose: () => settingsListeners.delete(fn) });
				},
			};
		},
		onAction(name, handler) {
			if (integration.disposed) {
				integration.refuse("onAction");
				return;
			}
			if (!declaredActions) {
				throw new Error(`extension ${id}: 清单里没有 actions,接不了动作 ${name}`);
			}
			if (!declaredActions.has(name)) {
				throw new Error(`extension ${id}: 清单的 actions 里没有 ${name} —— 先在清单里声明`);
			}
			if (actionHandlers.has(name)) {
				throw new Error(`extension ${id}: 动作 ${name} 已经接过了`);
			}
			actionHandlers.set(name, handler);
		},
		onDispose: integration.ctx.onDispose,
	};

	/**
	 * 上一次问视图时记过的那几句 —— 面板每刷一次就问一次,同一句只记一行。只留上一次那一份(不越攒
	 * 越多):一处好了又坏,会再记一次,那正是该再看见的时候。
	 */
	let lastViewProblems: ReadonlySet<string> = new Set();

	/**
	 * 交的视图**先核再下发**(ADR-0019 决策 40):坏的只换掉那一块 / 那一项,每一处都点名哪儿、
	 * 为什么 —— 静默吞掉的话,面板上那块就是一片空白,谁也不知道为什么。核法在 `view-check.ts`。
	 */
	function checkedView(fn: () => ExtensionView): ViewCheck {
		const input = {
			fields: settingsFields,
			// 「调拓展」的按钮只认清单声明过的动作(决策 42)。
			actions: opts.manifest.actions ?? [],
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
		status: viewNow,
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
				markUnreadable(verdict.detail);
				return settingsProblem;
			}
			// 带异步规则的那几份到这儿才第一次有值可读。
			for (const [schema, read] of verdict.values) {
				if (!settingsReads.has(schema)) settingsReads.set(schema, readOf(read));
			}
			return undefined;
		},
		async runAction(name, runOpts = {}) {
			if (!declaredActions?.has(name)) {
				return fail("unsupported", `拓展 ${id} 的清单里没有动作 ${name}`);
			}
			// 收摊一开始就把在跑的都叫停了 —— 钩子还没跑完时再起一发,就没人叫停它。
			const handler = integration.disposed ? undefined : actionHandlers.get(name);
			if (!handler) return fail("unsupported", `拓展 ${id} 声明了动作 ${name},代码却没接`);
			const timeoutMs = runOpts.timeoutMs ?? ACTION_TIMEOUT_MS;
			// 不排队、不并发(决策 42):两发一起跑,扫码登录就是两张码、两份轮询抢着存账号;排队的话,
			// 主人连按三下就在背后多跑两轮。
			const running = runningActions.get(name);
			if (running) {
				return fail(
					"conflict",
					running.signal.aborted
						? `动作 ${name} 的上一发超过 ${timeoutMs / 1000} 秒没回,已经叫它停下,可它还没停 —— 停下之前不接新的一发`
						: `动作 ${name} 的上一发还没回来 —— 回来之前不接新的一发`,
				);
			}
			const controller = new AbortController();
			const unlink = linkToStop(controller);
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
					resolve(fail("timeout", `动作 ${name} 超过 ${timeoutMs / 1000} 秒没回`));
				}, timeoutMs);
			});
			const run = (async (): Promise<ActionOutcome> => {
				try {
					await handler(controller.signal);
					return ok();
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					logger.warn(`动作 ${name} 抛了:${message}`);
					// 拓展抛了个没写原话的错时也得给一句:失败的话不许是空的。
					return fail(
						"unavailable",
						message.trim() === "" ? `动作 ${name} 抛了,没留原话` : message,
					);
				} finally {
					unlink();
					// 收摊时「在跑」的两张表要等收尾钩子跑完才清(见 `dispose`),所以这里只摘自己这一格,
					// 不碰别人(新一发占了这个名字的不动)。
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
			const source = integration.disposed ? undefined : subscriptionSource;
			if (!source) return undefined;
			const timeoutMs = lookupOpts.timeoutMs ?? LOOKUP_TIMEOUT_MS;
			const controller = new AbortController();
			const unlink = linkToStop(controller);
			runningLookups.add(controller);
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<LookupOutcome>((resolve) => {
				timer = setTimeout(() => {
					// 宿主不等了就叫它停:面板那头已经是一句「超时」,它接着问平台只是白白多挨一次风控。
					controller.abort(
						new DOMException(`解析门超过 ${timeoutMs / 1000} 秒没回,BN 不等了`, "TimeoutError"),
					);
					resolve(fail("timeout", `拓展 ${id} 的解析门超过 ${timeoutMs / 1000} 秒没回`));
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
						return fail("invalid", `拓展交回的候选不合规矩:${message}`);
					}
					return ok({ candidates: parsed.data });
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					logger.warn(`解析门抛了:${message}`);
					return fail("unavailable", `拓展查询出错:${message}`);
				} finally {
					unlink();
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
			if (integration.disposed) return;
			// 在跑的动作 / 解析听 `integration.ctx.signal`(见 `linkToStop`):收摊钩子开始跑时它们已经叫停了。
			await integration.dispose();
			runningActions.clear();
			runningLookups.clear();
			actionHandlers.clear();
			handedSchemas.clear();
			viewFn = undefined;
		},
	};
}
