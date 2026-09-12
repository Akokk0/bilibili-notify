import type { Dirent } from "node:fs";
import { access, readdir, readFile, readlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
	EXTENSION_API_VERSION,
	type ExtensionManifest,
	ExtensionManifestSchema,
} from "@bilibili-notify/internal";
import { safeExtensionIcon } from "./manifest-icon.js";

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

/** 拓展包里那两个文件的名字 —— 拓展包 = 清单 + 代码(ADR-0012 决策 8)。 */
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
	/** 清单没问题,但它是给别的宿主版本写的。列出来、说清楚,不加载。 */
	| {
			state: "incompatible";
			id: string;
			dir: string;
			manifest: ExtensionManifest;
			requires: number;
			host: number;
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
	hostApiVersion?: number;
}

/**
 * 读一个拓展目录的清单,并在**执行之前**把能判的都判了。
 *
 * 判的顺序是有讲究的:先「这份清单本身立得住吗」,再「它是给谁写的」。反过来的话,一份
 * 为将来宿主写的清单会被我们按今天的规矩挑出一堆毛病,而真正的原因只有一条 —— 版本不合。
 */
export async function readExtensionDir(
	dir: string,
	options: ReadExtensionDirOptions = {},
): Promise<ExtensionDirRead> {
	const hostApiVersion = options.hostApiVersion ?? EXTENSION_API_VERSION;
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

	const parsed = ExtensionManifestSchema.safeParse(raw);
	if (!parsed.success) {
		const detail = parsed.error.issues
			.map((issue) => `${issue.path.join(".") || "(根)"}: ${issue.message}`)
			.join(";");
		return {
			state: "unreadable",
			id,
			dir,
			detail: `${EXTENSION_MANIFEST_FILE} 不合法 —— ${detail}`,
		};
	}
	// 图标当场过白名单(决策 20)—— **这里是唯一的门**:再往下走,清单会被面板原样
	// 塞进 DOM。坏图标不是拒绝加载的理由,它只是退回灰方章。
	const manifest: ExtensionManifest = { ...parsed.data, icon: safeExtensionIcon(parsed.data.icon) };

	// 清单里的 id 与目录名对不上 = 两个身份。挂载点按目录算、清单按自己那格算,
	// 放过去的话「面板上点的」与「实际在跑的」会是两个东西。
	if (manifest.id !== id) {
		return {
			state: "unreadable",
			id,
			dir,
			detail: `清单里的 id 是 ${manifest.id},与目录名 ${id} 对不上`,
		};
	}

	// 只比主版本:契约加一格不该判死已经装好的拓展,改一格的语义则必须把旧拓展停在门外。
	if (manifest.apiVersion !== hostApiVersion) {
		return {
			state: "incompatible",
			id,
			dir,
			manifest,
			requires: manifest.apiVersion,
			host: hostApiVersion,
		};
	}

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
	hostApiVersion?: number;
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
	const hostApiVersion = options.hostApiVersion ?? EXTENSION_API_VERSION;
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
	const reads = await Promise.all(
		dirs.map((name) => readExtensionDir(join(root, name), { hostApiVersion })),
	);

	// 按名字排:`readdir` 的顺序随文件系统走,不排的话面板列表每次开机都可能换个次序。
	return reads
		.filter((read) => read.state !== "absent")
		.sort((a, b) => a.id.localeCompare(b.id)) as Array<
		Exclude<ExtensionDirRead, { state: "absent" }>
	>;
}
