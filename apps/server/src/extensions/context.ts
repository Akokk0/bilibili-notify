import {
	type Connection,
	type Disposable,
	EXTENSION_API_VERSION,
	isExtensionConnection,
	type Logger,
	type PlatformDescriptor,
	type ServiceContext,
} from "@bilibili-notify/internal";
import type { ZodType } from "zod";
import type { AdapterRegistry } from "../platforms/registry.js";
import type {
	InboundGroupMessage,
	InboundMeta,
	InboundPrivateMessage,
	InboundSinks,
	PlatformAdapter,
} from "../platforms/types.js";
import { type ExtensionFetchHandler, type ExtensionMounts, extensionMountPrefix } from "./mount.js";
import type { ExtensionUpgradeHandler, ExtensionUpgrades } from "./upgrade.js";

/**
 * 拓展交给面板的元信息 —— **就是 `PlatformDescriptor`,少掉 `connectors` 那一格**。
 *
 * 不是新概念:少那一格是因为「怎么连」在拓展这一支根本不存在(连接上没有 `connector`,
 * 见 ADR-0012 决策 27),而 `connectors` 的用处是「新建连接时默认选哪一档」。
 */
export type ExtensionDescriptor = Omit<PlatformDescriptor, "connectors">;

/**
 * 一个推送源 —— 决策 7 那三样已有名字的东西装在一起,**一次交齐**。
 *
 * 拆成三个口的话,一个拓展可以只注册一半,而「有行为、没有面板元信息」是个没人想处理的
 * 中间态。(config 的**字段表**是第四样,跟着表单那一片一起加。)
 */
export interface PushExtensionDef<TConfig> {
	/** 行为。⚠️ 它自报的 `platforms` **会被宿主覆盖**成这个拓展的 id。 */
	adapter: PlatformAdapter;
	/** 面板元信息。 */
	descriptor: ExtensionDescriptor;
	/** config 的校验。宿主拿它解连接,解不出的那条根本不交给拓展。 */
	configSchema: ZodType<TConfig>;
}

/** 一条属于这个拓展的连接 —— config 已经解成它自己的形状。 */
export interface ExtensionConnectionView<TConfig> {
	id: string;
	name: string;
	/**
	 * 主人有没有停用这条。
	 *
	 * **停用的也在名单里**:桥必须认得出一条已停用接入的 token,才能回 503(退避重连)
	 * 而不是 401(配置错了别重连)。只给启用的话,主人在面板上停用一下,插件那头看到的是
	 * 「token 不对」,而它其实好好的。
	 */
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
export interface ExtensionContext {
	/** 它自己的 id —— 同时是挂载点、装载目录与记账键那一段。 */
	readonly id: string;
	/** 宿主契约的主版本。拓展自己也可能要按它分叉。 */
	readonly hostApiVersion: number;
	/** 每一行都自动带上 `[ext:<id>]` —— 日志里认得出是谁写的。 */
	readonly logger: Logger;
	/** 可回收定时器。卸载时宿主统一清,拓展自己漏了也不会留下幽灵。 */
	setTimeout(fn: () => void, ms: number): Disposable;
	setInterval(fn: () => void, ms: number): Disposable;
	/**
	 * 申请一条 HTTP 总入口,回宿主分配的前缀(如 `/ext/bridge`)。
	 *
	 * **拓展不该知道自己挂在哪**(决策 12):handler 收到的路径已经剥掉前缀,要拼绝对
	 * 地址时才用这个返回值。一个拓展只有一条总入口,再申请一次会抛。
	 */
	mount(handler: ExtensionFetchHandler): string;
	/**
	 * 注册这个拓展的推送源 —— 一个拓展只有一个(决策 28),再注册一次会抛。
	 *
	 * **分发键由宿主按 id 填**,`adapter.platforms` 自报的那份会被覆盖:自报的话,一个
	 * 拓展可以声明 `"onebot"` 把内置那条连接的推送整个截走。归属是宿主的判断。
	 */
	registerPushSource<TConfig>(def: PushExtensionDef<TConfig>): PushSourceHandle<TConfig>;
	/**
	 * 把一条入站消息喂回核心 —— 归一化在拓展这一侧做完(决策 31)。
	 *
	 * 🔴 `meta.connectionId` **宿主校验归属**:不是自己的连接就丢掉并记一行。放过去的话,
	 * 甲拓展能冒充乙拓展的连接投消息,而主人身份比对走的正是 `平台 + 地址 + bot` 三坐标。
	 */
	readonly inbound: {
		private(msg: InboundPrivateMessage, meta: InboundMeta): void;
		group(msg: InboundGroupMessage, meta: InboundMeta): void;
	};
	/**
	 * 认领 `/ext/<id>` 底下的 WS upgrade。
	 *
	 * 交给它的是**原样的三样原料**(`req` / `socket` / `head`)加一段剥掉前缀的路径:
	 * 握手、鉴权、帧上限、心跳全归拓展 —— 那些是协议语义(决策 26)。宿主只回答
	 * 「这条 upgrade 归谁」。
	 */
	onUpgrade(handler: ExtensionUpgradeHandler): void;
	/**
	 * 交一份给面板看的数据(任意 JSON)。宿主在 `/api/ext/<id>/status` 下发 —— 走
	 * `/api/*` 才吃得到 dashboard 会话鉴权,而 `/ext/<id>/*` 是**刻意**在鉴权外的。
	 *
	 * 形状第一版不约束:面板那一页还没写,而抽象要两个例子。**现取**,不缓存。
	 */
	publishStatus(fn: () => unknown): void;
	/** 卸载时要跑的收摊钩子。后注册的先跑。 */
	onDispose(fn: () => void | Promise<void>): void;
}

/** 宿主这边握着的把手 —— 拓展拿不到它,所以拓展没法把自己从卸载里摘出去。 */
export interface ExtensionRuntime {
	readonly ctx: ExtensionContext;
	/** 拓展交上来的那份面板数据 —— 没交过就是 `undefined`。现取。 */
	status(): unknown;
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
	/** 入站的两路收口。 */
	inbound: InboundSinks;
	/** WS upgrade 的分发表。 */
	upgrades: ExtensionUpgrades;
	hostApiVersion?: number;
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
			pushSourceRegistered = true;
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
		},
	};
}
