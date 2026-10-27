import type { ReportDiscrepancyKind } from "@bilibili-notify/contract";
import {
	type CapabilitySupport,
	type Connection,
	type ConnectionCapabilities,
	type Disposable,
	EXTENSION_API_RANGE,
	type ExtensionManifest,
	fail,
	type Identity,
	type InboundHandlers,
	type Issue,
	type Logger,
	OffsetIsoTimeSchema,
	ok,
	type PlatformAdapter,
	type PlatformAdapterDescriptor,
	type Result,
	type ServiceContext,
	type SettingsReader,
} from "@bilibili-notify/internal";
import type {
	ExtensionContext,
	ExtensionI18n,
	PlatformAdapterDef,
	PlatformAdapterHandle,
	SourceDef,
} from "@bilibili-notify/internal/extension";
import type { ExtensionView } from "@bilibili-notify/internal/extension/wire";
import { type Dict, translate } from "@bilibili-notify/internal/i18n";
import type { ZodType } from "zod";
import { t } from "../i18n/index.js";
import type { LocaleReader } from "../i18n/locale-reader.js";
import type { ImageStore } from "../images/image-store.js";
import type { IntegrationStoreHandle } from "../integration-store/store.js";
import {
	type CreateIntegrationContextOptions,
	createIntegrationContext,
} from "../integrations/context.js";
import { createPlatformAdapterContext } from "../push/adapter-context.js";
import { pickAdapterMembers } from "../push/adapter-members.js";
import type { PlatformAdapterRegistry } from "../push/registry.js";
import type { PipelineRuntime } from "../runtime/pipeline.js";
import { errorMessageOf } from "../util/error-message.js";
import { catchThenableRejection, isThenable } from "../util/is-thenable.js";
import { createKeyedCoalescer } from "../util/keyed-coalescer.js";
import { assertConfigFieldsMatchSchema } from "./config-fields.js";
import { createExtensionSource } from "./extension-source.js";
import { type ExtensionLocales, localizeManifest, runtimeDictOf } from "./locales.js";
import { type ExtensionMounts, extensionMountPrefix } from "./mount.js";
import {
	judgeStoredSettings,
	judgeStoredSettingsSync,
	type StoredSettingsVerdict,
} from "./settings-io.js";
import type { ExtensionUpgrades } from "./upgrade.js";
import { checkExtensionView, faultedExtensionView, type ViewCheck } from "./view-check.js";

/**
 * 拓展契约的本体住 `@bilibili-notify/internal/extension` 与 `/extension/wire`;
 * 这里只有宿主这一侧:谁来造 ctx、谁来收摊。
 */

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

/** 一个动作最多等多久。面板那头的按钮一直转着,比报一句超时更难受。 */
export const ACTION_TIMEOUT_MS = 30_000;

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
	/** 报的哪一种(第 3 版的 `post` / `live` / `profile` / `problem`,加第 2 版的五种,后者随旧上报口一起删)。 */
	kind: ReportDiscrepancyKind;
	/** 拓展报的外部 id(不是字符串 / 太长的,截成一段能看的);问题上报在集成、适配器层没有这一格。 */
	externalId?: string;
	/** 它名下指向这个人的订阅(停用的也算)—— 「哪条订阅」那一栏。一条都没对上就是空表。 */
	subscriptionIds: readonly string[];
	/**
	 * `rejected`:整条拒了(`reasons` 只有一句);`dropped`:收下了,丢掉或截断了这几格(每格一句)。
	 */
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

/** 单键的合并器用的那个键。 */
const STATUS_KEY = "status";

/**
 * 清单里推送源那一口的外观 + 连接配置项(ADR-0019 决策 17 / 41)。没开这一口就是 `undefined`。
 *
 * 注册推送源时与拓展列表下发时**共用这一份翻译** —— 停着的拓展列表照清单给,跑着的照注册时收下的给,
 * 两处各写一遍的话,哪天清单多一格,两边就说成两种样子。
 */
export function manifestPushView(
	manifest: ExtensionManifest,
): PlatformAdapterDescriptor | undefined {
	const push = manifest.contributes.push;
	return push && { ...push, settingsFields: push.settingsFields ?? [] };
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
	 * 这个拓展的登记(平台适配器、订阅源)都落定了没有:登记是后台异步的(登记即 `start`),装载器在 `activate`
	 * 之后等它 —— 有一份失败就回失败(原话带着),这一次加载就失败。什么都没登记就是成功。
	 */
	registrationsSettled(): Promise<Result>;
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
	 * 这个拓展自己的请求客户端(装载器在开存储之后造:身份存它自己的 `state`、罐子存它自己的 `secrets`),
	 * 连接池与最后一次存盘由装载器在收摊时收。`ctx.http` / `ctx.fetchImage` 都经它。
	 */
	http: CreateIntegrationContextOptions["http"];
	/** 图库「集成在途」那一家的写口:`ctx.fetchImage` / `ctx.storeImage` 存的图经它。 */
	transitImages: CreateIntegrationContextOptions["transitImages"];
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
	/**
	 * 把拓展的订阅源登进来源登记表(推送链路的 `registerSource`,登记即 `start`)。不给就是这台宿主没接来源登记表,
	 * 拓展的 `ctx.registerSource` 抛。
	 */
	registerSource?: PipelineRuntime["registerSource"];
	/**
	 * 事件里没带作者名时补的名字(资料名 → 身份标签,推送链路的 `fallbackCreatorName`)。不给就退外部 id。
	 */
	fallbackCreatorName?: (identity: Identity) => string;
	/** 图库读口(`ImageStore.read`):拓展作品图按引用读回字节补宽高与动图标记。不给就读不到(只放引用)。 */
	images?: Pick<ImageStore, "read">;
	/**
	 * 按身份找到这个来源名下的全部订阅 id(停用的也算),用于「上报出入」的关联栏。
	 * 来源自己的名单仍走核心 `SourceContext`,这里只补展示用的订阅 id。
	 */
	subscriptionIdsOf?: (identity: Identity) => readonly string[];
	/** 「上报出入」的出口(见 {@link ReportDiscrepancy})。日志 ctx 已经记了;不给就只记日志。 */
	onReportDiscrepancy?: (discrepancy: ReportDiscrepancy) => void;
	/**
	 * 它包里读到的译文(读目录时读好的,`ctx.i18n.t` 取字的来源)。**起的那一刻定死** —— 跑着时盘上
	 * 换了译文标「等着换上」,不偷偷换(ADR-0012 决策 47)。没带译文就是空的。
	 */
	locales: ExtensionLocales;
	/** 当前语言的读口(ADR-0037 决策 1:出字那一刻读)。`ctx.i18n.locale()` / `onChange` 都经它。 */
	localeReader: LocaleReader;
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

/**
 * 给一个拓展开一面 ctx,外加宿主收回它的那个把手。
 *
 * 注册进来的每一样都记在这一份名册上,`dispose()` 一次清空 —— 这就是「启用 / 停用热」
 * 做得到的原因(决策 10:热的是**副作用**,不是代码;代码换不掉,那要重启)。
 */
export function createExtensionContext(opts: CreateExtensionContextOptions): ExtensionRuntime {
	const { id, host, mounts, adapters } = opts;
	/** 每种语言的清单名只合一次(出字那一刻读当前语言,与装载器列表那条路同一套回落链)。 */
	const manifestNames = new Map<string, string>();
	function manifestName(): string {
		const locale = opts.localeReader.current();
		let name = manifestNames.get(locale);
		if (name === undefined) {
			name = localizeManifest(opts.manifest, opts.locales, locale).name;
			manifestNames.set(locale, name);
		}
		return name;
	}
	const integration = createIntegrationContext({
		logger: opts.loggerOf(id),
		stopReason: `拓展 ${id} 停用了`,
		state: opts.stores.state,
		secrets: opts.stores.secrets,
		problems: opts.problems,
		reporter: id,
		label: manifestName,
		rejectedProblemLevel: "warn",
		onRejectedProblem: recordRejectedProblem,
		redactValues: (values) => opts.stores.redact("redact", values),
		http: opts.http,
		transitImages: opts.transitImages,
		// 拓展自己的实现(见 `readOwnSettings`):对表、记「设置读不了」;监听都经 `integration.track`,不另需收摊。
		settings: { settings: (schema) => readOwnSettings(schema), dispose() {} },
		disposeTimeoutMs: opts.disposeTimeoutMs,
		// 从这一刻起它的上报一概拒(上报上下文先看 `disposed`),所以「不在跑了」在这里就说:
		// 之后不会再有它的上报把刚作废的在播状态又填回去。宿主那头抛了不许打断收摊。
		onStopping() {
			// 两种登记(平台适配器、订阅源)一进门就撤:摘表 + 叫 `stop()`,此时 `signal` 还没中止 ——
			// 契约许诺的正是这段(ADR-0025 决策 5)。每样单独兜底(`revokeRegistration` 里),一样抛了
			// 不影响撤下一样,后面的 `onDisposed` / 面板通知照跑。
			for (const slot of registrations) revokeRegistration(slot);
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

	/**
	 * 宿主栈上同步叫到拓展回调的那几处共用的一道闸:语言 / 设置的变更通知、适配器的连接变更、定时器。
	 * 拓展的回调是第三方代码,同步抛了、或交回一个被拒的 Promise(`() => void` 放得进 async 函数),
	 * 都只记一行带原话与口名的 error,**绝不沿宿主这一发往外抛** —— 同步的变更通知冒出去会掐断排在
	 * 后面的监听、把「写设置」那一请求一起带走;定时器冒出去就是 uncaughtException,被拒的 Promise
	 * 没人接就是 unhandledRejection(进程直接没了)。
	 * 只包拓展交的回调,不碰宿主那面的簿记(一次性定时器跑完摘登记照走)。
	 */
	function wrapHandler(what: string, fn: () => void): () => void {
		const report = (err: unknown) => {
			logger.error(`拓展 ${id} 的 ${what} 回调抛了:${errorMessageOf(err)}`);
		};
		return () => {
			try {
				const result: unknown = fn();
				// `() => void` 放得进 async 函数:交回被拒的 Promise 也是同一类,宿主那面没人 await 它。
				if (isThenable(result)) void Promise.resolve(result).catch(report);
			} catch (err) {
				report(err);
			}
		};
	}

	/** `publishView` 交的回调 —— 每问一次叫一次,核过再下发。 */
	let viewFn: (() => ExtensionView) | undefined;
	let adapterRegistered = false;
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
	let sourceRegistered = false;
	/**
	 * 拓展的两种登记(平台适配器、订阅源)共用的一条生命周期。登记即 `start`,落定之前拓展可能已经
	 * 调了把手、或者收摊了;落定之后也可能随时收摊。每份登记记一格:
	 *
	 * - `settled`:落定的结果(`registrationsSettled()` 等全部;装载器据此判这次加载成不成);
	 * - `revoke`:落定之后才有的撤口(摘表 + 叫 `stop()`),幂等;
	 * - `revokeRequested`:已经有人要撤(拓展的把手、`onStopping`、名册兜底)。
	 *
	 * 落定那一刻看这一格:已请求撤 / 已收摊就当场撤,不留孤儿。收摊时 `onStopping` 先逐个撤
	 * (此时 `signal` 还没中止),名册里那一份只作兜底。
	 */
	type RegistrationKind = "adapter" | "source";
	interface RegistrationSlot {
		what: RegistrationKind;
		settled: Promise<Result>;
		revoke?: () => void;
		revokeRequested: boolean;
	}
	const registrations: RegistrationSlot[] = [];

	function revokeRegistration(slot: RegistrationSlot): void {
		slot.revokeRequested = true;
		const revoke = slot.revoke;
		// 还没落定:落定那一刻看这一格,当场撤。
		if (!revoke) return;
		// 幂等:撤过就把口放掉,名册兜底 / 把手再来都不再叫它第二遍。
		slot.revoke = undefined;
		try {
			revoke();
		} catch (err) {
			// 一样抛了不许耽误撤下一样。
			logger.error(
				`撤${slot.what === "adapter" ? "平台适配器" : "订阅源"}登记时抛了:${errorMessageOf(err)}`,
			);
		}
	}

	/**
	 * 收一份登记。平台适配器与订阅源的登记都是异步落定的(登记即 `start`,它可以是异步的),
	 * 这里两种都收(`isThenable`),落定后的记账与撤法只有这一处。
	 *
	 * 同步抛的照旧原样抛给调用方(交进登记表之前的校验错误就是这条路径:装载器按 `activate` 失败处理);
	 * 异步拒的落成 `settled` 的失败(登记表 / 来源的 `start` 拒了,装载器等它)。
	 */
	function adoptRegistration(
		what: RegistrationKind,
		register: () => Disposable | Promise<Disposable>,
	): RegistrationSlot {
		const registered: unknown = register();
		const slot: RegistrationSlot = {
			what,
			settled: Promise.resolve(ok()),
			revokeRequested: false,
		};
		registrations.push(slot);
		const adopt = (registration: Disposable): Result => {
			slot.revoke = () => registration.dispose();
			// 落定那一刻已经要撤(拓展早撤 / 收摊):当场撤。
			if (slot.revokeRequested || integration.disposed) revokeRegistration(slot);
			return ok();
		};
		const reject = (err: unknown): Result => {
			logger.warn(
				`${what === "adapter" ? "平台适配器" : "订阅源"}登记失败: ${errorMessageOf(err)}`,
			);
			return fail("unavailable", errorMessageOf(err));
		};
		slot.settled = isThenable(registered)
			? Promise.resolve(registered).then(
					(registration) => adopt(registration as Disposable),
					reject,
				)
			: Promise.resolve(adopt(registered as Disposable));
		// 名册里那一份是兜底:`onStopping` 已经先撤过,这里幂等。
		integration.track({ dispose: () => revokeRegistration(slot) });
		return slot;
	}

	/** 全部登记落定的结果:有一份失败就是失败(第一次失败的)。没登记过是成功。 */
	async function registrationsSettled(): Promise<Result> {
		for (const slot of [...registrations]) {
			const settled = await slot.settled;
			if (!settled.ok) return settled;
		}
		return ok();
	}
	/** 「面板数据变了」的合并窗口(见 {@link STATUS_CHANGED_COALESCE_MS});整个拓展就这一个键。 */
	const statusCoalescer = createKeyedCoalescer({
		windowMs: STATUS_CHANGED_COALESCE_MS,
		onFire: () => opts.onStatusChanged?.(),
	});

	/**
	 * 拓展交来的能力时刻不合格的提醒,按「连接 + 能力格」去重:同一条连接同一格只刷一次;
	 * 下次交对了就把键清掉(再交坏时还能提醒)。
	 */
	const badCapabilityCheckedAt = new Set<string>();

	/**
	 * 拓展适配器交来的能力时刻进门一律验,判据照 3b-49 的拓展上报:`OffsetIsoTimeSchema`
	 * (`z.iso.datetime({ offset: true })`);收下后统一成 `Z` 结尾的 UTC(`toISOString()` 的写法)。
	 * 验不过的那一格当「还不知道」并记一行 warn —— 拓展是第三方 JS,类型管不住它交什么。
	 */
	function normalizeCapabilityCheckedAt(
		connectionId: string,
		slot: keyof ConnectionCapabilities,
		support: CapabilitySupport,
	): CapabilitySupport {
		if (support.state === "unknown") return support;
		const parsed = OffsetIsoTimeSchema.safeParse(support.checkedAt);
		const key = `${connectionId}\u0000${slot}`;
		if (!parsed.success) {
			if (!badCapabilityCheckedAt.has(key)) {
				badCapabilityCheckedAt.add(key);
				logger.warn(
					`拓展 ${id} 交来的能力 ${slot}.checkedAt 不是带时区的 ISO(连接 ${connectionId},收到 ${JSON.stringify(support.checkedAt)}),这一格按「还不知道」算`,
				);
			}
			return { state: "unknown" };
		}
		badCapabilityCheckedAt.delete(key);
		return { ...support, checkedAt: new Date(parsed.data).toISOString() };
	}

	function normalizeCapabilities(
		connection: Connection,
		capabilities: ConnectionCapabilities,
	): ConnectionCapabilities {
		return {
			atAll: normalizeCapabilityCheckedAt(connection.id, "atAll", capabilities.atAll),
			inbound: normalizeCapabilityCheckedAt(connection.id, "inbound", capabilities.inbound),
			nativeShare: normalizeCapabilityCheckedAt(
				connection.id,
				"nativeShare",
				capabilities.nativeShare,
			),
		};
	}

	/**
	 * 平台适配器那一口的 def:六个行为成员与自己的设置 schema 一次交齐。第三方 JS 不受类型约束,缺了不能等
	 * 登记表或派发器运行时才炸成「不是函数」(ADR-0024 决策 4 / 11)。
	 */
	function assertPlatformAdapterDef(def: PlatformAdapterDef): void {
		for (const member of [
			"start",
			"stop",
			"send",
			"isAvailable",
			"probe",
			"listConnectionCandidates",
		] as const) {
			if (typeof def?.[member] !== "function") {
				throw new Error(`extension ${id}: a platform adapter needs ${member}()`);
			}
		}
		if (typeof def.settingsSchema?.safeParse !== "function") {
			throw new Error(`extension ${id}: a platform adapter needs settingsSchema with safeParse()`);
		}
		if ("descriptor" in def) {
			throw new Error(
				`extension ${id}: the platform adapter descriptor belongs in contributes.push, not in code`,
			);
		}
	}

	/**
	 * 第 3 版订阅源那一口:清单得开了 `contributes.subscription`(「注册的口 ⊆ 清单开的口」),
	 * 必交 `start` / `stop` / `searchCreators` —— 第三方 JS 不受类型约束,缺了的话每一次叫到都是一句「不是函数」。
	 *
	 * 清单显式声明了周期直播(`supportedFeatures` 含 `liveStreaming`)就必须交 `fetchLiveStatus`:
	 * 周期「正在直播」只由核心按每一场的开播时刻计时、调来源的拉取式状态(ADR-0021 决策 27、38),推送这头没有
	 * 自己的计时,缺了就是声明了却永远不会推。不合就抛,这次加载失败。
	 */
	function assertSourceDef(def: SourceDef): void {
		if (!opts.manifest.contributes.subscription) {
			throw new Error(
				`extension ${id}: manifest has no contributes.subscription, cannot register a source`,
			);
		}
		for (const member of ["start", "stop", "searchCreators"] as const) {
			if (typeof def?.[member] !== "function") {
				throw new Error(`extension ${id}: a source needs ${member}()`);
			}
		}
		const declared = opts.manifest.contributes.subscription.supportedFeatures;
		if (declared.includes("liveStreaming") && typeof def.fetchLiveStatus !== "function") {
			throw new Error(
				`extension ${id}: contributes.subscription.supportedFeatures includes liveStreaming, so the source needs fetchLiveStatus()`,
			);
		}
	}

	// ---- 订阅源的上报(ADR-0019 决策 7 / 57 / 59 / 60 / 62)------------------------------------------

	/** 「上报出入」里「哪条订阅」那一栏:停用的也算;不在名单里就是空表。 */
	function subscriptionIdsOf(externalId: string): readonly string[] {
		return opts.subscriptionIdsOf?.({ sourceKey: id, externalId }) ?? [];
	}

	/**
	 * 「上报出入」**唯一**的出口(决策 60):记一行 warn(行的标签就是拓展的 id,正文带原因),再交给宿主 —— 拓展
	 * 详情页那个框接的就是它。丢格、整条拒都从这里过,别散着写。
	 */
	function recordDiscrepancy(discrepancy: Omit<ReportDiscrepancy, "extensionId" | "at">): void {
		const what =
			discrepancy.externalId === undefined
				? discrepancy.kind
				: `${discrepancy.kind}(外部 id ${discrepancy.externalId})`;
		logger.warn(
			discrepancy.outcome === "rejected"
				? `上报 ${what} 整条拒了:${discrepancy.reasons.join(";")}`
				: `上报 ${what} 动了 ${discrepancy.reasons.length} 格:${discrepancy.reasons.join(";")}`,
		);
		opts.onReportDiscrepancy?.({ ...discrepancy, extensionId: id, at: Date.now() });
	}

	/** 三层上下文里被拒的问题上报都从这里进「上报出入」;外部 id 只有来源层带。 */
	function recordRejectedProblem(rejection: { externalId?: string; reason: string }): void {
		recordDiscrepancy({
			kind: "problem",
			...(rejection.externalId === undefined ? {} : { externalId: rejection.externalId }),
			subscriptionIds:
				rejection.externalId === undefined ? [] : subscriptionIdsOf(rejection.externalId),
			outcome: "rejected",
			reasons: [rejection.reason],
		});
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
	function markUnreadable(unreadable: { detail: string; issues: Issue[] }): void {
		settingsProblem = unreadable.detail;
		const failure = fail("invalid", unreadable.detail, { issues: unreadable.issues });
		for (const schema of handedSchemas) settingsReads.set(schema, failure);
	}

	function settingsUnreadable(unreadable: { detail: string; issues: Issue[] }): void {
		markUnreadable(unreadable);
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
					settingsUnreadable(verdict);
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

	/**
	 * 拓展的 `ctx.settings(规则)`:对表清单、记「设置读不了」、认异步规则,与内置集成的读手不同。
	 * 函数声明(会提升):`createIntegrationContext` 在 `integration` 赋值之前就把它收进选项,
	 * 它只在集成上下文回来之后才会被调。
	 */
	function readOwnSettings<T>(schema: ZodType<T>): SettingsReader<T> {
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
			settingsUnreadable(verdict);
			throw new ExtensionSettingsUnreadable(
				`extension ${id}: 存着的设置过不了交进来的这份 zod(${verdict.detail})—— BN 不会起它,面板上是「设置读不了」`,
			);
		} else {
			// 同步判不完(异步 refine):activate 里交的,装载器 activate 之后还会判一次;这里补上
			// 「之后才交」的那种 —— 判完才有 `get()` 可读,判坏了照样交给装载器收掉。
			const round = settingsRound;
			void judgeStoredSettings([schema], settingsFields, raw).then((late) => {
				if (round !== settingsRound || integration.disposed) return;
				if (!late.ok) settingsUnreadable(late);
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
				// 名单里放包过闸的那份,摘的时候也得摘它。
				const listener = wrapHandler("settings.onChange", fn);
				settingsListeners.add(listener);
				return integration.track({ dispose: () => settingsListeners.delete(listener) });
			},
		};
	}

	// 每种语言的平实版只合一次(译文起的那一刻就定死了,见 `CreateExtensionContextOptions.locales`)。
	const runtimeDicts = new Map<string, Dict>();
	const i18n: ExtensionI18n = {
		locale: () => opts.localeReader.current(),
		t(key, values) {
			const locale = opts.localeReader.current();
			let dict = runtimeDicts.get(locale);
			if (dict === undefined) {
				dict = runtimeDictOf(opts.locales, locale);
				runtimeDicts.set(locale, dict);
			}
			return translate(dict, locale, key, values);
		},
		onChange(fn) {
			if (integration.disposed) return integration.refuse("i18n.onChange");
			return integration.track(opts.localeReader.onChange(wrapHandler("i18n.onChange", fn)));
		},
	};

	const ctx: ExtensionContext = {
		id,
		hostApiVersion: opts.hostApiVersion ?? EXTENSION_API_RANGE.current,
		hostVersion: opts.hostVersion ?? "0.0.0-dev",
		logger,
		i18n,
		state: integration.ctx.state,
		secrets: integration.ctx.secrets,
		signal: integration.ctx.signal,
		redact: integration.ctx.redact,
		reportProblem: integration.ctx.reportProblem,
		resolveProblem: integration.ctx.resolveProblem,
		http: integration.ctx.http,
		fetchImage: integration.ctx.fetchImage,
		storeImage: integration.ctx.storeImage,
		setTimeout: (fn, ms) => {
			if (integration.disposed) return integration.refuse("setTimeout");
			// 一次性的:触发完就从名册上放掉,不然每调一次漏一个小对象,直到卸载。
			let fired = false;
			let tracked: Disposable | undefined;
			const run = wrapHandler("setTimeout", fn);
			const inner = host.setTimeout(() => {
				fired = true;
				// 只从名册上摘掉:宿主那只已经跑完,不用再叫它(`fired` 之后 `tracked.dispose()` 不动 `inner`)。
				tracked?.dispose();
				run();
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
				: integration.track(host.setInterval(wrapHandler("setInterval", fn), ms)),
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
		registerPlatformAdapter(def) {
			if (integration.disposed) {
				integration.refuse("registerPlatformAdapter");
				throw new Error(`extension ${id} is already unloaded`);
			}
			if (adapterRegistered) {
				throw new Error(`extension ${id} already registered a platform adapter`);
			}
			// 🔴 「注册的口 ⊆ 清单开的口」:不核的话,一个声明成订阅源的拓展照样能挂一个出口上来,
			// 面板按清单把它归在订阅那一栏,推送目标页却凭空多出一档。
			const view = manifestPushView(opts.manifest);
			if (!view) {
				throw new Error(
					`extension ${id}: manifest has no contributes.push, cannot register a platform adapter`,
				);
			}
			assertPlatformAdapterDef(def);
			// 两份 settings 声明对不上就别加载了 —— 放过去的症状是「面板上填了保存不了」
			// 或者「有个必填项面板上根本没有」,两种都很难查到源头。
			// 连接一律是从候选里挑出来的(settings 由拓展交),所以按「挑出来的」对表。
			assertConfigFieldsMatchSchema(id, def.settingsSchema, view.settingsFields, {
				picked: true,
			});
			adapterRegistered = true;
			// 🔴 分发键由宿主填 —— 拓展自报的那份在这里被覆盖掉。
			// 🔴 这一版不对拓展开放的成员(ADR-0024 决策 11)带了也不认:契约的类型已经排除它们,但第三方 JS 不受
			// 类型约束,原样展开的话带了就是活的 —— 没开放的口子先被人用上,以后就改不动它的形状。
			// 按成员表取、方法 bind 回拓展交上来的那个实例:拓展拿 class 写适配器(方法在原型上)是最常见的写法,
			// 展开会把原型上的方法整个丢掉。
			const adapter = {
				...pickAdapterMembers(def, ["listAddressCandidates", "connectionAuth"]),
				adapterKey: id,
				settingsSchema: def.settingsSchema,
			} satisfies PlatformAdapter;
			// 能力结果里那一格时刻由拓展给:宿主不信自述,出门前先验再统一成 UTC(见 `normalizeCapabilities`)。
			// 取的是 bind 回拓展实例之后的那两个方法,覆盖时它们在返回值上。
			const offeredCapabilities = adapter.capabilities;
			const offeredProbeCapabilities = adapter.probeCapabilities;
			const checkedAdapter: PlatformAdapter = {
				...adapter,
				...(offeredCapabilities
					? {
							capabilities: (connection: Connection) =>
								normalizeCapabilities(connection, offeredCapabilities(connection)),
						}
					: {}),
				...(offeredProbeCapabilities
					? {
							probeCapabilities: async (connection: Connection) =>
								normalizeCapabilities(connection, await offeredProbeCapabilities(connection)),
						}
					: {}),
			};
			// 登记即 `start`。适配器只从上下文读自己的连接与入站,登记交回的把手只负责注销。
			const slot = adoptRegistration("adapter", () =>
				adapters.register(
					checkedAdapter,
					createPlatformAdapterContext({
						integration: integration.ctx,
						adapterKey: id,
						label: manifestName,
						settingsSchema: def.settingsSchema,
						connections: opts.connections,
						...(opts.connection ? { connection: opts.connection } : {}),
						inbound: opts.inbound,
						onConnectionsChanged: (fn) =>
							integration.track(opts.onConnectionsChanged(wrapHandler("onConnectionsChanged", fn))),
						problems: opts.problems,
						rejectedProblemLevel: "warn",
						onRejectedProblem: recordRejectedProblem,
					}),
				),
			);
			return {
				dispose: () => revokeRegistration(slot),
			} satisfies PlatformAdapterHandle;
		},
		registerSource(def) {
			if (integration.disposed) {
				integration.refuse("registerSource");
				throw new Error(`extension ${id} is already unloaded`);
			}
			const registerSource = opts.registerSource;
			if (!registerSource) {
				throw new Error(`extension ${id}: the host has no source registry wired in`);
			}
			// 一个拓展就是一个平台(决策 9);要两个平台的那天再加一格子键。
			if (sourceRegistered) throw new Error(`extension ${id} already registered a source`);
			assertSourceDef(def);
			sourceRegistered = true;
			// 外观取清单(按当前语言盖好),代码里不再交一份 —— 两份会打架。
			const source = createExtensionSource({
				id,
				manifest: localizeManifest(opts.manifest, opts.locales, opts.localeReader.current()),
				def,
				logger,
				images: opts.images ?? { read: async () => undefined },
				recordDiscrepancy: (discrepancy) =>
					recordDiscrepancy({
						...discrepancy,
						subscriptionIds: subscriptionIdsOf(discrepancy.externalId),
					}),
				fallbackCreatorName: (externalId) =>
					opts.fallbackCreatorName?.({ sourceKey: id, externalId }) ?? externalId,
			});
			// 登记即 `start`,是异步的:这里同步交回把手,登记在后台落定,装载器在 `activate` 之后等它。
			// 落定前拓展就调了把手 / 收摊了,由那一格记着,落定那一刻当场撤。
			const slot = adoptRegistration("source", () =>
				registerSource({
					sourceKey: id,
					source,
					integration: integration.ctx,
					logger,
					rejectedProblemLevel: "warn",
					onRejectedProblem: recordRejectedProblem,
					// 问题表的写者名:当前语言的清单名,与集成上下文是同一个函数(3b-51)。
					label: manifestName,
				}),
			);
			return {
				dispose() {
					revokeRegistration(slot);
				},
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
		// 集成上下文里那一份 —— 拓展的实现在 {@link readOwnSettings},经 `createIntegrationContext` 的 `settings` 选项
		// 交了进去:`activate(ctx).settings` 与推送源 `start(ctx).settings`(适配器上下文转发 `integration.settings`)
		// 是同一个实现,不会有第二份通用的。
		settings: integration.ctx.settings,
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
		if (catchThenableRejection(raw)) {
			// 🔴 是 thenable 就接住它后来的 reject(没人接的 rejection 会让进程退出),再按「要同步交回」拒收。
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
				markUnreadable(verdict);
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
		registrationsSettled: () => registrationsSettled(),
		async dispose() {
			if (integration.disposed) return;
			// 在跑的动作听 `integration.ctx.signal`(见 `linkToStop`):收摊钩子开始跑时它们已经叫停了。
			await integration.dispose();
			runningActions.clear();
			actionHandlers.clear();
			handedSchemas.clear();
			viewFn = undefined;
		},
	};
}
