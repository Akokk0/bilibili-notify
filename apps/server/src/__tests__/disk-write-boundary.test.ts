/**
 * 守卫 3:服务端除了持久化底层(`@bilibili-notify/storage`)不许直接写文件。
 *
 * 写了一半的文件是静默的:进程在 `writeFile` 中途被杀,下次开机读到半截 JSON,而类型、测试、
 * 构建全绿。底层(原子写、追加 JSONL、整目录替换)把临时名、fsync、失败清理与开机清扫收在一处,
 * 各处自己写盘就各起各的临时名、各漏各的 fsync。
 *
 * 判据看 import,不看调用名:一个文件从 fs 模块拿了写入口(具名、改名、命名空间、默认导入、
 * `promises as`),或者经命名空间调了写入口,就点名。按调用名扫会把 `store.rename(…)`、
 * `avatarStore.write(…)` 这类自家方法当成写盘。写入口 = writeFile / appendFile / rename /
 * copyFile / cp / createWriteStream / truncate / link / symlink(及 Sync 版),外加带写标志
 * (`w` / `a` / `+`)的 open。
 *
 * 不管 mkdir / rm / unlink / rmdir:它们留不下写了一半的内容;「关停返回以后数据目录不再变化」
 * 是守卫 8 的事。
 *
 * 判据写成纯函数 + 样例,因为判据本身也会写错:一条永远判 OK 的规则跟没有一样。
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const SERVER_SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const WRITE_APIS = new Set(
	[
		"writeFile",
		"appendFile",
		"rename",
		"copyFile",
		"cp",
		"createWriteStream",
		"truncate",
		"link",
		"symlink",
	].flatMap((name) => [name, `${name}Sync`]),
);
const OPEN_APIS = new Set(["open", "openSync"]);

const FS_MODULE = String.raw`["'](?:node:)?fs(?:\/promises)?["']`;

/**
 * 切片 ② 迁移中还没迁完的文件。每迁完一个就删掉那一行;名单里的文件已经不再直接写盘时这里也红,
 * 逼着把行删掉。切片 ② 收尾时名单为空。
 */
const PENDING_MIGRATION = new Set<string>([
	"ai/conversation-store.ts",
	"card-skins/store.ts",
	"devtools/scenarios/extensions.ts",
	"extensions/install.ts",
	"fans/store.ts",
	"history/repush-store.ts",
	"history/store.ts",
	"logs/store.ts",
	"maid-skills/store.ts",
	"runtime/card-assets.ts",
	"runtime/chat-assets.ts",
	"runtime/engines.ts",
	"runtime/font-assets.ts",
	"runtime/roast-draft-store.ts",
	"runtime/sub-avatar-store.ts",
	"runtime/sub-runtime-store.ts",
	"skins/store.ts",
	"stats/migrate-file-keys.ts",
	"stats/store.ts",
	"update/durable-json.ts",
	"update/install-payload.ts",
]);

/** 去掉注释:守卫只认代码,注释里写 `fs.writeFile(` 不算。 */
function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** 从 `(` 起取到配对的 `)` 为止的参数原文。 */
function callArgs(source: string, openParen: number): string {
	let depth = 0;
	for (let i = openParen; i < source.length; i++) {
		const ch = source[i];
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) return source.slice(openParen + 1, i);
		}
	}
	return source.slice(openParen + 1);
}

/** open 的参数里有没有写标志:字符串标志含 w / a / +,或者用了写方向的 O_ 常量。 */
function opensForWriting(args: string): boolean {
	for (const match of args.matchAll(/["']([rwaxs+]{1,3})["']/g)) {
		if (/[wa+]/.test(match[1] ?? "")) return true;
	}
	return /\bO_(?:WRONLY|RDWR|APPEND|CREAT|TRUNC)\b/.test(args);
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 一份源码直接写盘的地方(按写入口去重、排好序);没有就是空数组。 */
export function directDiskWrites(source: string): string[] {
	const code = stripComments(source);
	const found = new Set<string>();
	const openAliases: string[] = [];
	const namespaces: string[] = [];

	for (const match of code.matchAll(
		new RegExp(String.raw`import\s+(type\s+)?([^;]*?)\s+from\s*${FS_MODULE}`, "g"),
	)) {
		if (match[1]) continue;
		const clause = match[2] ?? "";
		const named = clause.match(/\{([^}]*)\}/);
		const outside = clause.replace(/\{[^}]*\}/, "");
		const ns = outside.match(/\*\s*as\s+([A-Za-z_$][\w$]*)/);
		if (ns?.[1]) namespaces.push(ns[1]);
		const def = outside.match(/^\s*([A-Za-z_$][\w$]*)/);
		if (def?.[1]) namespaces.push(def[1]);
		for (const part of (named?.[1] ?? "").split(",")) {
			const spec = part.trim();
			if (!spec || spec.startsWith("type ")) continue;
			const [imported = "", local = imported] = spec.split(/\s+as\s+/).map((s) => s.trim());
			if (WRITE_APIS.has(imported)) found.add(imported);
			else if (OPEN_APIS.has(imported)) openAliases.push(local);
			else if (imported === "promises") namespaces.push(local);
		}
	}

	for (const alias of openAliases) {
		for (const call of code.matchAll(
			new RegExp(String.raw`(?<![\w$.])${escapeRegExp(alias)}\s*\(`, "g"),
		)) {
			if (opensForWriting(callArgs(code, (call.index ?? 0) + call[0].length - 1)))
				found.add("open");
		}
	}

	for (const ns of namespaces) {
		const member = new RegExp(
			String.raw`(?<![\w$.])${escapeRegExp(ns)}\s*\.\s*(?:promises\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\(`,
			"g",
		);
		for (const call of code.matchAll(member)) {
			const api = call[1] ?? "";
			if (WRITE_APIS.has(api)) found.add(api);
			else if (
				OPEN_APIS.has(api) &&
				opensForWriting(callArgs(code, (call.index ?? 0) + call[0].length - 1))
			) {
				found.add("open");
			}
		}
	}

	return [...found].sort();
}

async function serverSourceFiles(): Promise<string[]> {
	const entries = await readdir(SERVER_SRC, { recursive: true });
	return entries
		.map((entry) => entry.split(sep).join("/"))
		.filter(
			(path) =>
				path.endsWith(".ts") &&
				!path.split("/").includes("__tests__") &&
				!path.endsWith(".test.ts"),
		)
		.sort();
}

describe("守卫 3:服务端只经持久化底层写盘", () => {
	it("认法:从 fs 拿了写入口就点名,自家同名方法与只读、删除不算", () => {
		expect(
			directDiskWrites(`import { readFile, mkdir, rm, unlink } from "node:fs/promises";`),
		).toEqual([]);
		expect(
			directDiskWrites(
				`import {\n\treadFile,\n\twriteFile,\n\trename,\n} from "node:fs/promises";`,
			),
		).toEqual(["rename", "writeFile"]);
		expect(directDiskWrites(`import { renameSync as mv, existsSync } from "node:fs";`)).toEqual([
			"renameSync",
		]);
		expect(directDiskWrites(`import { createWriteStream } from "fs";`)).toEqual([
			"createWriteStream",
		]);
		expect(directDiskWrites(`import type { WriteStream } from "node:fs";`)).toEqual([]);
		expect(
			directDiskWrites(
				`import { readFile } from "node:fs/promises";\nawait store.rename(id, name);\nsink.write(x);`,
			),
		).toEqual([]);
	});

	it("认法:命名空间、默认导入与 promises 别名照样点名", () => {
		expect(directDiskWrites(`import * as fs from "node:fs";\nfs.writeFileSync(p, "x");`)).toEqual([
			"writeFileSync",
		]);
		expect(
			directDiskWrites(`import fs from "node:fs";\nawait fs.promises.appendFile(p, "x");`),
		).toEqual(["appendFile"]);
		expect(
			directDiskWrites(`import { promises as fsp } from "node:fs";\nawait fsp.rename(a, b);`),
		).toEqual(["rename"]);
		expect(directDiskWrites(`import * as fs from "node:fs";\nfs.readFileSync(p);`)).toEqual([]);
	});

	it("认法:open 只在带写标志时算写盘", () => {
		expect(
			directDiskWrites(
				`import { open } from "node:fs/promises";\nconst h = await open(join(dir, name), "w");`,
			),
		).toEqual(["open"]);
		expect(
			directDiskWrites(`import { open } from "node:fs/promises";\nconst h = await open(dir, "r");`),
		).toEqual([]);
		expect(
			directDiskWrites(
				`import { openSync, constants } from "node:fs";\nopenSync(p, constants.O_WRONLY | constants.O_CREAT);`,
			),
		).toEqual(["open"]);
	});

	it("认法:注释里的写法不算", () => {
		expect(
			directDiskWrites(
				`import * as fs from "node:fs";\n// 以前是 fs.writeFileSync(p, x)\n/* fs.renameSync(a, b) */\nfs.statSync(p);`,
			),
		).toEqual([]);
	});

	it("服务端源码除了待迁名单,没有直接写盘的", async () => {
		const offenders: Record<string, string[]> = {};
		const stillPending: string[] = [];
		for (const path of await serverSourceFiles()) {
			const writes = directDiskWrites(await readFile(join(SERVER_SRC, path), "utf8"));
			if (PENDING_MIGRATION.has(path)) {
				if (writes.length > 0) stillPending.push(path);
			} else if (writes.length > 0) {
				offenders[path] = writes;
			}
		}
		expect(offenders).toEqual({});
		// 名单里已经迁完的行要删掉,名单只减不增。
		expect(stillPending.sort()).toEqual([...PENDING_MIGRATION].sort());
	});
});
