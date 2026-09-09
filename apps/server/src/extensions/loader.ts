import { pathToFileURL } from "node:url";
import type {
	Connection,
	Disposable,
	ExtensionManifest,
	InboundSinks,
	ServiceContext,
} from "@bilibili-notify/internal";
import type { AdapterRegistry } from "../platforms/registry.js";
import { createExtensionContext, type ExtensionContext, type ExtensionRuntime } from "./context.js";
import {
	discoverExtensions,
	EXTENSION_ROOT_LABEL,
	type ExtensionDirRead,
	type ExtensionRoot,
	type ExtensionRootKind,
	extensionEntryFileFor,
	type ShadowedExtension,
} from "./discover.js";
import { markLoadSucceeded, readLoadLedger, recordLoadAttempt } from "./load-ledger.js";
import type { ExtensionMounts } from "./mount.js";
import type { ExtensionUpgrades } from "./upgrade.js";

/** 一个拓展现在处于什么状态 —— 拓展页那张列表印的就是它。 */
export type ExtensionRunState =
	/** 跑着。 */
	| "running"
	/** 主人把开关关了。**没启用的拓展一行代码都不会被 import。** */
	| "disabled"
	/** 连着加载失败,自动停用了(见 `load-ledger`)。 */
	| "blocked"
	/** 这一次加载炸了。 */
	| "failed"
	/** 清单读不了 / 与目录对不上 / 缺入口。 */
	| "unreadable"
	/** 给别的宿主契约版本写的。 */
	| "incompatible";

export interface ExtensionEntry {
	id: string;
	state: ExtensionRunState;
	/** 从哪个根扫出来的 —— 有好几个根之后,「跑的到底是哪一份」得说得出来。 */
	origin: ExtensionRootKind;
	/** 它自己那个目录,绝对路径。根名字只说得出「哪一类」,同名两份要靠全路径分。 */
	dir: string;
	/** 清单读得出来就带上 —— 面板要印名字,哪怕它没跑起来。 */
	manifest?: ExtensionManifest;
	/** 没跑起来时那句「为什么」。 */
	detail?: string;
}

export interface LoadedExtensions {
	list(): readonly ExtensionEntry[];
	/**
	 * 这次开机扫出来的「同一个 id 有两份」。
	 *
	 * 🔴 开机那句 warn 只在日志里闪一次,而**主人是在面板上找答案的** —— 「我明明改了怎么
	 * 没生效」正是这一格要回答的问题,所以它得一直摆着。
	 */
	shadowed(): readonly ShadowedExtension[];
	/**
	 * 所有跑着的拓展声明成密钥的 config 键,合成一份 —— 备份脱敏拿它当依据。
	 *
	 * 合起来不按拓展分:脱敏是**按键名**深度遍历的,而不同拓展的 config 住在各自的连接
	 * 记录里,多抹一个别人的同名键没有代价(它本来也是密钥)。
	 */
	secretConfigCodes(): readonly string[];
	/**
	 * 某个拓展交上来的面板数据(`ctx.publishStatus`)。**现取** —— 拓展给的是个函数,
	 * 每次问都重新算,面板看到的永远是此刻的真相而不是某次快照。
	 */
	status(id: string): unknown;
	/**
	 * 按**现在的开关**再对一遍:开了的装上,关了的收掉(决策 10 的「启用 / 停用热」)。
	 *
	 * 🔴 判据是**开关变了**,不是「现在跑没跑」。按后者写的话,一个加载失败的拓展会在
	 * 主人每存一次全局设置时重试一次,几下就把失败记账烧到自动停用 —— 而主人根本没碰它。
	 * 想重试就拨一下开关,那也正是人会做的动作。
	 *
	 * **不重扫盘**:新装进来的拓展要等下次开机。热的只有开关这一件事,而扫盘 + 读清单
	 * 挂在「任何一次全局设置保存」上,是拿一条高频路径去办一件低频的事。
	 *
	 * 排队执行,不并发 —— 连拨两下开关得按顺序落地。自己吞异常,不会抛。
	 */
	sync(): Promise<void>;
	/** 收回所有跑着的拓展。宿主关机时调。 */
	dispose(): Promise<void>;
}

/** 拓展的 `index.mjs` 要导出的东西 —— 第一版只有这一个。 */
export interface ExtensionModule {
	activate(ctx: ExtensionContext): void | Promise<void>;
}

/**
 * 连着加载失败几次就自动停用。
 *
 * 3 与自主升级那边的开机自愈同一个量级:够吃掉一两次偶发(装到一半断电、依赖的目录
 * 还没建好),又不至于让一个真炸的拓展反复把开机拖慢。
 */
export const EXTENSION_MAX_LOAD_FAILURES = 3;

export interface LoadExtensionsOptions {
	/** 要扫的几个根,**已按优先级排好**(高的在前)。见 `extensionRootsFor`。 */
	roots: readonly ExtensionRoot[];
	/**
	 * 失败记账写在哪 —— 固定 `<dataDir>/extensions/`,**不跟着拓展自己那个根走**。
	 *
	 * 另外两个根都写不得:载荷根跟着升级整个换掉(记的账下一版就没了),源码根是仓库
	 * 工作树(记账文件会冒到 `git status` 里)。而记账本来就是**这一台机器**的状态。
	 */
	ledgerRoot: string;
	host: ServiceContext;
	mounts: ExtensionMounts;
	/** 出口的活注册表。拓展注册的推送源往这里进。 */
	adapters: AdapterRegistry;
	/** 全部连接,现读。属于谁由 ctx 那一层筛。 */
	connections: () => readonly Connection[];
	/** 订阅「连接配置动过了」。 */
	onConnectionsChanged: (fn: () => void) => Disposable;
	/** 入站的两路收口。 */
	inbound: InboundSinks;
	/** WS upgrade 的分发表。 */
	upgrades: ExtensionUpgrades;
	isEnabled(id: string): boolean;
	/** 载荷版本号,原样交给每个拓展的 ctx。 */
	hostVersion?: string;
	/** 连着失败多少次就自动停用。 */
	maxFailures: number;
	/**
	 * 换掉 `import()` 那一步 —— **只给测试用**。
	 *
	 * 生产永远走真的动态 import:ESM 模块在同一个进程里换不掉(决策 10 认下的代价),
	 * 而那正是「升级要重启」的原因,不该被一层间接掩盖掉。
	 */
	importModule?: (specifier: string) => Promise<unknown>;
}

function realImport(specifier: string): Promise<unknown> {
	return import(specifier);
}

/**
 * 扫一遍装载目录,把该跑的跑起来,并把这批拓展的**装卸把手**交回去。
 *
 * 开机扫这一次就够了:之后主人拨开关走 `sync()`,拿的是这次扫出来的那份名单
 * (决策 10 只把**开关**做成热的,新装进来的拓展仍要等下次开机)。
 */
export async function loadExtensions(opts: LoadExtensionsOptions): Promise<LoadedExtensions> {
	const { roots, ledgerRoot, host, mounts, isEnabled, maxFailures } = opts;
	const importModule = opts.importModule ?? realImport;
	/** 被盖住的那些 —— 面板要一直摆着,不能只在开机日志里闪一次。 */
	const shadows: ShadowedExtension[] = [];
	const found = await discoverExtensions(roots, {
		// 悄悄盖掉正是「我明明改了怎么没生效」最难查的原因(决策 34)。
		onShadowed: (shadow) => {
			const { id, winner, shadowed } = shadow;
			shadows.push(shadow);
			host.logger.warn(
				`[ext] ${id} 有多份:用的是${EXTENSION_ROOT_LABEL[winner.kind]}那份(${winner.dir}),` +
					`盖住了${EXTENSION_ROOT_LABEL[shadowed.kind]}的(${shadowed.dir})`,
			);
		},
	});

	/** 面板那张表。按发现顺序(已按 id 排好)插入,后面只改不重排。 */
	const entries = new Map<string, ExtensionEntry>();
	/** 眼下真跑着的。插入顺序 = 起来的顺序,收摊时倒着来。 */
	const runtimes = new Map<string, ExtensionRuntime>();
	/** 装得起来的那些(清单读得懂、版本合)—— 开关拨回来时不必重扫盘。 */
	const ready = new Map<string, Extract<ExtensionDirRead, { state: "ready" }>>();
	/** 上一次落实过的开关。热装卸只认**变化**,见 `sync()` 的注释。 */
	const applied = new Map<string, boolean>();

	async function start(dir: Extract<ExtensionDirRead, { state: "ready" }>): Promise<void> {
		const { id, manifest, origin } = dir;
		const at = { id, origin, dir: dir.dir };
		// 记账**现读**:热装卸期间失败也要算数,拿开机那一刻的快照会漏掉。
		if (readLoadLedger(ledgerRoot).blocked.includes(`${id}@${manifest.version}`)) {
			entries.set(id, {
				...at,
				state: "blocked",
				manifest,
				detail: `连续加载失败 ${maxFailures} 次,已自动停用;换一版会重新试`,
			});
			return;
		}

		// **先记账再加载**:反过来的话,「一 import 就把进程带走」这种循环永远累加不到上限。
		recordLoadAttempt({ root: ledgerRoot, id, version: manifest.version, maxFailures });

		const runtime = createExtensionContext({
			id,
			host,
			mounts,
			adapters: opts.adapters,
			connections: opts.connections,
			onConnectionsChanged: opts.onConnectionsChanged,
			inbound: opts.inbound,
			upgrades: opts.upgrades,
			hostVersion: opts.hostVersion,
		});
		try {
			// 入口是**宿主按根算出来的**(源码根 `src/index.ts`,其余 `index.mjs`),
			// 清单说了不算 —— 见 `extensionEntryFileFor`。
			// ⚠️ 第二次启用时这里拿到的是**模块缓存里那份**:ESM 换不掉已加载的代码
			// (决策 10),重新跑的只有 `activate`。所以拓展的模块顶层不许存状态。
			const mod = (await importModule(pathToFileURL(dir.entry).href)) as Partial<ExtensionModule>;
			if (typeof mod.activate !== "function") {
				throw new Error(`${extensionEntryFileFor(origin)} 没有导出 activate()`);
			}
			await mod.activate(runtime.ctx);
			markLoadSucceeded({ root: ledgerRoot, id, version: manifest.version });
			runtimes.set(id, runtime);
			entries.set(id, { ...at, state: "running", manifest });
		} catch (err) {
			// 半个拓展不许留在那:`activate` 抛之前注册过的定时器 / 端点当场回收。
			// 留着的话面板写「没起来」而它的定时器还在跑 —— 那比要求重启难查得多。
			await runtime.dispose();
			runtime.ctx.logger.error(`加载失败:${(err as Error).message}`);
			entries.set(id, { ...at, state: "failed", manifest, detail: (err as Error).message });
		}
	}

	async function stop(dir: Extract<ExtensionDirRead, { state: "ready" }>): Promise<void> {
		const runtime = runtimes.get(dir.id);
		runtimes.delete(dir.id);
		// 收摊自己吞异常,拆到一半也会把剩下的拆完。
		await runtime?.dispose();
		entries.set(dir.id, {
			id: dir.id,
			origin: dir.origin,
			dir: dir.dir,
			state: "disabled",
			manifest: dir.manifest,
		});
	}

	// 顺序是刻意的:**先判断,再决定要不要 import**。清单存在的理由就在这儿 —— 没启用的、
	// 版本不合的、已经被记账停用的,都不该有一行代码跑起来(ADR-0012 决策 8)。
	for (const dir of found) {
		if (dir.state === "unreadable") {
			entries.set(dir.id, {
				id: dir.id,
				origin: dir.origin,
				dir: dir.dir,
				state: "unreadable",
				detail: dir.detail,
			});
			continue;
		}
		if (dir.state === "incompatible") {
			entries.set(dir.id, {
				id: dir.id,
				origin: dir.origin,
				dir: dir.dir,
				state: "incompatible",
				manifest: dir.manifest,
				detail: `它要宿主契约 v${dir.requires},这一版是 v${dir.host}`,
			});
			continue;
		}

		ready.set(dir.id, dir);
		const enabled = isEnabled(dir.id);
		applied.set(dir.id, enabled);
		if (enabled) await start(dir);
		else
			entries.set(dir.id, {
				id: dir.id,
				origin: dir.origin,
				dir: dir.dir,
				state: "disabled",
				manifest: dir.manifest,
			});
	}

	let queue: Promise<void> = Promise.resolve();

	return {
		list: () => [...entries.values()],
		shadowed: () => shadows,
		secretConfigCodes: () => [
			...new Set([...runtimes.values()].flatMap((r) => r.secretConfigCodes())),
		],
		status: (id) => runtimes.get(id)?.status(),
		sync() {
			// 串起来跑:连拨两下开关时,后一次要看见前一次的结果。
			queue = queue.then(async () => {
				for (const [id, dir] of ready) {
					const wanted = isEnabled(id);
					if (wanted === applied.get(id)) continue;
					applied.set(id, wanted);
					if (wanted) await start(dir);
					else await stop(dir);
				}
			});
			return queue;
		},
		async dispose() {
			// 后起来的先收 —— 与单个拓展内部的收摊次序同一条道理。
			for (const runtime of [...runtimes.values()].reverse()) await runtime.dispose();
			runtimes.clear();
		},
	};
}
