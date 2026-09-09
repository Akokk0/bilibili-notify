import type { Dirent } from "node:fs";
import { access, readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	EXTENSION_API_VERSION,
	type ExtensionManifest,
	ExtensionManifestSchema,
} from "@bilibili-notify/internal";
import { safeExtensionIcon } from "./manifest-icon.js";

/**
 * 拓展从哪个根扫出来的 —— 两个根的优先级就是这两格的先后。
 *
 * ⛔ **没有「载荷自带」那一档**(主人 2026-09-09 拍板推翻 ADR-0012 决策 34):本体一个拓展
 * 都不带,拓展只有下载与手放两条来路。删掉那个根不只是省一次 `readdir` —— 留着它,下一个
 * 人看见的是「拓展可以随载荷走」,而那正是被否掉的做法。
 *
 * 分开这两个的不只是路径,还有**入口长什么样**(源码那份是 `src/index.ts`)与**谁负责换掉
 * 它**(源码那份跟着仓库走,`<dataDir>` 那份归主人)。
 */
export type ExtensionRootKind =
	/** 仓里的 `extensions/` —— **只在源码运行时存在**,构建产物里这条路结构上没有。 */
	| "source"
	/** `<dataDir>/extensions/` —— 面板装的、主人手放的。 */
	| "data";

export interface ExtensionRoot {
	kind: ExtensionRootKind;
	dir: string;
}

/** 说人话的根名字 —— 「被谁盖住了」那句警告要印得出来。 */
export const EXTENSION_ROOT_LABEL: Record<ExtensionRootKind, string> = {
	source: "仓里源码",
	data: "主人装的",
};

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
export const EXTENSION_ENTRY_FILE = "index.mjs";
/** 源码根那份的入口 —— dev 下直接跑 TypeScript(决策 35)。 */
export const EXTENSION_SOURCE_ENTRY_FILE = join("src", "index.ts");

/**
 * 这个根里的拓展,入口该是哪个文件。
 *
 * ⛔ **清单里没有 `entry` 字段,以后也不加**:清单会进签名摘要,加一格 `entry` 等于让
 * 分发出去的拓展指定加载哪个文件。入口固定,**宿主自己判**。
 */
export function extensionEntryFileFor(kind: ExtensionRootKind): string {
	return kind === "source" ? EXTENSION_SOURCE_ENTRY_FILE : EXTENSION_ENTRY_FILE;
}

/**
 * 算出这次开机要扫的根,**已按优先级排好**(先命中先用)。
 *
 * 构建产物里就只有 `<dataDir>/extensions/` 一个根 —— 拓展是主人下载或手放进去的,
 * 本体不带。源码运行时**多一个仓里的根**并排在最前(决策 35),这是我们自己开发拓展的路:
 * 改一行 `tsx watch` 就重启,不必打包、也不必往哪儿拷。
 */
export function extensionRootsFor(input: {
	dataDir: string;
	/** 当前这份载荷的入口(`import.meta.url`)。 */
	bundleUrl: string;
}): readonly ExtensionRoot[] {
	const entryDir = dirname(fileURLToPath(input.bundleUrl));
	// 跑的是 TypeScript 源码 —— 与 devtools 那道门同一个判据(见 `devtools/index.ts`),
	// 只是那边刻意读 `import.meta.url` 本身:它是道安全门,不能被选项掀开。
	const sourceRun = input.bundleUrl.endsWith(".ts");
	const roots: ExtensionRoot[] = [];
	// <repo>/apps/server/src/index.ts → <repo>/extensions
	if (sourceRun)
		roots.push({ kind: "source", dir: resolve(entryDir, "..", "..", "..", "extensions") });
	roots.push({ kind: "data", dir: extensionsRootIn(input.dataDir) });
	return roots;
}

/**
 * 看完一个拓展目录之后的结论 —— **在 import 任何一行拓展代码之前**就能得出。
 *
 * `id` 一律取**目录名**,不取清单里那一格:装载目录是 `<根>/<id>/`、挂载点是
 * `/ext/<id>/*`,两处都按目录算。而且清单读不出来的时候(最容易炸的正是这一步)
 * 目录名是唯一还拿得到的身份 —— 失败记账要有个键。
 */
export type ExtensionDirRead =
	/** 目录里根本没有清单 —— 不是拓展目录。不记账、不报错,跳过。 */
	| { state: "absent"; id: string; dir: string; origin: ExtensionRootKind }
	/** 有清单但用不了。**要列出来**:消失的东西没法排查。 */
	| { state: "unreadable"; id: string; dir: string; origin: ExtensionRootKind; detail: string }
	/** 清单没问题,但它是给别的宿主版本写的。列出来、说清楚,不加载。 */
	| {
			state: "incompatible";
			id: string;
			dir: string;
			origin: ExtensionRootKind;
			manifest: ExtensionManifest;
			requires: number;
			host: number;
	  }
	/** 可以加载了 —— 真加不加载还要看开关(`globals.extensions.<id>.enabled`)。 */
	| {
			state: "ready";
			id: string;
			dir: string;
			origin: ExtensionRootKind;
			manifest: ExtensionManifest;
			/** 要 import 的那个文件,绝对路径。哪个根就是哪种入口。 */
			entry: string;
	  };

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

export interface ReadExtensionDirOptions {
	/** 这个目录属于哪个根 —— 决定入口认哪个文件。默认按 `<dataDir>` 那份算。 */
	kind?: ExtensionRootKind;
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
	const origin = options.kind ?? "data";
	const hostApiVersion = options.hostApiVersion ?? EXTENSION_API_VERSION;
	const id = basename(dir);
	let text: string;
	try {
		text = await readFile(join(dir, EXTENSION_MANIFEST_FILE), "utf8");
	} catch {
		return { state: "absent", id, dir, origin };
	}

	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		return {
			state: "unreadable",
			id,
			dir,
			origin,
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
			origin,
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
			origin,
			detail: `清单里的 id 是 ${manifest.id},与目录名 ${id} 对不上`,
		};
	}

	// 只比主版本:契约加一格不该判死已经装好的拓展,改一格的语义则必须把旧拓展停在门外。
	if (manifest.apiVersion !== hostApiVersion) {
		return {
			state: "incompatible",
			id,
			dir,
			origin,
			manifest,
			requires: manifest.apiVersion,
			host: hostApiVersion,
		};
	}

	const entryFile = extensionEntryFileFor(origin);
	const entry = join(dir, entryFile);
	if (!(await exists(entry))) {
		return { state: "unreadable", id, dir, origin, detail: `少了入口文件 ${entryFile}` };
	}

	return { state: "ready", id, dir, origin, manifest, entry };
}

/** 一个根里的拓展被更高优先级的那份盖住了。 */
export interface ShadowedExtension {
	id: string;
	/** 真正会跑的那份。 */
	winner: ExtensionRoot;
	/** 被盖住、这次不会跑的那份。 */
	shadowed: ExtensionRoot;
}

export interface DiscoverExtensionsOptions {
	hostApiVersion?: number;
	/**
	 * 有 id 被盖住了。
	 *
	 * 🔴 **必须让它出声**:悄悄盖掉正是「我明明改了怎么没生效」最难查的原因 —— 盘上有
	 * 两份、面板上只有一行,不说的话没有任何办法判断跑的是哪个。
	 */
	onShadowed?: (shadow: ShadowedExtension) => void;
}

async function readRoot(root: ExtensionRoot, hostApiVersion: number): Promise<ExtensionDirRead[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(root.dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
	return Promise.all(
		dirs.map((name) => readExtensionDir(join(root.dir, name), { kind: root.kind, hostApiVersion })),
	);
}

/**
 * 扫一遍所有拓展根,把每个子目录读成一条记录。
 *
 * `roots` **已按优先级排好**(高的在前),同一个 id 出现多次时**先命中先用**、后面的
 * 那份走 `onShadowed`。判据只看 id 与目录在不在,**不看它好不好** —— 高优先级那份坏了
 * 就该报它坏了,悄悄退回下一份只会让「我改的那个到底跑没跑」更难查。
 *
 * 两条路装进来的拓展都落在这里(ADR-0012 决策 16):面板装的、主人自己手放的 —— 扫目录
 * 这一步对两者一视同仁,所以「手放」几乎是白送的。
 *
 * **没有清单的子目录不进表**:那不是拓展,不该在面板上占一行,更不该算「盖住了谁」。
 * 而清单坏了的要进表 —— 消失的东西没法排查。根目录不存在时当空:头一次开机本来就没有它。
 */
export async function discoverExtensions(
	roots: readonly ExtensionRoot[],
	options: DiscoverExtensionsOptions = {},
): Promise<Array<Exclude<ExtensionDirRead, { state: "absent" }>>> {
	const hostApiVersion = options.hostApiVersion ?? EXTENSION_API_VERSION;
	const perRoot = await Promise.all(roots.map((root) => readRoot(root, hostApiVersion)));

	const winners = new Map<string, { read: ExtensionDirRead; root: ExtensionRoot }>();
	for (const [index, reads] of perRoot.entries()) {
		const root = roots[index];
		if (!root) continue;
		for (const read of reads) {
			if (read.state === "absent") continue;
			const claimed = winners.get(read.id);
			if (claimed) {
				options.onShadowed?.({
					id: read.id,
					winner: { kind: claimed.root.kind, dir: claimed.read.dir },
					shadowed: { kind: root.kind, dir: read.dir },
				});
				continue;
			}
			winners.set(read.id, { read, root });
		}
	}

	// 按名字排:`readdir` 的顺序随文件系统走,不排的话面板列表每次开机都可能换个次序。
	return [...winners.values()]
		.map((entry) => entry.read as Exclude<ExtensionDirRead, { state: "absent" }>)
		.sort((a, b) => a.id.localeCompare(b.id));
}
