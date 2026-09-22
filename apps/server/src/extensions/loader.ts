import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionBotView } from "@bilibili-notify/extension";
import {
	type Connection,
	type Disposable,
	type ExtensionIdentity,
	type ExtensionManifest,
	type ExtensionRunState,
	type InboundSinks,
	manifestSecretKeys,
	type ServiceContext,
} from "@bilibili-notify/internal";
import type { AdapterRegistry } from "../platforms/registry.js";
import {
	type ActionOutcome,
	createExtensionContext,
	type ExtensionContext,
	type ExtensionPushView,
	type ExtensionRuntime,
} from "./context.js";
import {
	apiVersionMismatch,
	discoverExtensions,
	EXTENSION_ENTRY_FILE,
	type ExtensionDirRead,
	readExtensionDir,
} from "./discover.js";
import { markLoadSucceeded, readLoadLedger, recordLoadAttempt } from "./load-ledger.js";
import type { ExtensionMounts } from "./mount.js";
import type { ExtensionUpgrades } from "./upgrade.js";

/** 一个拓展现在处于什么状态 —— 拓展页那张列表印的就是它。 */
/** 六档状态的定义住 `@bilibili-notify/internal`(面板契约也从那儿转出,只写一份)。 */
export type { ExtensionRunState };

export interface ExtensionEntry {
	id: string;
	state: ExtensionRunState;
	/** 它自己那个目录,绝对路径。 */
	dir: string;
	/** 那个目录是条软链时,它指到哪去 —— 开发版装进来的是仓里那份 `dist`。 */
	linkedTo?: string;
	/** 清单读得出来就带上 —— 面板要印名字,哪怕它没跑起来。 */
	manifest?: ExtensionManifest;
	/**
	 * 版本不合的那些只有**身份那几格**(那一档的格式可能根本不认识)—— 面板照样印得出
	 * 它是谁、哪一版。与 `manifest` 不会同时有。
	 */
	identity?: ExtensionIdentity;
	/** 没跑起来时那句「为什么」。 */
	detail?: string;
	/**
	 * 盘上有一份这个进程**干净地换不上**的代码(ADR-0012 决策 47)—— 版本号取盘上那份的清单。
	 * 跑着的照跑旧的(`state: "running"`);没跑的不跑(`state: "staged"`)。两种都等主人选
	 * 重启 BN 或 {@link LoadedExtensions.swap}。
	 */
	staged?: { version: string };
}

/**
 * 这一行**是谁** —— 名字、版本、图标。清单读得懂的取清单,版本不合的取身份那几格。
 *
 * 🔴 要「它是谁」一律走这里,别直接读 `entry.manifest`:版本不合的那些没有 `manifest`,
 * 读漏了的症状是「装着的版本」静默变成 `undefined`(市场的来源比对、面板的版本号都靠它)。
 */
export function entryIdentity(entry: ExtensionEntry): ExtensionIdentity | undefined {
	return entry.manifest ?? entry.identity;
}

export interface LoadedExtensions {
	list(): readonly ExtensionEntry[];
	/**
	 * 各拓展声明成密钥的键,**按 id 分格** —— 备份脱敏拿它当依据。
	 *
	 * 🔴 **分格,不合并**:合成一份全局键名集合的话,一个拓展把 `name` 声明成密钥,备份里
	 * 每一条连接与目标的 `name` 都会被抹平,而 `name` 是 `min(1)` —— 恢复时整份被拒。
	 *
	 * v2 照**清单**读(ADR-0019 决策 17),跑没跑都在表里。v1 的声明是代码在
	 * `registerPushSource` 时交的,**没跑起来的 v1 不在表里** —— 「不在表里」在脱敏那边的意思
	 * 是**整片当密钥**,不是「什么都不抹」(见 `../backup/sanitize.ts` 的 `ExtensionSecretCodes`)。
	 * 问不出来时宁可多抹:从前那条路的症状是「拨掉一个拓展的开关,它连接里的密钥就原样进
	 * 备份文件」。
	 */
	secretConfigCodes(): Readonly<Record<string, readonly string[]>>;
	/**
	 * 某个拓展交上来的面板数据(`ctx.publishStatus`)。**现取** —— 拓展给的是个函数,
	 * 每次问都重新算,面板看到的永远是此刻的真相而不是某次快照。
	 */
	status(id: string): unknown;
	/**
	 * 某个拓展推送源那一口给面板的东西:外观(短名 / 标识色)+ 连接配置项(决策 33)。
	 * 没跑 / 没注册过推送源就是 `undefined`。**现取** —— 与 `status()` 同一条理由。
	 */
	pushSource(id: string): ExtensionPushView | undefined;
	/** 某个拓展某条连接上能绑目标的 bot。没跑 / 它没给 `listBots` 就是 `undefined`。 */
	bots(id: string): readonly ExtensionBotView[] | undefined;
	/** 跑某个拓展的一个动作(ADR-0019 决策 22)。拓展没在跑就是 `undefined`。 */
	runAction(id: string, name: string): Promise<ActionOutcome | undefined>;
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
	 * 🔴 已经在名单里的**也重读**(ADR-0012 决策 47):清单与入口指纹都现读,盘上没换过的
	 * 不碰。换过了的 —— 代码没跑的换成新记录再收一遍(还没有代码,谈不上换代码);**跑着的
	 * 不偷偷换**,标上 `staged` 照跑旧的,换不换由主人选。「新出现的 id 从来没被 import 过」
	 * 只在进程里第一次见到它时成立:删了再装的,由 `start()` 按指纹判。
	 *
	 * 显式调用:装 / 卸是低频动作,而扫盘不该挂在高频路径上(同 `sync()` 那条理由)。
	 * 与 `sync()` / `reload()` / `swap()` 同一条队,自己吞异常,不会抛。
	 */
	rescan(): Promise<void>;
	/**
	 * **只重载这个拓展**(生产那颗按钮,ADR-0012 决策 47):现读盘上那份 → 收摊 → 换一个按
	 * 指纹定的 URL 重新 `import` → 重新 `activate`。
	 *
	 * 🔴 **只在它标着 `staged` 时给按**,否则抛:ESM 的模块缓存删不掉,每换一份新代码就漏
	 * 一份旧模块 —— 漏可以,但不该在没有新代码的时候白漏。不记账(理由同 `reload`)。
	 */
	swap(id: string): Promise<void>;
	/**
	 * 盘上这一份代码,这个进程**干净地跑得上吗**(决策 47)—— 跑不上就是 `true`。
	 *
	 * 跑着的看那一行有没有标 `staged`;没跑的(关着、加载失败)按指纹判:这个 id 跑过别的代码、
	 * 没见过盘上这一份,那拨开开关也只会停在「新版等着换上」。装完那句话靠它**当场**说出来,
	 * 不然关着装进去的那份,主人要等拨开开关才撞见「换不上」。
	 *
	 * 🔴 **不往那一行上挂 `staged`**:关着的那一行带上它,面板就会给「只重载」,而 `swap()`
	 * 会把一个关着的拓展跑起来。
	 */
	codeStuck(id: string): Promise<boolean>;
	/**
	 * **开发版的「重载」**:与 {@link LoadedExtensions.swap} 同一段,只是不要求 `staged`
	 * —— 改一行就按一下。代码没变的话 URL 也不变(按指纹定),不白漏。
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
	/** 按 id 取一条(入站热路径用),见 `ExtensionContextOptions.connection`。 */
	connection?: (connectionId: string) => Connection | undefined;
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
 * 入口文件内容的指纹 —— 装载器按它认「这是哪一份代码」(ADR-0012 决策 47)。
 *
 * 不按 id、不按路径:ESM 的模块缓存按 URL 认,同一个路径删了再装、覆盖、换成软链,拿到的
 * 都是第一次那份。读不出来(理论上不会 —— 扫盘时刚见过它)就是 `undefined`,照常 import,
 * 让它自己报出真正的错。
 */
async function fingerprintOf(entry: string): Promise<string | undefined> {
	try {
		return createHash("sha256")
			.update(await readFile(entry))
			.digest("hex");
	} catch {
		return undefined;
	}
}

/** 一条记录的样子(入口指纹 + 清单)—— 重扫拿它判「盘上换过没有」。 */
function recordOf(print: string | undefined, manifest: ExtensionManifest): string {
	return `${print}\n${JSON.stringify(manifest)}`;
}

async function recordPrint(dir: Extract<ExtensionDirRead, { state: "ready" }>): Promise<string> {
	return recordOf(await fingerprintOf(dir.entry), dir.manifest);
}

/**
 * 面板那一行里「它是谁、在盘上哪儿」那几格 —— 跑着的、停用的、刚收摊的,都得原样带上。
 *
 * `linkedTo` 只有**它真是条软链**时才有这一格:开发版由 devtools 链进来的那份指着仓库
 * 工作树,而「跑的到底是哪一份」只有它答得了。
 */
function entryBase(
	dir: Extract<ExtensionDirRead, { state: "ready" }>,
): Pick<ExtensionEntry, "id" | "dir" | "linkedTo"> {
	return {
		id: dir.id,
		dir: dir.dir,
		...(dir.linkedTo === undefined ? {} : { linkedTo: dir.linkedTo }),
	};
}

/** 同一行,去掉「等着换上」那一格。 */
function withoutStaged({ staged: _staged, ...entry }: ExtensionEntry): ExtensionEntry {
	return entry;
}

/** 「装得起来,只是主人把开关关了」那一行 —— 开机、收摊、重扫三处是同一格。 */
function disabledEntry(dir: Extract<ExtensionDirRead, { state: "ready" }>): ExtensionEntry {
	return { ...entryBase(dir), state: "disabled", manifest: dir.manifest };
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
	/** 名单里每条记录读盘时的样子,见 {@link recordPrint}。 */
	const listed = new Map<string, string>();
	/**
	 * 这个进程里每个 id **import 过的每一份代码**:入口指纹 → 那一份用的 URL(决策 47)。
	 *
	 * 🔴 **只增不减**,卸掉、重扫都不删:模块缓存本身删不掉,这里忘了它,下一次就会拿同一个
	 * URL 去要一份新代码,而 Node 交回来的是旧的 —— 配上现读的新清单,就是 devtools 装桥时
	 * 炸的那一下。
	 */
	const imported = new Map<string, Map<string, string>>();
	/**
	 * **跑着的那一份**的记录(入口指纹 + 清单,见 {@link recordOf})—— 与 `listed` 分开记:
	 * `listed` / `ready` 永远跟着**盘上**走(下一次起它用的就是那份),这一格只管「跑着的是哪份」,
	 * 重扫拿盘上那份与它比,不同就标「等着换上」。
	 *
	 * 🔴 合成一格的话,跑着的标上 `staged` 之后名单里还是旧清单 —— 拨一下开关就拿盘上的代码配旧
	 * 清单起,正是决策 47 要防的那一下。
	 */
	const runningRecord = new Map<string, string>();

	/**
	 * 这一份代码该拿哪个 URL import。
	 *
	 * - 这个进程见过**这一份** → 当时那个 URL(模块缓存里那份就是它,不漏)。
	 * - 这个 id 从没 import 过 → 文件本身。生产绝大多数时候走这条。
	 * - 见过**别的**、没见过这一份 → 只有 `fresh`(主人按了重载)才换一个按指纹定的 URL,
	 *   代价是旧模块留在内存里;否则 `undefined` = 这个进程干净地换不上。
	 */
	function urlFor(
		id: string,
		entry: string,
		print: string | undefined,
		fresh: boolean,
	): string | undefined {
		const href = pathToFileURL(entry).href;
		const seen = imported.get(id);
		const known = print === undefined ? undefined : seen?.get(print);
		if (known !== undefined) return known;
		if (seen === undefined || seen.size === 0) return href;
		return fresh ? `${href}?v=${(print ?? String(Date.now())).slice(0, 16)}` : undefined;
	}

	async function start(
		dir: Extract<ExtensionDirRead, { state: "ready" }>,
		/** 主人手按的重载:换得上新代码,并且**不走记账**(理由见 `reload`)。 */
		fresh = false,
	): Promise<void> {
		const { id, manifest } = dir;
		const at = entryBase(dir);
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

		const print = await fingerprintOf(dir.entry);
		const url = urlFor(id, dir.entry, print, fresh);
		if (url === undefined) {
			// 一行代码都不跑、也不记账:这不是它的错,是这个进程换不上。
			entries.set(id, { ...at, state: "staged", manifest, staged: { version: manifest.version } });
			host.logger.warn(
				`[ext] ${id} v${manifest.version} 换不上:这个进程跑过它的另一份代码 —— 重启 BN,或在它的详情页里只重载它`,
			);
			return;
		}
		if (print !== undefined) {
			const seen = imported.get(id) ?? new Map<string, string>();
			seen.set(print, url);
			imported.set(id, seen);
		}

		// **先记账再加载**:反过来的话,「一 import 就把进程带走」这种循环永远累加不到上限。
		if (!fresh) recordLoadAttempt({ root: ledgerRoot, id, version: manifest.version, maxFailures });

		const runtime = createExtensionContext({
			id,
			manifest,
			host,
			mounts,
			adapters: opts.adapters,
			connections: opts.connections,
			connection: opts.connection,
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
			const mod = (await importModule(url)) as Partial<ExtensionModule>;
			if (typeof mod.activate !== "function") {
				throw new Error(`${EXTENSION_ENTRY_FILE} 没有导出 activate()`);
			}
			await mod.activate(runtime.ctx);
			markLoadSucceeded({ root: ledgerRoot, id, version: manifest.version });
			runtimes.set(id, runtime);
			runningRecord.set(id, recordOf(print, manifest));
			entries.set(id, { ...at, state: "running", manifest });
			// 带上代码指纹:「现在跑的是哪一份」一眼对得上盘上那份;软链那份把落点也印出来 ——
			// 开发版跑的其实是仓里的工作树,「我改的那个到底跑没跑」不必再查一遍。
			host.logger.info(
				`[ext] ${id} v${manifest.version} ${fresh ? "已重载" : "已加载"}(代码 ${print?.slice(0, 8) ?? "?"})${dir.linkedTo ? `(→ ${dir.linkedTo})` : ""}`,
			);
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
		runningRecord.delete(dir.id);
		// 收摊自己吞异常,拆到一半也会把剩下的拆完。
		await runtime?.dispose();
		if (runtime) host.logger.info(`[ext] ${dir.id} 已停下`);
		entries.set(dir.id, disabledEntry(dir));
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
				identity: dir.identity,
				detail: apiVersionMismatch(dir.requires, dir.range),
			});
			return;
		}

		ready.set(dir.id, dir);
		listed.set(dir.id, await recordPrint(dir));
		const enabled = isEnabled(dir.id);
		applied.set(dir.id, enabled);
		if (enabled) await start(dir);
		else entries.set(dir.id, disabledEntry(dir));
	}

	/**
	 * 已经在名单里的那条,盘上换过没有(决策 47)。
	 *
	 * 没换过不碰 —— 加载失败的那个也不借重扫重试(开关不动就不重试,见 `sync()`)。换过了:
	 * **跑着的不偷偷换**,照跑旧的、标上 `staged`;没跑的换成新记录再收一遍,换不换得上由
	 * `start()` 按指纹判。
	 */
	async function revisit(dir: Exclude<ExtensionDirRead, { state: "absent" }>): Promise<void> {
		const { id } = dir;
		const print = dir.state === "ready" ? await recordPrint(dir) : undefined;
		const entry = entries.get(id);
		if (runtimes.has(id)) {
			if (!entry) return;
			// 下一次起它(拨开关、只重载)用盘上这份,不是跑着那份的旧记录。
			if (dir.state === "ready" && print !== undefined) {
				ready.set(id, dir);
				listed.set(id, print);
			}
			// 盘上又换回了跑着的那一份,或者盘上那份读不出来(没有新版可换):那句「等着换上」撤掉。
			const next =
				dir.state === "ready" && print !== runningRecord.get(id)
					? { ...entry, staged: { version: dir.manifest.version } }
					: withoutStaged(entry);
			// 每次重扫都会走到这儿(装别的拓展也扫):只在头一回标上 / 换了一版时记。
			if (next.staged && next.staged.version !== entry.staged?.version) {
				host.logger.info(
					`[ext] ${id} 盘上换成了 v${next.staged.version},跑的还是 v${entryIdentity(entry)?.version ?? "?"} —— 等着换上(重启 BN 或只重载它)`,
				);
			}
			entries.set(id, next);
			return;
		}
		if (print !== undefined && print === listed.get(id)) return;
		ready.delete(id);
		applied.delete(id);
		listed.delete(id);
		await admit(dir);
	}

	/**
	 * 换代码那一段 —— 生产的「只重载」与开发版的「重载」共用(决策 47)。
	 *
	 * **现读盘上那份**:清单也可能跟着换了,拿名单里那条旧记录去跑新代码,就又是一次
	 * 「新代码配旧清单」。
	 */
	async function replaceCode(id: string): Promise<void> {
		const dir = await readExtensionDir(join(root, id));
		if (dir.state !== "ready") {
			throw new Error(`${id} 盘上那份现在装不起来,换不上 —— 先看拓展页上它那一行`);
		}
		const old = ready.get(id);
		if (old) await stop(old);
		ready.set(id, dir);
		listed.set(id, await recordPrint(dir));
		await start(dir, true);
		// 收摊那一下把开关记成了「没应用」,补回来,免得下一次 sync() 又装一遍。
		applied.set(id, true);
	}

	/** 面板那张表按 id 排。**次序不该跟着「什么时候装的」走** —— 否则重启一次就换个样。 */
	function resort(): void {
		const sorted = [...entries].sort(([a], [b]) => a.localeCompare(b));
		entries.clear();
		for (const [id, entry] of sorted) entries.set(id, entry);
	}

	for (const dir of found) await admit(dir);

	/**
	 * 三条把手(`sync` / `rescan` / `reload`)走**同一条队**:连拨两下开关、装完紧跟着拨、
	 * 边拨开关边重载,后一次都得看见前一次的结果。
	 */
	let queue: Promise<void> = Promise.resolve();

	/**
	 * 串到队尾跑。
	 *
	 * 🔴 **留在队尾的是吞掉失败的那一份。** 把 `run` 本身接回队尾的话,一发拒绝会让之后
	 * **每一次**排队的回调都不跑(rejected promise 的 `.then` 不跑回调)—— 症状是「报过
	 * 一次错之后开关再也拨不动了」,而且没有任何人报错。调用方照样拿到那个拒绝。
	 */
	function enqueue(fn: () => Promise<void>): Promise<void> {
		const run = queue.then(fn);
		queue = run.catch(() => {});
		return run;
	}

	return {
		list: () => [...entries.values()],
		secretConfigCodes: () => {
			const codes: Record<string, readonly string[]> = {};
			for (const entry of entries.values()) {
				// v2 照清单读(ADR-0019 决策 17)—— 没跑起来的也读得到,备份只抹声明的那几格。
				const declared = entry.manifest && manifestSecretKeys(entry.manifest);
				if (declared) codes[entry.id] = declared;
			}
			// v1 的声明在代码里,只有跑着的才交得出来;问不出来的不进表(脱敏那边整片当密钥)。
			for (const [id, runtime] of runtimes) {
				if (!(id in codes)) codes[id] = runtime.secretConfigCodes();
			}
			return codes;
		},
		status: (id) => runtimes.get(id)?.status(),
		pushSource: (id) => runtimes.get(id)?.pushSource(),
		bots: (id) => runtimes.get(id)?.bots(),
		runAction: async (id, name) => runtimes.get(id)?.runAction(name),
		sync() {
			return enqueue(async () => {
				for (const [id, dir] of ready) {
					const wanted = isEnabled(id);
					if (wanted === applied.get(id)) continue;
					applied.set(id, wanted);
					if (wanted) await start(dir);
					else await stop(dir);
				}
			});
		},
		rescan() {
			return enqueue(async () => {
				const now = await discoverExtensions(root);
				const onDisk = new Set(now.map((dir) => dir.id));

				// 先送走消失的。**几张表都要删干净** —— 在 `ready` 里留一格的话,下一次
				// `sync()` 会把一个已经不在盘上的拓展装回来(它的代码还在模块缓存里,真装得起来)。
				// `imported` 例外:模块缓存删不掉,它就得记着(见它的注释)。
				for (const id of [...entries.keys()]) {
					if (onDisk.has(id)) continue;
					const dir = ready.get(id);
					if (dir) await stop(dir);
					ready.delete(id);
					applied.delete(id);
					listed.delete(id);
					entries.delete(id);
				}

				for (const dir of now) {
					// 清单坏了 / 版本不合的那些不在名单里,每次重读:它们一行代码都没跑过,主人
					// 把清单修好、或者换了个版本合的包,重扫就该认出来。
					if (ready.has(dir.id)) await revisit(dir);
					else await admit(dir);
				}
				resort();
			});
		},
		async codeStuck(id) {
			if (entries.get(id)?.staged) return true;
			const dir = ready.get(id);
			if (!dir || runtimes.has(id)) return false;
			return urlFor(id, dir.entry, await fingerprintOf(dir.entry), false) === undefined;
		},
		swap(id) {
			return enqueue(async () => {
				if (!entries.get(id)?.staged) {
					throw new Error(`${id} 没有等着换上的新代码 —— 每重载一次漏一份旧模块,不白漏`);
				}
				await replaceCode(id);
			});
		},
		reload(id) {
			return enqueue(async () => {
				if (!ready.has(id)) throw new Error(`没有装着叫 ${id} 的拓展(或者它的清单就读不出来)`);
				if (!isEnabled(id)) throw new Error(`${id} 的开关关着 —— 先打开它,重载才有东西可换`);
				await replaceCode(id);
			});
		},
		async dispose() {
			// 后起来的先收 —— 与单个拓展内部的收摊次序同一条道理。
			for (const runtime of [...runtimes.values()].reverse()) await runtime.dispose();
			runtimes.clear();
		},
	};
}
