import type { Dirent } from "node:fs";
import { access, readdir, readFile, readlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
	EXTENSION_API_RANGE,
	type ExtensionApiRange,
	type ExtensionApiRequirement,
	type ExtensionIdentity,
	type ExtensionManifest,
	parseExtensionManifest,
} from "@bilibili-notify/internal";
import { safeExtensionIcon, safeManifestIcons } from "./manifest-icon.js";

/**
 * ⛔ **只有一个装载根:`<dataDir>/extensions/`。**
 *
 * 曾经有过三档(载荷自带 / 仓里源码 / `<dataDir>`)。载荷那档 2026-09-09 被主人推翻
 * (本体一个拓展都不带),仓里源码那档 2026-09-10 也去掉了 —— 开发版改由 devtools 把仓里
 * 那份 `dist` **装**进这个根(软链),于是「拓展从哪来」在**所有构建里都是同一句话**:
 * 它在装载目录里。宿主不再需要按来源分入口、分优先级,也就没有「同一个 id 有两份」这回事。
 *
 * 装的动作归 devtools(开发)与插件市场(将来),装载器只管**读这一个目录**。
 */

/**
 * 主人装的拓展落在 `<dataDir>/extensions/`。
 *
 * 🔴 **刻意不在 `<dataDir>/versions/` 底下**:那个目录归自主升级管,`pruneOldVersions`
 * 只留当前 + 上一版,会**主动删掉不在名单里的目录** —— 拓展装进去等于下次升级被清掉。
 */
export function extensionsRootIn(dataDir: string): string {
	return resolve(dataDir, "extensions");
}

/** 拓展包里**必需**那两个文件的名字 —— 清单 + 代码(ADR-0012 决策 8)。 */
export const EXTENSION_MANIFEST_FILE = "extension.json";
/**
 * 入口**只此一个**。
 *
 * ⛔ **清单里没有 `entry` 字段,以后也不加**:清单会进签名摘要,加一格 `entry` 等于让
 * 分发出去的拓展指定加载哪个文件。入口固定,**宿主自己判**。
 */
export const EXTENSION_ENTRY_FILE = "index.mjs";

/**
 * 拓展**给人看的**那两份,都是可选的。
 *
 * 它们和上面两个的区别是**没有任何代码路径会碰它们** —— 装载器不读、`import` 不到,
 * 只有面板拿去渲染。所以它们进白名单不等于放宽了「装载目录里能跑什么」。
 *
 * 名字固定、不进清单:清单里声明「我有 README」而磁盘上没有,就凭空多出一种要处理的态,
 * 而这两个名字本来就是所有人都在用的那两个。
 */
export const EXTENSION_README_FILE = "README.md";
export const EXTENSION_CHANGELOG_FILE = "CHANGELOG.md";
/**
 * 一份文档的上限。拆包那道闸与面板这头的读**共用它** —— 两处各写一个数的话,
 * 装得进去却读不出来(或者反过来)只会在真机上露馅。
 *
 * 打包那头(`scripts/pack-extension.mjs`)是 .mjs、进不来,只能另写一份同样的数;
 * 那边的 `pack-extension.test.mjs` 拿两头对着钉,漂了就红。
 */
export const EXTENSION_DOC_MAX_BYTES = 512 * 1024;

/**
 * 看完一个拓展目录之后的结论 —— **在 import 任何一行拓展代码之前**就能得出。
 *
 * `id` 一律取**目录名**,不取清单里那一格:装载目录是 `<根>/<id>/`、挂载点是
 * `/ext/<id>/*`,两处都按目录算。而且清单读不出来的时候(最容易炸的正是这一步)
 * 目录名是唯一还拿得到的身份 —— 失败记账要有个键。
 */
export type ExtensionDirRead =
	/** 目录里根本没有清单 —— 不是拓展目录。不记账、不报错,跳过。 */
	| { state: "absent"; id: string; dir: string }
	/** 有清单但用不了。**要列出来**:消失的东西没法排查。 */
	| { state: "unreadable"; id: string; dir: string; detail: string }
	/**
	 * 它是给别的契约档位写的,或要的契约小号比这台 BN 的高(ADR-0019 决策 59)。列出来、说清楚,
	 * 不加载。
	 *
	 * 只带**身份那几格**:那一档的格式我们可能根本不认识,其余部分没有读。
	 */
	| {
			state: "incompatible";
			id: string;
			dir: string;
			identity: ExtensionIdentity;
			requires: ExtensionApiRequirement;
			range: ExtensionApiRange;
	  }
	/** 可以加载了 —— 真加不加载还要看开关(`globals.extensions.<id>.enabled`)。 */
	| {
			state: "ready";
			id: string;
			dir: string;
			manifest: ExtensionManifest;
			/** 要 import 的那个文件,绝对路径。 */
			entry: string;
			/** `dir` 是条软链时,它指到哪去 —— 面板要印出「跑的其实是仓里那份」。 */
			linkedTo?: string;
	  };

/** 这个目录要是条软链,它指向哪。不是软链(或读不了)就是 `undefined`。 */
async function linkTarget(dir: string): Promise<string | undefined> {
	try {
		return await readlink(dir);
	} catch {
		return undefined;
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

export interface ReadExtensionDirOptions {
	/** 宿主认的档位区间。只有测试会换。 */
	hostApiRange?: ExtensionApiRange;
}

/**
 * 「版本不合」说成人话 —— 装载列表、上传装包、市场三处说的是同一句,分头写会说成三种。
 *
 * 档位的两个方向要分开说:高了是 BN 旧了(先升级 BN),低了是拓展旧了(换它的新版)——
 * 一律叫主人升级 BN 的话,抬过最低档之后那句话就是错的。档位对、小号高(ADR-0019 决策 59)
 * 也是 BN 旧了,要几号、BN 是几号都写出来。
 */
export function apiVersionMismatch(
	requires: ExtensionApiRequirement,
	range: ExtensionApiRange,
): string {
	const { apiVersion } = requires;
	const accepts =
		range.min === range.current ? `v${range.current}` : `v${range.min}–v${range.current}`;
	if (apiVersion > range.current) {
		return `它要宿主契约 v${apiVersion},这一版 BN 只认 ${accepts} —— 先升级 BN`;
	}
	if (apiVersion < range.min) {
		return `它是给宿主契约 v${apiVersion} 写的,这一版 BN 只认 ${accepts} —— 换它的新版`;
	}
	return `它要宿主契约 v${apiVersion} 的小号 ${requires.apiRevision ?? 0},这一版 BN 只到小号 ${range.revision} —— 先升级 BN`;
}

/**
 * 读一个拓展目录的清单,并在**执行之前**把能判的都判了。
 *
 * 判的顺序是有讲究的:先「它是给哪一档写的」,再按那一档的格式看「立不立得住」。反过来
 * 的话,一份为将来宿主写的清单会被我们按今天的规矩挑出一堆毛病,而真正的原因只有一条 ——
 * 版本不合。
 */
export async function readExtensionDir(
	dir: string,
	options: ReadExtensionDirOptions = {},
): Promise<ExtensionDirRead> {
	const range = options.hostApiRange ?? EXTENSION_API_RANGE;
	const id = basename(dir);
	let text: string;
	try {
		text = await readFile(join(dir, EXTENSION_MANIFEST_FILE), "utf8");
	} catch {
		return { state: "absent", id, dir };
	}

	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		return {
			state: "unreadable",
			id,
			dir,
			detail: `${EXTENSION_MANIFEST_FILE} 不是合法 JSON:${(err as Error).message}`,
		};
	}

	// 先单读 apiVersion、再按那一档的格式读其余(ADR-0019 决策 18)—— 为将来的宿主写的
	// 清单,格式本来就可能是我们不认识的,挑它的毛病只会把「版本不合」说成「读不了」。
	const read = parseExtensionManifest(raw, range);
	if (!read.ok && read.reason === "unreadable") {
		return {
			state: "unreadable",
			id,
			dir,
			detail: `${EXTENSION_MANIFEST_FILE} 不合法 —— ${read.issues.join(";")}`,
		};
	}

	// 清单里的 id 与目录名对不上 = 两个身份。挂载点按目录算、清单按自己那格算,
	// 放过去的话「面板上点的」与「实际在跑的」会是两个东西。版本不合的也先判这一条。
	const claimed = read.ok ? read.manifest.id : read.identity.id;
	if (claimed !== id) {
		return {
			state: "unreadable",
			id,
			dir,
			detail: `清单里的 id 是 ${claimed},与目录名 ${id} 对不上`,
		};
	}

	// 图标当场过白名单(决策 20)—— **这里是唯一的门**:再往下走,清单会被面板原样
	// 塞进 DOM。坏图标不是拒绝加载的理由,它只是退回灰方章。
	if (!read.ok) {
		return {
			state: "incompatible",
			id,
			dir,
			identity: { ...read.identity, icon: safeExtensionIcon(read.identity.icon) },
			requires: read.requires,
			range,
		};
	}
	const manifest = safeManifestIcons(read.manifest);

	const entry = join(dir, EXTENSION_ENTRY_FILE);
	if (!(await exists(entry))) {
		return { state: "unreadable", id, dir, detail: `少了入口文件 ${EXTENSION_ENTRY_FILE}` };
	}

	// 软链就把落点也报出来:开发版装进来的是仓里那份 `dist`,而「跑的到底是哪一份」
	// 只有这一句答得了。不是软链就没有这一格(`readlink` 会抛 EINVAL)。
	const linkedTo = await linkTarget(dir);
	return linkedTo === undefined
		? { state: "ready", id, dir, manifest, entry }
		: { state: "ready", id, dir, manifest, entry, linkedTo };
}

export interface DiscoverExtensionsOptions {
	hostApiRange?: ExtensionApiRange;
}

/**
 * 扫一遍装载目录,把每个子目录读成一条记录。
 *
 * **一个根**(见文件头):所以没有优先级、没有「同一个 id 有两份」—— 同名目录在一个目录里
 * 本来就只能有一个。两条来路(市场装的、主人手放的、以及开发版 devtools 链进来的)在这里
 * 一视同仁,扫目录这一步分不出也不必分。
 *
 * **没有清单的子目录不进表**:那不是拓展,不该在面板上占一行。而清单坏了的要进表 ——
 * 消失的东西没法排查。根目录不存在时当空:头一次开机本来就没有它。
 */
export async function discoverExtensions(
	root: string,
	options: DiscoverExtensionsOptions = {},
): Promise<Array<Exclude<ExtensionDirRead, { state: "absent" }>>> {
	let entries: Dirent[];
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return [];
	}
	// 🔴 **软链也算**:`readdir(withFileTypes)` 是 lstat 语义 —— 一条指向目录的软链
	// `isDirectory()` 是 false。只认目录的话,软链进来的拓展**一声不响地不出现**。
	// 开发版就是这么装的(devtools 把仓里的 `dist` 链进来),下载装的将来也可能是链。
	// 链到文件 / 断链的那些照旧走 `readExtensionDir`:读不到清单 = 不是拓展目录,跳过。
	// 点开头的一律不看:安装的暂存目录 `.staging-<id>-xxxx` 就建在这个根里,进程在 rename 之前
	// 被杀,它就带着一份合法清单留在盘上 —— 当成拓展读出来是一张删不掉的 unreadable 卡。
	const dirs = entries
		.filter(
			(entry) => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith("."),
		)
		.map((entry) => entry.name);
	const reads = await Promise.all(dirs.map((name) => readExtensionDir(join(root, name), options)));

	// 按名字排:`readdir` 的顺序随文件系统走,不排的话面板列表每次开机都可能换个次序。
	return reads
		.filter((read) => read.state !== "absent")
		.sort((a, b) => a.id.localeCompare(b.id)) as Array<
		Exclude<ExtensionDirRead, { state: "absent" }>
	>;
}
