import { pathToFileURL } from "node:url";
import type {
	Connection,
	Disposable,
	ExtensionManifest,
	ServiceContext,
} from "@bilibili-notify/internal";
import type { AdapterRegistry } from "../platforms/registry.js";
import type { InboundSinks } from "../platforms/types.js";
import { createExtensionContext, type ExtensionContext, type ExtensionRuntime } from "./context.js";
import {
	discoverExtensions,
	EXTENSION_ROOT_LABEL,
	type ExtensionRoot,
	type ExtensionRootKind,
	extensionEntryFileFor,
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
	/** 清单读得出来就带上 —— 面板要印名字,哪怕它没跑起来。 */
	manifest?: ExtensionManifest;
	/** 没跑起来时那句「为什么」。 */
	detail?: string;
}

export interface LoadedExtensions {
	list(): readonly ExtensionEntry[];
	/**
	 * 所有跑着的拓展声明成密钥的 config 键,合成一份 —— 备份脱敏拿它当依据。
	 *
	 * 合起来不按拓展分:脱敏是**按键名**深度遍历的,而不同拓展的 config 住在各自的连接
	 * 记录里,多抹一个别人的同名键没有代价(它本来也是密钥)。
	 */
	secretConfigCodes(): readonly string[];
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
 * 扫一遍装载目录,把该跑的跑起来。
 *
 * 顺序是刻意的:**先判断,再决定要不要 import**。清单存在的理由就在这儿 —— 没启用的、
 * 版本不合的、已经被记账停用的,都不该有一行代码跑起来(ADR-0012 决策 8)。
 */
export async function loadExtensions(opts: LoadExtensionsOptions): Promise<LoadedExtensions> {
	const { roots, ledgerRoot, host, mounts, isEnabled, maxFailures } = opts;
	const importModule = opts.importModule ?? realImport;
	const found = await discoverExtensions(roots, {
		// 悄悄盖掉正是「我明明改了怎么没生效」最难查的原因(决策 34)。
		onShadowed: ({ id, winner, shadowed }) =>
			host.logger.warn(
				`[ext] ${id} 有多份:用的是${EXTENSION_ROOT_LABEL[winner.kind]}那份(${winner.dir}),` +
					`盖住了${EXTENSION_ROOT_LABEL[shadowed.kind]}的(${shadowed.dir})`,
			),
	});
	const blocked = readLoadLedger(ledgerRoot).blocked;

	const entries: ExtensionEntry[] = [];
	const running: ExtensionRuntime[] = [];

	for (const dir of found) {
		if (dir.state === "unreadable") {
			entries.push({ id: dir.id, origin: dir.origin, state: "unreadable", detail: dir.detail });
			continue;
		}
		if (dir.state === "incompatible") {
			entries.push({
				id: dir.id,
				origin: dir.origin,
				state: "incompatible",
				manifest: dir.manifest,
				detail: `它要宿主契约 v${dir.requires},这一版是 v${dir.host}`,
			});
			continue;
		}

		const { id, manifest, origin } = dir;
		if (!isEnabled(id)) {
			entries.push({ id, origin, state: "disabled", manifest });
			continue;
		}
		if (blocked.includes(`${id}@${manifest.version}`)) {
			entries.push({
				id,
				origin,
				state: "blocked",
				manifest,
				detail: `连续加载失败 ${maxFailures} 次,已自动停用;换一版会重新试`,
			});
			continue;
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
		});
		try {
			// 入口是**宿主按根算出来的**(源码根 `src/index.ts`,其余 `index.mjs`),
			// 清单说了不算 —— 见 `extensionEntryFileFor`。
			const mod = (await importModule(pathToFileURL(dir.entry).href)) as Partial<ExtensionModule>;
			if (typeof mod.activate !== "function") {
				throw new Error(`${extensionEntryFileFor(origin)} 没有导出 activate()`);
			}
			await mod.activate(runtime.ctx);
			markLoadSucceeded({ root: ledgerRoot, id, version: manifest.version });
			running.push(runtime);
			entries.push({ id, origin, state: "running", manifest });
		} catch (err) {
			// 半个拓展不许留在那:`activate` 抛之前注册过的定时器 / 端点当场回收。
			// 留着的话面板写「没起来」而它的定时器还在跑 —— 那比要求重启难查得多。
			await runtime.dispose();
			runtime.ctx.logger.error(`加载失败:${(err as Error).message}`);
			entries.push({ id, origin, state: "failed", manifest, detail: (err as Error).message });
		}
	}

	return {
		list: () => entries,
		secretConfigCodes: () => [...new Set(running.flatMap((r) => r.secretConfigCodes()))],
		async dispose() {
			// 后起来的先收 —— 与单个拓展内部的收摊次序同一条道理。
			for (const runtime of [...running].reverse()) await runtime.dispose();
			running.length = 0;
		},
	};
}
