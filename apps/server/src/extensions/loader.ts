import { stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { ExtensionBotView, ExtensionConfigField } from "@bilibili-notify/extension";
import type {
	Connection,
	Disposable,
	ExtensionManifest,
	InboundSinks,
	ServiceContext,
} from "@bilibili-notify/internal";
import type { AdapterRegistry } from "../platforms/registry.js";
import {
	createExtensionContext,
	type ExtensionContext,
	type ExtensionDescriptor,
	type ExtensionRuntime,
} from "./context.js";
import { discoverExtensions, EXTENSION_ENTRY_FILE, type ExtensionDirRead } from "./discover.js";
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
	/** 它自己那个目录,绝对路径。 */
	dir: string;
	/** 那个目录是条软链时,它指到哪去 —— 开发版装进来的是仓里那份 `dist`。 */
	linkedTo?: string;
	/** 清单读得出来就带上 —— 面板要印名字,哪怕它没跑起来。 */
	manifest?: ExtensionManifest;
	/** 没跑起来时那句「为什么」。 */
	detail?: string;
}

export interface LoadedExtensions {
	list(): readonly ExtensionEntry[];
	/**
	 * 跑着的拓展各自声明成密钥的 config 键,**按 id 分格** —— 备份脱敏拿它当依据。
	 *
	 * 🔴 **分格,不合并**:合成一份全局键名集合的话,一个拓展把 `name` 声明成密钥,备份里
	 * 每一条连接与目标的 `name` 都会被抹平,而 `name` 是 `min(1)` —— 恢复时整份被拒。
	 *
	 * 🔴 **没跑起来的不在表里**,而「不在表里」在脱敏那边的意思是**整片当密钥**,不是
	 * 「什么都不抹」(见 `../backup/sanitize.ts` 的 `ExtensionSecretCodes`)。字段表是代码在
	 * `registerPushSource` 时交上来的、清单里没有,所以停用的拓展问不出来 —— 问不出来时
	 * 宁可多抹:从前那条路的症状是「拨掉一个拓展的开关,它连接里的密钥就原样进备份文件」。
	 */
	secretConfigCodes(): Readonly<Record<string, readonly string[]>>;
	/**
	 * 某个拓展交上来的面板数据(`ctx.publishStatus`)。**现取** —— 拓展给的是个函数,
	 * 每次问都重新算,面板看到的永远是此刻的真相而不是某次快照。
	 */
	status(id: string): unknown;
	/**
	 * 某个拓展注册推送源时交的那份面板元信息(`ExtensionDescriptor`)。没跑 / 没注册过就是
	 * `undefined`。**现取** —— 与 `status()` 同一条理由。
	 */
	descriptor(id: string): ExtensionDescriptor | undefined;
	/** 某个拓展注册推送源时交的字段表(决策 33)。没跑就是 `undefined`。 */
	configFields(id: string): readonly ExtensionConfigField[] | undefined;
	/** 某个拓展某条连接上能绑目标的 bot。没跑 / 它没给 `listBots` 就是 `undefined`。 */
	bots(id: string): readonly ExtensionBotView[] | undefined;
	/**
	 * 按**现在的开关**再对一遍:开了的装上,关了的收掉(决策 10 的「启用 / 停用热」)。
	 *
	 * 🔴 判据是**开关变了**,不是「现在跑没跑」。按后者写的话,一个加载失败的拓展会在
	 * 主人每存一次全局设置时重试一次,几下就把失败记账烧到自动停用 —— 而主人根本没碰它。
	 * 想重试就拨一下开关,那也正是人会做的动作。
	 *
	 * **不重扫盘**:装进来 / 卸掉了走 {@link LoadedExtensions.rescan}。扫盘 + 读清单挂在
	 * 「任何一次全局设置保存」上,是拿一条高频路径去办一件低频的事。
	 *
	 * 排队执行,不并发 —— 连拨两下开关得按顺序落地。自己吞异常,不会抛。
	 */
	sync(): Promise<void>;
	/**
	 * **再扫一遍装载目录**:新装进来的当场装上,卸掉的当场收摊 —— 装 / 卸都不用重启。
	 *
	 * 🔴 决策 10 否掉的只有「**换掉已加载的代码**」(ESM 模块缓存删不掉)。而一个新出现的
	 * id 从来没被 import 过,它第一次 import 与「拨开关第一次启用」是同一档事实,没有缓存
	 * 这回事 —— 曾经要重启,纯粹是因为开机扫一次就把名单定死了。
	 *
	 * 🔴 **已经收进名单的那些一律不碰**,哪怕目录里的代码变了:换代码是
	 * {@link LoadedExtensions.reload} 的活(开发版专用,每次漏一份模块)。这里顺手换掉的话,
	 * 生产会悄悄多出一条「换代码不重启」的路。清单坏了 / 版本不合的那些则每次重读 ——
	 * 它们一行代码都没跑过,主人把清单修好了就该装得上。
	 *
	 * 显式调用:装 / 卸是低频动作,而扫盘不该挂在高频路径上(同 `sync()` 那条理由)。
	 * 与 `sync()` / `reload()` 同一条队,自己吞异常,不会抛。
	 */
	rescan(): Promise<void>;
	/**
	 * **换掉代码再跑一遍** —— 收摊 → 换一个 URL 重新 `import` → 重新 `activate`。
	 *
	 * 🔴 **开发版专用**:ESM 的模块缓存删不掉,靠的是「URL 不一样就是一份新模块」
	 * (`?v=<mtime>`),于是**旧模块回收不掉** —— 每重载一次漏一份。开发时无所谓,
	 * 生产里长跑的进程不该这么用:那边换代码就是重启一次。
	 *
	 * ⚠️ **刻意不挂在开关上**:拨开关保持生产语义(复用模块缓存),不然开发版比生产宽容,
	 * 「拓展模块顶层存了状态」这种 bug 只会在真机上露面。
	 *
	 * 不记账:记账防的是开机反复炸,而这是主人手按的 —— 改一行崩一次,三次就被自动停用
	 * 的话开发循环当场卡死。装不起来 / 关着 / 没这个 id 都抛。
	 */
	reload(id: string): Promise<void>;
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
	/** 装载目录 —— **只有一个**(`<dataDir>/extensions/`,见 `discover.ts` 文件头)。 */
	root: string;
	host: ServiceContext;
	mounts: ExtensionMounts;
	/** 出口的活注册表。拓展注册的推送源往这里进。 */
	adapters: AdapterRegistry;
	/** 全部连接,现读。属于谁由 ctx 那一层筛。 */
	connections: () => readonly Connection[];
	/** 订阅「连接配置动过了」。 */
	onConnectionsChanged: (fn: () => void) => Disposable;
	/** 某个拓展自己那份设置(`globals.extensions.<id>.settings`),现读、原样。 */
	settings: (id: string) => unknown;
	/** 订阅「globals 落盘了」。内容变没变由 ctx 判。 */
	onSettingsChanged: (fn: () => void) => Disposable;
	/** 某个拓展喊了「面板数据变了」(`ctx.statusChanged`);宿主把它推到面板。 */
	onStatusChanged?: (id: string) => void;
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
 * 要 import 的那个 URL。
 *
 * 平时就是文件本身 —— **同一个 URL 拿到的是模块缓存里那份**,这正是「代码不热」的由来,
 * 也是生产的真实行为。`fresh` 时在后面挂一段 `?v=<mtime>`:URL 不同,Node 就当没见过它,
 * 于是真的重新读盘、重新跑顶层。mtime 读不到(理论上不会)就退回当前时刻,宁可多换一次。
 */
async function entryUrl(entry: string, fresh: boolean): Promise<string> {
	const href = pathToFileURL(entry).href;
	if (!fresh) return href;
	const version = await stat(entry).then(
		(s) => s.mtimeMs,
		() => Date.now(),
	);
	return `${href}?v=${version}`;
}

/**
 * 扫一遍装载目录,把该跑的跑起来,并把这批拓展的**装卸把手**交回去。
 *
 * 之后名单靠三个把手动:拨开关走 `sync()`,装 / 卸走 `rescan()`(再扫一遍盘),
 * 换代码走 `reload()`(开发版专用)。三件事分开,是因为它们的代价与语义都不一样。
 */
export async function loadExtensions(opts: LoadExtensionsOptions): Promise<LoadedExtensions> {
	const { root, host, mounts, isEnabled, maxFailures } = opts;
	// 记账落在**装载目录本身**(`<dataDir>/extensions/load-state.json`),绝不写进某个拓展
	// 自己的目录:「它连炸了几次」是这一台机器的状态,而那个目录随时会被换掉 —— 开发版
	// 装进来的那份还是仓库工作树的软链,往里写等于往 `git status` 里拉屎。
	const ledgerRoot = root;
	const importModule = opts.importModule ?? realImport;
	const found = await discoverExtensions(root);

	/** 面板那张表。按 id 排(`discoverExtensions` 已排好,重扫之后 `resort()` 再归位)。 */
	const entries = new Map<string, ExtensionEntry>();
	/** 眼下真跑着的。插入顺序 = 起来的顺序,收摊时倒着来。 */
	const runtimes = new Map<string, ExtensionRuntime>();
	/** 装得起来的那些(清单读得懂、版本合)—— 开关拨回来时不必重扫盘。 */
	const ready = new Map<string, Extract<ExtensionDirRead, { state: "ready" }>>();
	/** 上一次落实过的开关。热装卸只认**变化**,见 `sync()` 的注释。 */
	const applied = new Map<string, boolean>();

	async function start(
		dir: Extract<ExtensionDirRead, { state: "ready" }>,
		/** 主人手按的重载:换个 URL 拿新代码,并且**不走记账**(理由见 `reload`)。 */
		fresh = false,
	): Promise<void> {
		const { id, manifest } = dir;
		const at = {
			id,
			dir: dir.dir,
			...(dir.linkedTo === undefined ? {} : { linkedTo: dir.linkedTo }),
		};
		// 记账**现读**:热装卸期间失败也要算数,拿开机那一刻的快照会漏掉。
		if (!fresh && readLoadLedger(ledgerRoot).blocked.includes(`${id}@${manifest.version}`)) {
			entries.set(id, {
				...at,
				state: "blocked",
				manifest,
				detail: `连续加载失败 ${maxFailures} 次,已自动停用;换一版会重新试`,
			});
			return;
		}

		// **先记账再加载**:反过来的话,「一 import 就把进程带走」这种循环永远累加不到上限。
		if (!fresh) recordLoadAttempt({ root: ledgerRoot, id, version: manifest.version, maxFailures });

		const runtime = createExtensionContext({
			id,
			host,
			mounts,
			adapters: opts.adapters,
			connections: opts.connections,
			onConnectionsChanged: opts.onConnectionsChanged,
			settings: () => opts.settings(dir.id),
			onSettingsChanged: opts.onSettingsChanged,
			onStatusChanged: () => opts.onStatusChanged?.(dir.id),
			inbound: opts.inbound,
			upgrades: opts.upgrades,
			hostVersion: opts.hostVersion,
		});
		try {
			// 入口固定 `index.mjs`,**宿主自己判**、清单说了不算 —— 见 `EXTENSION_ENTRY_FILE`。
			// ⚠️ 第二次启用时这里拿到的是**模块缓存里那份**:ESM 换不掉已加载的代码
			// (决策 10),重新跑的只有 `activate`。所以拓展的模块顶层不许存状态。
			const mod = (await importModule(
				await entryUrl(dir.entry, fresh),
			)) as Partial<ExtensionModule>;
			if (typeof mod.activate !== "function") {
				throw new Error(`${EXTENSION_ENTRY_FILE} 没有导出 activate()`);
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
			dir: dir.dir,
			...(dir.linkedTo === undefined ? {} : { linkedTo: dir.linkedTo }),
			state: "disabled",
			manifest: dir.manifest,
		});
	}

	/**
	 * 把一条扫出来的记录收进名单 —— **开机与重扫走的是同一段**,两处分头写的话,新装进来
	 * 的拓展会与开机装上的差一点(记账、开关、面板那一行),而差别只在真机上露面。
	 *
	 * 顺序是刻意的:**先判断,再决定要不要 import**。清单存在的理由就在这儿 —— 没启用的、
	 * 版本不合的、已经被记账停用的,都不该有一行代码跑起来(ADR-0012 决策 8)。
	 */
	async function admit(dir: Exclude<ExtensionDirRead, { state: "absent" }>): Promise<void> {
		if (dir.state === "unreadable") {
			entries.set(dir.id, {
				id: dir.id,
				dir: dir.dir,
				state: "unreadable",
				detail: dir.detail,
			});
			return;
		}
		if (dir.state === "incompatible") {
			entries.set(dir.id, {
				id: dir.id,
				dir: dir.dir,
				state: "incompatible",
				manifest: dir.manifest,
				detail: `它要宿主契约 v${dir.requires},这一版是 v${dir.host}`,
			});
			return;
		}

		ready.set(dir.id, dir);
		const enabled = isEnabled(dir.id);
		applied.set(dir.id, enabled);
		if (enabled) await start(dir);
		else
			entries.set(dir.id, {
				id: dir.id,
				dir: dir.dir,
				...(dir.linkedTo === undefined ? {} : { linkedTo: dir.linkedTo }),
				state: "disabled",
				manifest: dir.manifest,
			});
	}

	/** 面板那张表按 id 排。**次序不该跟着「什么时候装的」走** —— 否则重启一次就换个样。 */
	function resort(): void {
		const sorted = [...entries].sort(([a], [b]) => a.localeCompare(b));
		entries.clear();
		for (const [id, entry] of sorted) entries.set(id, entry);
	}

	for (const dir of found) await admit(dir);

	let queue: Promise<void> = Promise.resolve();

	return {
		list: () => [...entries.values()],
		secretConfigCodes: () =>
			Object.fromEntries([...runtimes].map(([id, r]) => [id, r.secretConfigCodes()])),
		status: (id) => runtimes.get(id)?.status(),
		descriptor: (id) => runtimes.get(id)?.descriptor(),
		configFields: (id) => runtimes.get(id)?.configFields(),
		bots: (id) => runtimes.get(id)?.bots(),
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
		rescan() {
			// 与 sync() / reload() 同一条队:装完紧跟着拨开关时,后一次得看见前一次的结果。
			queue = queue.then(async () => {
				const now = await discoverExtensions(root);
				const onDisk = new Set(now.map((dir) => dir.id));

				// 先送走消失的。**三张表都要删干净** —— 在 `ready` 里留一格的话,下一次
				// `sync()` 会把一个已经不在盘上的拓展装回来(它的代码还在模块缓存里,真装得起来)。
				for (const id of [...entries.keys()]) {
					if (onDisk.has(id)) continue;
					const dir = ready.get(id);
					if (dir) await stop(dir);
					ready.delete(id);
					applied.delete(id);
					entries.delete(id);
				}

				for (const dir of now) {
					// 已经收进装载名单的一律不碰,哪怕目录里的代码换了 —— 那是 `reload()` 的活。
					// 清单坏了 / 版本不合的那些则重读一遍:它们一行代码都没跑过,主人把清单
					// 修好、或者换了个版本合的包,重扫就该认出来。
					if (ready.has(dir.id)) continue;
					await admit(dir);
				}
				resort();
			});
			return queue;
		},
		reload(id) {
			// 与 sync() 同一条队:连着按两下、或者边拨开关边重载,得按顺序落地。
			const run = queue.then(async () => {
				const dir = ready.get(id);
				if (!dir) throw new Error(`没有装着叫 ${id} 的拓展(或者它的清单就读不出来)`);
				if (!isEnabled(id)) throw new Error(`${id} 的开关关着 —— 先打开它,重载才有东西可换`);
				await stop(dir);
				await start(dir, true);
				// 收摊那一下把开关记成了「没应用」,补回来,免得下一次 sync() 又装一遍。
				applied.set(id, true);
			});
			// 🔴 **队尾接的是吞掉失败的那份**:直接把 `run` 留在队尾的话,一次拒绝会让
			// 之后**每一次 `sync()` 都被跳过**(rejected promise 的 `.then` 不跑回调)——
			// 症状是「重载报错之后开关再也拨不动」,而且没有任何人报错。调用方照样拿到拒绝。
			queue = run.catch(() => {});
			return run;
		},
		async dispose() {
			// 后起来的先收 —— 与单个拓展内部的收摊次序同一条道理。
			for (const runtime of [...runtimes.values()].reverse()) await runtime.dispose();
			runtimes.clear();
		},
	};
}
