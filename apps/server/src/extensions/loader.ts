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
	type ExtensionManifestField,
	type ExtensionRunState,
	type InboundSinks,
	manifestSecretKeys,
	type ServiceContext,
	type SubscriptionReportDelivery,
} from "@bilibili-notify/internal";
import type { ZodType } from "zod";
import type { AdapterRegistry } from "../platforms/registry.js";
import {
	type ActionOutcome,
	createExtensionContext,
	type ExtensionContext,
	type ExtensionPushView,
	type ExtensionRuntime,
	type ExtensionSubscriptionRow,
	type LookupOutcome,
	type SubscriptionReportProblem,
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
import { judgeStoredSettings, type StoredSettingsVerdict } from "./settings-io.js";
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
	 *
	 * 🔴 **「新版等着换上」只有这一种写法**,凡是这样的行都带,**关着的也带**:跑着的照跑旧的
	 * (`state: "running"`);开着没跑的不跑(`state: "staged"`,由「开着 && 没在跑 && 带它」推出来,
	 * 不单独存);关着的照旧是 `disabled`。前两种等主人选重启 BN 或 {@link LoadedExtensions.swap};
	 * 关着的只有重启 —— 只重载会把它跑起来。
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
	secretConfigCodes(): ReadonlyMap<string, readonly string[]>;
	/**
	 * 某个拓展交上来的面板数据(v2 `ctx.publishView`、v1 `ctx.publishStatus`)。**现取** —— 拓展给的是个函数,
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
	 * 问某个拓展的解析门(ADR-0019 决策 11 / 52):主人输入的原话交过去,候选先核形状再交回。
	 * 没在跑、或者它不是订阅源就是 `undefined`(路由回 404)。`timeoutMs` 默认 `LOOKUP_TIMEOUT_MS`。
	 */
	lookup(
		id: string,
		query: string,
		opts?: { timeoutMs?: number },
	): Promise<LookupOutcome | undefined>;
	/**
	 * 某个拓展经 `ctx.settings(schema)` 交过的 zod —— 写它的设置时再过一道(ADR-0019 决策 35)。
	 * 没在跑就是 `undefined`;跑着但没交过是空表。**现取**:跑着的认跑着的那一份,换过代码的交的是
	 * 新的;「设置读不了」的交它收摊前留下的那份(决策 36)—— 它正等着主人把设置改对。
	 */
	settingsSchemas(id: string): readonly ZodType[] | undefined;
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
	 * 只在进程里第一次见到它时成立:删了再装的按指纹判,这个进程跑过它别的代码的,那一行
	 * 也标上 `staged` —— 关着的也标(见 {@link ExtensionEntry.staged})。
	 *
	 * 显式调用:装 / 卸是低频动作,而扫盘不该挂在高频路径上(同 `sync()` 那条理由)。
	 * 与 `sync()` / `reload()` / `swap()` 同一条队,自己吞异常,不会抛。
	 */
	rescan(): Promise<void>;
	/**
	 * **在队里改装载根**:跑 `write`(解包落盘 / 抹掉目录),紧跟着再扫一遍 —— 两步是队里的**一件
	 * 事**(ADR-0019 决策 45)。面板上传装包、市场装、卸载都走这扇门。
	 *
	 * 🔴 队外写的话,并发的 `sync()` / `rescan()` / `swap()` / `reload()` 会看见写了一半的目录:
	 * 清单落了、入口还没落,面板上闪一张 unreadable,开关拨过的还会真去起它。
	 *
	 * `write` 抛了也照样重扫(装到一半删了旧目录、新的没换过去,盘上已经变了),然后把那一发原样
	 * 交回调用方。⚠️ `write` 里别再等这条队上的东西 —— 那是自己等自己。
	 */
	changeDisk<T>(write: () => Promise<T>): Promise<T>;
	/**
	 * **只重载这个拓展**(生产那颗按钮,ADR-0012 决策 47):现读盘上那份 → 收摊 → 换一个按
	 * 指纹定的 URL 重新 `import` → 重新 `activate`。
	 *
	 * 🔴 **只在「开着 && 带 `staged`」时给按**,否则抛:ESM 的模块缓存删不掉,每换一份新代码就漏
	 * 一份旧模块 —— 漏可以,但不该在没有新代码的时候白漏;关着的带着 `staged` 也不给,换上去就是
	 * 把它跑起来,那是开关的活。不记账(理由同 `reload`)。
	 */
	swap(id: string): Promise<void>;
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

/**
 * 一个拓展从 import 到 `activate` 回来最多等多久。过了按这一次加载失败算,队接着走。
 *
 * 🔴 等不起:装载排在一条队里,开机那一趟还挡在 HTTP 起来之前 —— 一个挂住的 `activate` 会让
 * 整个面板连不上,之后的开关、装包、只重载全排在它后面(ADR-0019 决策 45)。
 */
export const ACTIVATE_TIMEOUT_MS = 30_000;

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
	/** 全部拓展订阅(归属 + 外部 id + 开关),现读。属于谁由 ctx 那一层筛。 */
	subscriptions: () => readonly ExtensionSubscriptionRow[];
	/** 订阅「订阅动过了」。 */
	onSubscriptionsChanged: (fn: () => void) => Disposable;
	/**
	 * 订阅源拓展报上来一条、核过、对上了它名下的订阅(ADR-0019 决策 7 / 62)—— 宿主发到 bus。载荷里
	 * 已经带着拓展 id。
	 */
	onSubscriptionReport?: (delivery: SubscriptionReportDelivery) => void;
	/** 「上报问题」(决策 60):丢格、整条拒。ctx 已经记过日志;这里接到拓展详情页那个框上。 */
	onSubscriptionReportProblem?: (problem: SubscriptionReportProblem) => void;
	/** 某个拓展自己那份设置(`globals.extensions.<id>.settings`),现读、原样。 */
	settings: (id: string) => unknown;
	/** 订阅「globals 落盘了」。内容变没变由 ctx 判。 */
	onSettingsChanged: (fn: () => void) => Disposable;
	/**
	 * 某个拓展喊了「面板数据变了」(`ctx.statusChanged`);宿主把它推到面板。只有拓展自己喊才叫它 ——
	 * 上报问题(ADR-0019 决策 60)的那一声在问题记录那头发,不走这里。
	 */
	onStatusChanged?: (id: string) => void;
	/**
	 * 某个拓展不在跑了 —— 它那面 ctx 开始收摊的那一刻(停用、卸载、换代码、加载失败、设置读不了、关机
	 * 都算,见 `CreateExtensionContextOptions.onDisposed`)。宿主据此作废替它记着的在播状态(ADR-0019 决策 61)。
	 */
	onStopped?: (id: string) => void;
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
	/** 见 {@link ACTIVATE_TIMEOUT_MS}。只有测试会换。 */
	activateTimeoutMs?: number;
	/** 收摊钩子一共等多久,见 `DISPOSE_TIMEOUT_MS`。只有测试会换。 */
	disposeTimeoutMs?: number;
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

/** 等过了时限。与拓展自己抛的错分开认 —— 那一行要说清是超时,而且晚到的那一下还得有人管。 */
class Overdue extends Error {}

/** `work` 在 `ms` 之内没落定就以 {@link Overdue} 拒掉。`work` 本身不会被取消 —— 也取消不了。 */
async function within<T>(work: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Overdue()), ms);
	});
	try {
		return await Promise.race([work, deadline]);
	} finally {
		clearTimeout(timer);
	}
}

/** 读得懂、版本合的那一份目录。 */
type ReadyDir = Extract<ExtensionDirRead, { state: "ready" }>;
/** 扫出来的一条(没有清单的子目录不进表,见 `discoverExtensions`)。 */
type DiskRead = Exclude<ExtensionDirRead, { state: "absent" }>;

/** 一条记录的样子(入口指纹 + 清单)—— 「这是哪一份」就认这两样。 */
function recordOf(print: string | undefined, manifest: ExtensionManifest): string {
	return `${print}\n${JSON.stringify(manifest)}`;
}

/**
 * **一个拓展此刻的全部事实**,一格。面板那一行、下一次起它用哪份、跑着的是哪份、开关落实到
 * 哪儿了,都只住在这里;`list()` 那一行由它现推({@link LoadedExtensions.list})。
 *
 * 🔴 曾经分在七张表里(名单、跑着的、装得起来的、落实过的开关、读盘时的样子、跑着的那份的
 * 样子……),09-23 修过的「标了等着换上、名单里却还是旧清单」就是改了一张忘了另一张。收成一格
 * 之后,「盘上那份」与「跑着那份」是同一格里的两个字段,不会再一个跟着盘走、一个没跟上。
 *
 * 唯一不在这里的是「这个进程 import 过哪几份代码」(见 `imported`):它是 Node 模块缓存的镜像,
 * 活得比任何一格都长 —— 卸掉时格子删了,那份记忆不能跟着删。
 */
interface Slot {
	/**
	 * 盘上那份,最近一次读到的样子(开机 / 重扫 / 换代码时现读)。**下一次起它用的就是这份** ——
	 * 跑着的那份另记在 `running` 里,盘上换了不碰它。
	 */
	disk: DiskRead;
	/** `disk` 读得懂时,它入口文件的指纹。 */
	print?: string;
	/** 上一次落实过的开关。热装卸只认**变化**,见 `sync()` 的注释。 */
	applied: boolean;
	/** 眼下跑着的那一份:它的把手、起它时用的目录与清单、代码指纹。 */
	running?: {
		runtime: ExtensionRuntime;
		dir: ReadyDir;
		print?: string;
		/** 第几个起来的 —— 收摊时后起来的先收。 */
		order: number;
	};
	/**
	 * 开着却没起来的原因:这一次炸了、连败自动停用了,或者存着的设置过不了它自己的 zod。关掉、起来、
	 * 换了记录都清。
	 */
	miss?:
		| { state: "failed" | "blocked"; detail: string }
		| {
				state: "settings-invalid";
				detail: string;
				/**
				 * 它上次交过的 zod(ADR-0019 决策 36)—— **收摊之后也留着**:设置每变一次拿它判改对了
				 * 没有(改对了才起,不为判一下再跑一遍 activate);写设置的路由也拿它做前后比对。
				 */
				schemas: readonly ZodType[];
		  };
}

/**
 * 面板那一行里「它是谁、在盘上哪儿」那几格 —— 跑着的、停用的、刚收摊的,都得原样带上。
 *
 * `linkedTo` 只有**它真是条软链**时才有这一格:开发版由 devtools 链进来的那份指着仓库
 * 工作树,而「跑的到底是哪一份」只有它答得了。
 */
function entryBase(dir: ReadyDir): Pick<ExtensionEntry, "id" | "dir" | "linkedTo"> {
	return {
		id: dir.id,
		dir: dir.dir,
		...(dir.linkedTo === undefined ? {} : { linkedTo: dir.linkedTo }),
	};
}

/** 清单里声明的设置项。v1 的设置不在清单里(桥那一版是手写页)。 */
function declaredSettings(manifest: ExtensionManifest): readonly ExtensionManifestField[] {
	return manifest.apiVersion === 2 ? (manifest.settings?.fields ?? []) : [];
}

/**
 * 清单声明了设置项的 v2,activate 里必须把校验它们的 zod 交上来(ADR-0019 决策 35)—— 面板照清单
 * 放行的值,清单表达不了整数、正则、跨字段规则;写入不再过拓展自己那一道,它一读就可能整份解不开。
 * 不交按加载失败算。v1 不管:它的设置不在清单里。
 */
function assertSettingsHanded(manifest: ExtensionManifest, runtime: ExtensionRuntime): void {
	if (declaredSettings(manifest).length === 0) return;
	if (runtime.settingsSchemas().length > 0) return;
	throw new Error(
		"清单里声明了设置项,activate 里却没交校验它们的 zod —— 要调 ctx.settings(schema):面板写进来的值得再过拓展自己那一道",
	);
}

/** 「设置读不了」那一行:哪一格、为什么,再加一句怎么办 —— v1 在面板上改不了设置,出路不一样。 */
function unreadableDetail(manifest: ExtensionManifest, why: string): string {
	const fix =
		manifest.apiVersion === 1
			? "老格式的拓展在面板上改不了设置 —— 去市场更新它,或者恢复一份好的备份;设置一对上它会自己起来"
			: "在它的「配置」里改对,改对了会自己起来";
	return `存着的设置不合它自己的规矩:${why}。${fix}`;
}

/**
 * 扫一遍装载目录,把该跑的跑起来,并把这批拓展的**装卸把手**交回去。
 *
 * 之后名单靠这几个把手动:拨开关走 `sync()`,装 / 卸走 `changeDisk()`(改盘 + 再扫一遍,队里
 * 一件事;盘已经被别人改好了的走 `rescan()`),换代码走 `swap()` / `reload()`(后者开发版专用)。
 * 分开,是因为它们的代价与语义都不一样。
 */
export async function loadExtensions(opts: LoadExtensionsOptions): Promise<LoadedExtensions> {
	const { root, host, mounts, isEnabled, maxFailures } = opts;
	// 记账落在**装载目录本身**(`<dataDir>/extensions/load-state.json`),绝不写进某个拓展
	// 自己的目录:「它连炸了几次」是这一台机器的状态,而那个目录随时会被换掉 —— 开发版
	// 装进来的那份还是仓库工作树的软链,往里写等于往 `git status` 里拉屎。
	const ledgerRoot = root;
	const importModule = opts.importModule ?? realImport;
	const activateTimeoutMs = opts.activateTimeoutMs ?? ACTIVATE_TIMEOUT_MS;
	const found = await discoverExtensions(root);

	/** 每个拓展一格。按 id 排(`discoverExtensions` 已排好,重扫之后 `resort()` 再归位)。 */
	const slots = new Map<string, Slot>();
	/**
	 * 这个进程里每个 id **import 过的每一份代码**:入口指纹 → 那一份用的 URL(决策 47)。
	 *
	 * 🔴 **只增不减**,卸掉、重扫都不删 —— 所以它不住在格子里(格子随卸载删掉):模块缓存本身
	 * 删不掉,这里忘了它,下一次就会拿同一个 URL 去要一份新代码,而 Node 交回来的是旧的 ——
	 * 配上现读的新清单,就是 devtools 装桥时炸的那一下。
	 */
	const imported = new Map<string, Map<string, string>>();
	/** 起来的次序,见 `Slot.running.order`。 */
	let started = 0;
	/** 上一次记过的记账写盘错 —— 同一个错只记一行(每个拓展每次起都要写两回)。 */
	let ledgerError: string | undefined;

	/**
	 * 动名单的把手(`sync` / `rescan` / `changeDisk` / `swap` / `reload`)走**同一条队**:连拨两下
	 * 开关、装完紧跟着拨、边拨开关边重载,后一次都得看见前一次的结果。开机那一趟与设置那一侧的
	 * 对账也排在这条队里。
	 */
	let queue: Promise<void> = Promise.resolve();

	/**
	 * 串到队尾跑。
	 *
	 * 🔴 **留在队尾的是吞掉失败的那一份。** 把 `run` 本身接回队尾的话,一发拒绝会让之后
	 * **每一次**排队的回调都不跑(rejected promise 的 `.then` 不跑回调)—— 症状是「报过
	 * 一次错之后开关再也拨不动了」,而且没有任何人报错。调用方照样拿到那个拒绝。
	 */
	function enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const run = queue.then(fn);
		queue = run.then(
			() => {},
			() => {},
		);
		return run;
	}

	/**
	 * 失败记账写不进去(只读挂载、磁盘满、那个位置被占了)。照样加载 —— 记账是启发,坏了不该让
	 * 拓展起不来,更不该把开机带走;但要说一声:写不进去的时候,「连着失败就自动停用」是失效的,
	 * 一个真炸的拓展会每次开机都炸一遍。
	 */
	function ledgerUnwritable(err: unknown): void {
		const message = err instanceof Error ? err.message : String(err);
		if (message === ledgerError) return;
		ledgerError = message;
		host.logger.warn(
			`[ext] 失败记账写不进去(${message})—— 拓展照常加载,但「连着失败就自动停用」此刻不起作用`,
		);
	}

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

	/**
	 * 盘上那份这个进程**干净地换不上**(决策 47)—— 「新版等着换上」只从这里推出来。
	 *
	 * 跑着的:盘上那份(代码 + 清单)与跑着的那份不是同一份,就得等主人选怎么换 —— 跑着的不偷偷换。
	 * 没跑的:这个 id 跑过别的代码、没见过盘上这一份,拨开开关也只会停在这儿。
	 */
	function stagedOf(slot: Slot): { version: string } | undefined {
		const { disk, running } = slot;
		if (disk.state !== "ready") return undefined;
		const stuck = running
			? recordOf(slot.print, disk.manifest) !== recordOf(running.print, running.dir.manifest)
			: urlFor(disk.id, disk.entry, slot.print, false) === undefined;
		return stuck ? { version: disk.manifest.version } : undefined;
	}

	/** 面板那一行,从格子现推。 */
	function entryOf(slot: Slot): ExtensionEntry {
		const { disk, running } = slot;
		const staged = stagedOf(slot);
		if (running) {
			return {
				...entryBase(running.dir),
				state: "running",
				manifest: running.dir.manifest,
				...(staged ? { staged } : {}),
			};
		}
		if (disk.state === "unreadable") {
			return { id: disk.id, dir: disk.dir, state: "unreadable", detail: disk.detail };
		}
		if (disk.state === "incompatible") {
			return {
				id: disk.id,
				dir: disk.dir,
				state: "incompatible",
				identity: disk.identity,
				detail: apiVersionMismatch(disk.requires, disk.range),
			};
		}
		const at = { ...entryBase(disk), manifest: disk.manifest };
		// 关着的也带上 `staged`:装完那一刻、详情页照这一格就说得出「拨开也换不上」,不必各自现判。
		if (!slot.applied) return { ...at, state: "disabled", ...(staged ? { staged } : {}) };
		// 线上那档 `state: "staged"` 只在这儿推出来 —— 开着、没在跑、带着 `staged`。不单独存。
		if (staged) return { ...at, state: "staged", staged };
		if (slot.miss) return { ...at, state: slot.miss.state, detail: slot.miss.detail };
		return { ...at, state: "disabled" };
	}

	async function start(
		slot: Slot,
		/** 主人手按的重载:换得上新代码,并且**不走记账**(理由见 `reload`)。 */
		fresh = false,
	): Promise<void> {
		const dir = slot.disk;
		if (dir.state !== "ready") return;
		const { id, manifest } = dir;
		slot.miss = undefined;

		// 起之前再认一次盘上那份:扫盘之后被手换过的话,记下的得是真 import 的那一份。
		const print = await fingerprintOf(dir.entry);
		slot.print = print;
		const url = urlFor(id, dir.entry, print, fresh);
		if (url === undefined) {
			// 一行代码都不跑、也不记账:这不是它的错,是这个进程换不上。那一行由 `stagedOf` 推出来。
			host.logger.warn(
				`[ext] ${id} v${manifest.version} 换不上:这个进程跑过它的另一份代码 —— 重启 BN,或在它的详情页里只重载它`,
			);
			return;
		}
		// 记账**现读**:热装卸期间失败也要算数,拿开机那一刻的快照会漏掉。
		if (!fresh && readLoadLedger(ledgerRoot).blocked.includes(`${id}@${manifest.version}`)) {
			slot.miss = {
				state: "blocked",
				detail: `连续加载失败 ${maxFailures} 次,已自动停用;换一版会重新试`,
			};
			return;
		}
		if (print !== undefined) {
			const seen = imported.get(id) ?? new Map<string, string>();
			seen.set(print, url);
			imported.set(id, seen);
		}

		// **先记账再加载**:反过来的话,「一 import 就把进程带走」这种循环永远累加不到上限。
		if (!fresh) {
			recordLoadAttempt({
				root: ledgerRoot,
				id,
				version: manifest.version,
				maxFailures,
				onUnwritable: ledgerUnwritable,
			});
		}

		const runtime = createExtensionContext({
			id,
			manifest,
			host,
			mounts,
			adapters: opts.adapters,
			connections: opts.connections,
			connection: opts.connection,
			onConnectionsChanged: opts.onConnectionsChanged,
			subscriptions: opts.subscriptions,
			onSubscriptionsChanged: opts.onSubscriptionsChanged,
			onSubscriptionReport: opts.onSubscriptionReport,
			onSubscriptionReportProblem: opts.onSubscriptionReportProblem,
			settings: () => opts.settings(id),
			onSettingsChanged: opts.onSettingsChanged,
			// 跑着时设置被旁路写坏:ctx 没把那一份交给它,这里排一趟把它收掉。
			onSettingsInvalid: settleLater,
			onStatusChanged: () => opts.onStatusChanged?.(id),
			onDisposed: () => opts.onStopped?.(id),
			inbound: opts.inbound,
			upgrades: opts.upgrades,
			hostVersion: opts.hostVersion,
			disposeTimeoutMs: opts.disposeTimeoutMs,
		});
		/** 走到哪一步了 —— 超时那句话要说清是卡在 import、activate 还是判设置。 */
		const at = { step: `import ${EXTENSION_ENTRY_FILE}` };
		/** 回的是「存着的设置读不了」的原因;起得来就是 `undefined`。真失败一律抛。 */
		const loading = (async (): Promise<string | undefined> => {
			// 入口固定 `index.mjs`,**宿主自己判**、清单说了不算 —— 见 `EXTENSION_ENTRY_FILE`。
			// ⚠️ 第二次启用时这里拿到的是**模块缓存里那份**:ESM 换不掉已加载的代码
			// (决策 10),重新跑的只有 `activate`。所以拓展的模块顶层不许存状态。
			const mod = (await importModule(url)) as Partial<ExtensionModule>;
			if (typeof mod.activate !== "function") {
				throw new Error(`${EXTENSION_ENTRY_FILE} 没有导出 activate()`);
			}
			at.step = "activate()";
			let crashed: { err: unknown } | undefined;
			try {
				await mod.activate(runtime.ctx);
			} catch (err) {
				crashed = { err };
			}
			// 🔴 **不论 activate 抛没抛**,先问设置读不读得了(ADR-0019 决策 36):没接住的话抛出来的
			// 正是 `ctx.settings()` 那一下,那不是它崩了;拓展 try/catch 吞了那一抛,也照样作数。
			at.step = "判存着的设置";
			const unreadable = await runtime.verifySettings();
			if (unreadable !== undefined) return unreadable;
			if (crashed) throw crashed.err;
			assertSettingsHanded(manifest, runtime);
			return undefined;
		})();
		try {
			// import、activate 与判设置一起算时限:模块顶层 await 挂住,与 activate 挂住、拓展的异步
			// refine 挂住是同一件事 —— 都会让整条队陪着等。
			const unreadable = await within(loading, activateTimeoutMs);
			// 设置读不了也销账:代码 import 得进来、activate 回得来,这不是它崩了(见下)。
			markLoadSucceeded({
				root: ledgerRoot,
				id,
				version: manifest.version,
				onUnwritable: ledgerUnwritable,
			});
			if (unreadable !== undefined) {
				await park(slot, runtime, manifest, unreadable);
				return;
			}
			started += 1;
			slot.running = { runtime, dir, print, order: started };
			// 带上代码指纹:「现在跑的是哪一份」一眼对得上盘上那份;软链那份把落点也印出来 ——
			// 开发版跑的其实是仓里的工作树,「我改的那个到底跑没跑」不必再查一遍。
			host.logger.info(
				`[ext] ${id} v${manifest.version} ${fresh ? "已重载" : "已加载"}(代码 ${print?.slice(0, 8) ?? "?"})${dir.linkedTo ? `(→ ${dir.linkedTo})` : ""}`,
			);
		} catch (err) {
			const detail =
				err instanceof Overdue
					? `${at.step} 超过 ${activateTimeoutMs / 1000} 秒没回来,按加载失败算`
					: (err as Error).message;
			if (err instanceof Overdue) {
				// 🔴 晚到的那一下**不许登记成在跑**:这一次已经按失败记了账、收了摊。它之后才注册的
				// 东西 ctx 一律拒(已经收摊);这里再尽力收一次,万一收摊之前还有漏网的。
				const step = at.step;
				loading.then(
					() => {
						runtime.ctx.logger.warn(`${step} 超时之后才回来 —— 已经按加载失败收过摊,不再登记`);
						return runtime.dispose();
					},
					() => {},
				);
			}
			// 半个拓展不许留在那:`activate` 抛之前注册过的定时器 / 端点当场回收。
			// 留着的话面板写「没起来」而它的定时器还在跑 —— 那比要求重启难查得多。
			await runtime.dispose();
			runtime.ctx.logger.error(`加载失败:${detail}`);
			slot.miss = { state: "failed", detail };
		}
	}

	/**
	 * 「设置读不了」(ADR-0019 决策 36):收掉这一份,那一行写原因,留下它交过的 zod。
	 *
	 * 🔴 **不累进失败记账**(调用方负责销掉起它之前记的那一笔):代码 import 得进来、activate 回得来,
	 * 只是存着的设置不合它自己的规矩 —— 这不是崩了。按失败记的话开机两三次它就被自动停用,主人把
	 * 设置改对了它也起不来,还得换一版才解封。
	 */
	async function park(
		slot: Slot,
		runtime: ExtensionRuntime,
		manifest: ExtensionManifest,
		why: string,
	): Promise<void> {
		// 收摊会清空 runtime 上那份名单,先抄下来。
		const schemas = runtime.settingsSchemas();
		await runtime.dispose();
		slot.miss = { state: "settings-invalid", detail: unreadableDetail(manifest, why), schemas };
		host.logger.warn(`[ext] ${manifest.id} v${manifest.version} 设置读不了,不跑:${why}`);
	}

	/** 收掉跑着的那份(没在跑就什么都不做)。那一行怎么写由格子现推。 */
	async function stop(slot: Slot): Promise<void> {
		const running = slot.running;
		slot.running = undefined;
		slot.miss = undefined;
		// 收摊自己吞异常,拆到一半也会把剩下的拆完。
		if (!running) return;
		await running.runtime.dispose();
		host.logger.info(`[ext] ${running.dir.id} 已停下`);
	}

	/**
	 * 把一条扫出来的记录收进名单(新开一格)—— **开机与重扫走的是同一段**,两处分头写的话,
	 * 新装进来的拓展会与开机装上的差一点(记账、开关、面板那一行),而差别只在真机上露面。
	 *
	 * 顺序是刻意的:**先判断,再决定要不要 import**。清单存在的理由就在这儿 —— 没启用的、
	 * 版本不合的、已经被记账停用的,都不该有一行代码跑起来(ADR-0012 决策 8)。
	 */
	async function admit(dir: DiskRead): Promise<void> {
		const slot: Slot = { disk: dir, applied: false };
		slots.set(dir.id, slot);
		if (dir.state !== "ready") return;
		slot.print = await fingerprintOf(dir.entry);
		slot.applied = isEnabled(dir.id);
		if (slot.applied) await start(slot);
	}

	/**
	 * 已经在名单里的那格,盘上换过没有(决策 47)。
	 *
	 * **跑着的不偷偷换**:只把盘上那份记进格子(下一次起它、只重载都用它),跑着的照跑旧的,
	 * 「等着换上」由 `stagedOf` 推出来。没跑的:没换过不碰 —— 加载失败的那个也不借重扫重试
	 * (开关不动就不重试,见 `sync()`);换过了就换成新记录再收一遍,换不换得上由 `start()` 判。
	 */
	async function revisit(slot: Slot, dir: DiskRead): Promise<void> {
		const print = dir.state === "ready" ? await fingerprintOf(dir.entry) : undefined;
		if (slot.running) {
			const before = stagedOf(slot);
			slot.disk = dir;
			slot.print = print;
			const after = stagedOf(slot);
			// 每次重扫都会走到这儿(装别的拓展也扫):只在头一回标上 / 换了一版时记。
			if (after && after.version !== before?.version) {
				host.logger.info(
					`[ext] ${dir.id} 盘上换成了 v${after.version},跑的还是 v${slot.running.dir.manifest.version} —— 等着换上(重启 BN 或只重载它)`,
				);
			}
			return;
		}
		const was = slot.disk;
		if (
			was.state === "ready" &&
			dir.state === "ready" &&
			recordOf(print, dir.manifest) === recordOf(slot.print, was.manifest)
		) {
			return;
		}
		await admit(dir);
	}

	/**
	 * 换代码那一段 —— 生产的「只重载」与开发版的「重载」共用(决策 47)。
	 *
	 * **现读盘上那份**:清单也可能跟着换了,拿格子里那条旧记录去跑新代码,就又是一次
	 * 「新代码配旧清单」。
	 */
	async function replaceCode(slot: Slot): Promise<void> {
		const id = slot.disk.id;
		const dir = await readExtensionDir(join(root, id));
		if (dir.state !== "ready") {
			throw new Error(`${id} 盘上那份现在装不起来,换不上 —— 先看拓展页上它那一行`);
		}
		await stop(slot);
		slot.disk = dir;
		slot.print = await fingerprintOf(dir.entry);
		// 这一下等于把开关落实成「开」—— 不记下的话,下一次 sync() 又装一遍。
		slot.applied = true;
		await start(slot, true);
	}

	/** 面板那张表按 id 排。**次序不该跟着「什么时候装的」走** —— 否则重启一次就换个样。 */
	function resort(): void {
		const sorted = [...slots].sort(([a], [b]) => a.localeCompare(b));
		slots.clear();
		for (const [id, slot] of sorted) slots.set(id, slot);
	}

	/**
	 * 再扫一遍装载目录,把名单对上盘(`rescan()` 的本体)。**只在队里调** —— 队外调的话,它会与
	 * 并发的开关 / 换代码交错,看见的是一半的格子。
	 */
	async function rescanNow(): Promise<void> {
		const now = await discoverExtensions(root);
		const onDisk = new Set(now.map((dir) => dir.id));

		// 先送走消失的:收摊、整格删掉 —— 留着的话,下一次 `sync()` 会把一个已经不在盘上的
		// 拓展装回来(它的代码还在模块缓存里,真装得起来)。`imported` 不在格子里,记着。
		for (const [id, slot] of [...slots]) {
			if (onDisk.has(id)) continue;
			await stop(slot);
			slots.delete(id);
		}

		for (const dir of now) {
			// 清单坏了 / 版本不合的那些每次重读:它们一行代码都没跑过,主人把清单修好、
			// 或者换了个版本合的包,重扫就该认出来。
			const slot = slots.get(dir.id);
			if (slot) await revisit(slot, dir);
			else await admit(dir);
		}
		resort();
	}

	/**
	 * 把设置那一侧的账对一遍(ADR-0019 决策 36)。「globals 落盘了」与 ctx 喊「设置解不开了」都排
	 * 一趟,**只在队里跑**:它会收摊、会起拓展,与开关 / 装卸 / 换代码交错的话看见的是一半的格子。
	 *
	 * - 跑着的、ctx 记下了「解不开」→ 收掉,那一行变「设置读不了」。那一份它没看见过:ctx 先判再扇出。
	 * - 「设置读不了」的 → 拿它留下的 zod 判现在那份:解得开、开关开着就起起来;还解不开只换原因。
	 *   🔴 判是宿主拿留着的 zod 判的,**不为了看一眼就重跑 activate** —— 那样每存一次全局设置它就
	 *   起一次、收一次。
	 */
	async function settleSettings(): Promise<void> {
		// 宿主已经关机了:排在关机前面的那一趟别再把谁起起来。
		if (closed) return;
		for (const slot of slots.values()) {
			const { running, miss, disk } = slot;
			if (running) {
				const why = running.runtime.settingsProblem();
				if (why === undefined) continue;
				slot.running = undefined;
				await park(slot, running.runtime, running.dir.manifest, why);
				continue;
			}
			if (miss?.state !== "settings-invalid" || disk.state !== "ready") continue;
			// 开关现读:同一次落盘里关了开关的,别先起一下、再被 `sync()` 那一趟收掉。
			if (!isEnabled(disk.id)) continue;
			let verdict: StoredSettingsVerdict;
			try {
				// 判的是拓展的 zod(可能带异步 refine,那是它的代码):挂住了不能让整条队陪着等。
				verdict = await within(
					judgeStoredSettings(
						miss.schemas,
						declaredSettings(disk.manifest),
						opts.settings(disk.id),
					),
					activateTimeoutMs,
				);
			} catch {
				host.logger.warn(
					`[ext] ${disk.id} 的设置校验 ${activateTimeoutMs / 1000} 秒没判完,这一次不管它`,
				);
				continue;
			}
			if (verdict.ok) await start(slot);
			else slot.miss = { ...miss, detail: unreadableDetail(disk.manifest, verdict.detail) };
		}
	}

	/** 排一趟 {@link settleSettings}。自己吞异常 —— 喊它的是 bus 与 ctx,那一发拒绝没人接。 */
	function settleLater(): void {
		enqueue(settleSettings).catch((err) =>
			host.logger.error(`[ext] 对设置那一侧的账时抛了:${(err as Error).message}`),
		);
	}

	/** 宿主关机了(`dispose()`)—— 之后到的「设置变了」一律不管。 */
	let closed = false;
	// 先订再起:开机那一趟里落的盘,排在开机后面对账,不会漏。
	const settingsWatch = opts.onSettingsChanged(settleLater);
	// 开机这一趟也在队里:activate 里喊的「设置解不开了」、开机途中落的盘,都得排在它后面。
	await enqueue(async () => {
		for (const dir of found) await admit(dir);
	});

	return {
		list: () => [...slots.values()].map(entryOf),
		secretConfigCodes: () => {
			const codes = new Map<string, readonly string[]>();
			for (const slot of slots.values()) {
				const entry = entryOf(slot);
				// v2 照清单读(ADR-0019 决策 17)—— 没跑起来的也读得到,备份只抹声明的那几格。
				const declared = entry.manifest && manifestSecretKeys(entry.manifest);
				if (declared) codes.set(entry.id, declared);
			}
			// v1 的声明在代码里,只有跑着的才交得出来;问不出来的不进表(脱敏那边整片当密钥)。
			// 已经照清单记下的不许盖:跑着的 v2 代码那份只有连接配置项,清单那份还带着设置项。
			for (const [id, slot] of slots) {
				if (slot.running && !codes.has(id)) codes.set(id, slot.running.runtime.secretConfigCodes());
			}
			return codes;
		},
		status: (id) => slots.get(id)?.running?.runtime.status(),
		pushSource: (id) => slots.get(id)?.running?.runtime.pushSource(),
		bots: (id) => slots.get(id)?.running?.runtime.bots(),
		runAction: async (id, name) => slots.get(id)?.running?.runtime.runAction(name),
		lookup: async (id, query, lookupOpts) =>
			slots.get(id)?.running?.runtime.lookup(query, lookupOpts),
		settingsSchemas: (id) => {
			const slot = slots.get(id);
			if (slot?.running) return slot.running.runtime.settingsSchemas();
			// 「设置读不了」的交它留下的那份:写入照样走「写前写后只拦新冒出来的」—— 改对一条放行,
			// 写坏别的拦下。只剩清单那一道的话,放进去的值它起来时照样读不了。
			return slot?.miss?.state === "settings-invalid" ? slot.miss.schemas : undefined;
		},
		sync() {
			return enqueue(async () => {
				for (const [id, slot] of slots) {
					// 盘上读不懂、也没在跑的,没有开关可落实 —— 等重扫把它认出来。
					if (slot.disk.state !== "ready" && !slot.running) continue;
					const wanted = isEnabled(id);
					if (wanted === slot.applied) continue;
					slot.applied = wanted;
					if (wanted) await start(slot);
					else await stop(slot);
				}
			});
		},
		rescan() {
			return enqueue(rescanNow);
		},
		changeDisk(write) {
			return enqueue(async () => {
				try {
					return await write();
				} finally {
					// 写那一步抛了也扫:装到一半删了旧目录、新的没换过去,盘上已经变了。
					await rescanNow();
				}
			});
		},
		swap(id) {
			return enqueue(async () => {
				const slot = slots.get(id);
				if (!slot || !stagedOf(slot)) {
					throw new Error(`${id} 没有等着换上的新代码 —— 每重载一次漏一份旧模块,不白漏`);
				}
				// 🔴 关着的也带 `staged`,可换上去就是把它跑起来 —— 那是开关的活,不是这颗钮的。
				if (!isEnabled(id)) {
					throw new Error(`${id} 的开关关着 —— 只重载会把它跑起来;要换就重启 BN,或者先打开它`);
				}
				await replaceCode(slot);
			});
		},
		reload(id) {
			return enqueue(async () => {
				const slot = slots.get(id);
				if (slot?.disk.state !== "ready") {
					throw new Error(`没有装着叫 ${id} 的拓展(或者它的清单就读不出来)`);
				}
				if (!isEnabled(id)) throw new Error(`${id} 的开关关着 —— 先打开它,重载才有东西可换`);
				await replaceCode(slot);
			});
		},
		async dispose() {
			closed = true;
			settingsWatch.dispose();
			// 后起来的先收 —— 与单个拓展内部的收摊次序同一条道理。
			const running = [...slots.values()]
				.flatMap((slot) => (slot.running ? [{ slot, running: slot.running }] : []))
				.sort((a, b) => b.running.order - a.running.order);
			for (const { slot, running: it } of running) {
				slot.running = undefined;
				await it.runtime.dispose();
			}
		},
	};
}
