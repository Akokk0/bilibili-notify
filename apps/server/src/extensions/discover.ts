import type { Dirent } from "node:fs";
import { access, readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
	EXTENSION_API_VERSION,
	type ExtensionManifest,
	ExtensionManifestSchema,
} from "@bilibili-notify/internal";

/**
 * 拓展装在 `<dataDir>/extensions/`。
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

/**
 * 看完一个拓展目录之后的结论 —— **在 import 任何一行拓展代码之前**就能得出。
 *
 * `id` 一律取**目录名**,不取清单里那一格:装载目录是 `<dataDir>/extensions/<id>/`、
 * 挂载点是 `/ext/<id>/*`,两处都按目录算。而且清单读不出来的时候(最容易炸的正是这一步)
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
	| { state: "ready"; id: string; dir: string; manifest: ExtensionManifest };

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * 读一个拓展目录的清单,并在**执行之前**把能判的都判了。
 *
 * 判的顺序是有讲究的:先「这份清单本身立得住吗」,再「它是给谁写的」。反过来的话,一份
 * 为将来宿主写的清单会被我们按今天的规矩挑出一堆毛病,而真正的原因只有一条 —— 版本不合。
 */
export async function readExtensionDir(
	dir: string,
	hostApiVersion: number = EXTENSION_API_VERSION,
): Promise<ExtensionDirRead> {
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
	const manifest = parsed.data;

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

	if (!(await exists(join(dir, EXTENSION_ENTRY_FILE)))) {
		return { state: "unreadable", id, dir, detail: `少了入口文件 ${EXTENSION_ENTRY_FILE}` };
	}

	return { state: "ready", id, dir, manifest };
}

/**
 * 扫一遍装载根目录(`<dataDir>/extensions/`),把每个子目录读成一条记录。
 *
 * 两条路装进来的拓展都落在这里(ADR-0012 决策 16):面板装的、主人自己手放的 —— 扫目录
 * 这一步对两者一视同仁,所以「手放」几乎是白送的。
 *
 * **没有清单的子目录不进表**:那不是拓展,不该在面板上占一行。而清单坏了的要进表 ——
 * 消失的东西没法排查。根目录不存在时回空表:头一次开机本来就没有它。
 */
export async function discoverExtensions(
	root: string,
	hostApiVersion: number = EXTENSION_API_VERSION,
): Promise<Array<Exclude<ExtensionDirRead, { state: "absent" }>>> {
	let entries: Dirent[];
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return [];
	}

	const dirs = entries
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		// 按名字排:`readdir` 的顺序随文件系统走,不排的话面板列表每次开机都可能换个次序。
		.sort((a, b) => a.localeCompare(b));

	const read = await Promise.all(
		dirs.map((name) => readExtensionDir(join(root, name), hostApiVersion)),
	);
	return read.filter((entry) => entry.state !== "absent") as Array<
		Exclude<ExtensionDirRead, { state: "absent" }>
	>;
}
