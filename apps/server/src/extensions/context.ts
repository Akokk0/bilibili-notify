import type {
	ExtensionBotView,
	ExtensionConnectionView,
	ExtensionContext,
	ExtensionPushView,
	ExtensionSettings,
	ExtensionView,
} from "@bilibili-notify/extension";
import {
	type Connection,
	type Disposable,
	EXTENSION_API_RANGE,
	type ExtensionManifest,
	type InboundMeta,
	type InboundSinks,
	isExtensionConnection,
	isSecretField,
	type Logger,
	manifestProvides,
	type PlatformAdapter,
	type ServiceContext,
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
} from "@bilibili-notify/extension";

/**
 * 跑一个动作的结果。失败分四种,各有各的说法 —— 并成一句「出错了」的话,面板只能对着黑盒猜:
 * 清单里没这个名字、声明了代码却没接、拓展自己抛了(带原话)、超时。
 */
export type ActionOutcome =
	| { ok: true }
	| { ok: false; reason: "undeclared" | "unhandled" | "timeout" }
	| { ok: false; reason: "failed"; message: string };

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
 * 收摊钩子(`ctx.onDispose`)一共最多等多久。收摊排在装载器那条队里:一个钩子挂住,之后的开关、
 * 装包、只重载全卡在它后面,关机也关不下去(ADR-0019 决策 45)。
 */
export const DISPOSE_TIMEOUT_MS = 30_000;

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
	/** 跑面板按下的那个动作(ADR-0019 决策 22)。 */
	runAction(name: string, opts?: { timeoutMs?: number }): Promise<ActionOutcome>;
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
	/** 它自己那份设置(`globals.extensions.<id>.settings`),**现读**、原样。 */
	settings: () => unknown;
	/** 订阅「globals 落盘了」—— 内容变没变由 ctx 自己判,再转给拓展。 */
	onSettingsChanged: (fn: () => void) => Disposable;
	/**
	 * 存着的设置变得过不了它交过的 zod 了(跑着时被旁路写坏,或之后才交的那份判坏了)—— 装载器
	 * 该来把它收掉。原因在 {@link ExtensionRuntime.settingsProblem}。不给就只是没人收。
	 */
	onSettingsInvalid?: () => void;
	/** 拓展喊「面板数据变了」(`ctx.statusChanged`)时转给宿主;不给就只是没人听。 */
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
	 * 清单声明过的动作名;清单里没有 `actions` 这一段(v1 一律没有)就是 `undefined`。
	 * 建成 Set 而不是拿清单那个普通对象查:名字是拓展与面板给的,`in` / 下标会顺着原型链把
	 * `constructor` / `toString` 判成声明了。
	 */
	const declaredActions: ReadonlySet<string> | undefined =
		opts.manifest.apiVersion === 2 && opts.manifest.actions
			? new Set(Object.keys(opts.manifest.actions))
			: undefined;
	/** 代码接了的动作。卸载时清空 —— 之后面板再按,就是「声明了却没接」。 */
	const actionHandlers = new Map<string, () => void | Promise<void>>();
	let listBots: (() => readonly ExtensionBotView[]) | undefined;
	let secretCodes: readonly string[] = [];

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
		const push = manifest.contributes.push as NonNullable<typeof manifest.contributes.push>;
		return { display: push.display, connectionFields: push.connection?.fields ?? [] };
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
			opts.onStatusChanged?.();
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
			fields: opts.manifest.apiVersion === 2 ? (opts.manifest.settings?.fields ?? []) : [],
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
			const handler = actionHandlers.get(name);
			if (!handler) return { ok: false, reason: "unhandled" };
			const timeoutMs = runOpts.timeoutMs ?? ACTION_TIMEOUT_MS;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<ActionOutcome>((resolve) => {
				timer = setTimeout(() => resolve({ ok: false, reason: "timeout" }), timeoutMs);
			});
			const run = (async (): Promise<ActionOutcome> => {
				try {
					await handler();
					return { ok: true };
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					logger.warn(`动作 ${name} 抛了:${message}`);
					return { ok: false, reason: "failed", message };
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
