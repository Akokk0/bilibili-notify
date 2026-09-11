import type {
	ExtensionBotView,
	ExtensionConfigField,
	ExtensionConnectionView,
	ExtensionContext,
	ExtensionDescriptor,
	ExtensionSettings,
} from "@bilibili-notify/extension";
import {
	type Connection,
	type Disposable,
	EXTENSION_API_VERSION,
	type InboundMeta,
	type InboundSinks,
	isExtensionConnection,
	type Logger,
	type PlatformAdapter,
	type ServiceContext,
} from "@bilibili-notify/internal";
import type { ZodType } from "zod";
import type { AdapterRegistry } from "../platforms/registry.js";
import { assertConfigFieldsMatchSchema } from "./config-fields.js";
import { type ExtensionMounts, extensionMountPrefix } from "./mount.js";
import type { ExtensionUpgrades } from "./upgrade.js";

/**
 * ⚠️ **交给拓展的那一面住 `@bilibili-notify/extension`**,不在这里 —— 拓展与宿主都要
 * 认得它,所以它得在一个双方都够得到的公共包里(见那个包的文件头)。这里只有**宿主这一侧**:
 * 谁来造 ctx、谁来收摊。
 */
export type {
	ExtensionConnectionView,
	ExtensionContext,
	ExtensionDescriptor,
	PushExtensionDef,
	PushSourceHandle,
} from "@bilibili-notify/extension";

/** 宿主这边握着的把手 —— 拓展拿不到它,所以拓展没法把自己从卸载里摘出去。 */
export interface ExtensionRuntime {
	readonly ctx: ExtensionContext;
	/** 拓展交上来的那份面板数据 —— 没交过就是 `undefined`。现取。 */
	status(): unknown;
	/**
	 * 它注册推送源时交的那份面板元信息(短名 / 标识色 / 目标形态…)。没注册过就是 `undefined`。
	 *
	 * 🔴 **收下就得能拿出来**:面板要靠它给拓展那一档一张脸。丢掉的话 web 只能自己手抄
	 * 一份短名与颜色,而手抄的副本迟早跟拓展报的漂开 —— 且那种漂移门禁一片绿。
	 */
	descriptor(): ExtensionDescriptor | undefined;
	/**
	 * 它注册推送源时交的字段表。没注册过就是 `undefined`。
	 *
	 * 🔴 交上来是为了**被画出来**(决策 33):推送目标页照它画「新建连接」的表单。此前它只
	 * 用来对表与找密钥键,面板从没拿到过 —— 于是拓展连接只能在拓展页建。
	 */
	configFields(): readonly ExtensionConfigField[] | undefined;
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
	/** 收回这个拓展注册过的一切。幂等。 */
	dispose(): Promise<void>;
}

export interface CreateExtensionContextOptions {
	id: string;
	/** 宿主的 ServiceContext —— 定时器与日志的真身。 */
	host: ServiceContext;
	mounts: ExtensionMounts;
	/** 出口的活注册表。拓展注册的推送源往这里进。 */
	adapters: AdapterRegistry;
	/** 全部连接,**现读**。属于谁由宿主筛。 */
	connections: () => readonly Connection[];
	/** 订阅「连接配置动过了」。⛔ 拿不到 bus —— 宿主替它订,只把结果转给它。 */
	onConnectionsChanged: (fn: () => void) => Disposable;
	/** 它自己那份设置(`globals.extensions.<id>.settings`),**现读**、原样。 */
	settings: () => unknown;
	/** 订阅「globals 落盘了」—— 内容变没变由 ctx 自己判,再转给拓展。 */
	onSettingsChanged: (fn: () => void) => Disposable;
	/** 入站的两路收口。 */
	inbound: InboundSinks;
	/** WS upgrade 的分发表。 */
	upgrades: ExtensionUpgrades;
	hostApiVersion?: number;
	/** 载荷版本号。测试里可以不给。 */
	hostVersion?: string;
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

	let statusOf: (() => unknown) | undefined;
	let pushSourceRegistered = false;
	let descriptor: ExtensionDescriptor | undefined;
	let configFields: readonly ExtensionConfigField[] | undefined;
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

	/** 这条连接是不是它自己的 —— 入站那道归属校验用。 */
	function owns(connectionId: string): boolean {
		return opts
			.connections()
			.some(
				(connection) => isExtensionConnection(connection, id) && connection.id === connectionId,
			);
	}

	/**
	 * 设置的解析结果按**原始值的身份**缓存:globals 每落一次盘就是一个新对象,同一个对象
	 * 再问一次不必再解一遍 —— 更要紧的是坏形状那一行**只记一次**,握手一次问一次不该刷屏。
	 */
	const settingsCache = new WeakMap<object, Map<ZodType, unknown>>();
	function readSettings<T>(schema: ZodType<T>): T | undefined {
		const raw = opts.settings();
		if (raw === undefined || raw === null) return undefined;
		const cacheable = typeof raw === "object";
		const bucket = cacheable ? settingsCache.get(raw as object) : undefined;
		if (bucket?.has(schema)) return bucket.get(schema) as T | undefined;
		const parsed = schema.safeParse(raw);
		if (!parsed.success) logger.warn(`设置的形状不对,按没有算:${parsed.error.message}`);
		const value = parsed.success ? parsed.data : undefined;
		if (cacheable) {
			const map = bucket ?? new Map<ZodType, unknown>();
			map.set(schema, value);
			settingsCache.set(raw as object, map);
		}
		return value;
	}

	/** 上一次看见的设置(序列化),用来判「这次 globals 落盘动的是不是我这一格」。 */
	let lastSettingsSeen = JSON.stringify(opts.settings() ?? null);

	function feed(route: "private" | "group", meta: InboundMeta, deliver: () => void): void {
		if (!owns(meta.connectionId)) {
			// 冒充别人的连接 —— 丢掉。主人身份比对走「平台 + 地址 + bot」三坐标,放过去
			// 就等于让一个拓展替别人说话。
			logger.warn(
				`丢掉一条${route === "private" ? "私聊" : "群"}消息:连接 ${meta.connectionId} 不是它的`,
			);
			return;
		}
		deliver();
	}

	const ctx: ExtensionContext = {
		id,
		hostApiVersion: opts.hostApiVersion ?? EXTENSION_API_VERSION,
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
			// 两份 config 声明对不上就别加载了 —— 放过去的症状是「面板上填了保存不了」
			// 或者「有个必填项面板上根本没有」,两种都很难查到源头。
			assertConfigFieldsMatchSchema(id, def.configSchema, def.configFields, {
				picked: def.listBots !== undefined,
			});
			pushSourceRegistered = true;
			descriptor = def.descriptor;
			configFields = def.configFields;
			listBots = def.listBots;
			secretCodes = def.configFields.filter((f) => "secret" in f && f.secret).map((f) => f.code);
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
				feed("private", meta, () => opts.inbound.onInboundPrivate?.(msg, meta)),
			group: (msg, meta) => feed("group", meta, () => opts.inbound.onInboundGroup?.(msg, meta)),
		},
		onUpgrade(handler) {
			if (disposed) {
				refuse("onUpgrade");
				return;
			}
			registered.add(opts.upgrades.register(id, handler));
		},
		publishStatus(fn) {
			if (disposed) {
				refuse("publishStatus");
				return;
			}
			statusOf = fn;
		},
		settings<T>(schema: ZodType<T>): ExtensionSettings<T> {
			return {
				get: () => readSettings(schema),
				onChange: (fn: () => void) => {
					if (disposed) return refuse("settings.onChange");
					return track(
						opts.onSettingsChanged(() => {
							const now = JSON.stringify(opts.settings() ?? null);
							if (now === lastSettingsSeen) return;
							lastSettingsSeen = now;
							fn();
						}),
					);
				},
			};
		},
		onDispose(fn) {
			if (disposed) {
				refuse("onDispose");
				return;
			}
			hooks.push(fn);
		},
	};

	return {
		ctx,
		status: () => statusOf?.(),
		descriptor: () => descriptor,
		configFields: () => configFields,
		bots: () => listBots?.(),
		secretConfigCodes: () => secretCodes,
		async dispose() {
			if (disposed) return;
			disposed = true;
			// 先跑拓展自己的收摊钩子(它可能要用还活着的定时器 / 端点收尾),再拆机件。
			// 后注册的先跑 —— 后建起来的东西通常依赖先建起来的。
			for (const fn of [...hooks].reverse()) {
				try {
					await fn();
				} catch (err) {
					// 一个钩子抛了不许打断其余的回收:收一半的拓展是最难查的那种。
					logger.error(`收摊钩子抛了:${(err as Error).message}`);
				}
			}
			hooks.length = 0;
			for (const entry of registered) {
				try {
					entry.dispose();
				} catch (err) {
					logger.error(`回收注册项时抛了:${(err as Error).message}`);
				}
			}
			registered.clear();
			statusOf = undefined;
			secretCodes = [];
		},
	};
}
