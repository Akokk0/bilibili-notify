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
 * copyFile / cp / createWriteStream / truncate(及 Sync 版),外加带写标志(`w` / `a` / `+`)
 * 的 open。
 *
 * 不管 mkdir / rm / unlink / rmdir / link / symlink:它们只动名字,留不下写了一半的内容;
 * 「关停返回以后数据目录不再变化」是守卫 8 的事。
 *
 * 判据写成纯函数 + 样例,因为判据本身也会写错:一条永远判 OK 的规则跟没有一样。
 */

import { describe, expect, it } from "vite-plus/test";
import {
	findNodes,
	listSources,
	parseSource,
	type Source,
	ts,
} from "../../../../scripts/source-scan.mjs";

const WRITE_APIS = new Set(
	["writeFile", "appendFile", "rename", "copyFile", "cp", "createWriteStream", "truncate"].flatMap(
		(name) => [name, `${name}Sync`],
	),
);
const OPEN_APIS = new Set(["open", "openSync"]);
const OPEN_WRITE_FLAGS = new Set(["O_WRONLY", "O_RDWR", "O_APPEND", "O_CREAT", "O_TRUNC"]);

const FS_MODULE = /^(?:node:)?fs(?:\/promises)?$/;

/** 子树里有没有满足 `match` 的节点(含自己)。 */
function someNode(node: ts.Node, match: (node: ts.Node) => boolean): boolean {
	return (
		match(node) || ts.forEachChild(node, (child) => someNode(child, match) || undefined) === true
	);
}

/** open 的参数里有没有写标志:字符串标志含 w / a / +,或者用了写方向的 O_ 常量。 */
function opensForWriting(args: readonly ts.Expression[]): boolean {
	return args.some((arg) =>
		someNode(arg, (node) => {
			if (ts.isStringLiteralLike(node)) {
				return /^[rwaxs+]{1,3}$/.test(node.text) && /[wa+]/.test(node.text);
			}
			return ts.isIdentifier(node) && OPEN_WRITE_FLAGS.has(node.text);
		}),
	);
}

/** 一份源码直接写盘的地方(按写入口去重、排好序);没有就是空数组。 */
export function directDiskWrites(source: Source): string[] {
	const found = new Set<string>();
	const openAliases = new Set<string>();
	const namespaces = new Set<string>();

	// 先看 import:从 fs 模块拿到了什么名字。`import type` 与逐项 `type` 不带值,不算。
	for (const statement of source.ast.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
			continue;
		}
		if (!FS_MODULE.test(statement.moduleSpecifier.text)) continue;
		const clause = statement.importClause;
		if (!clause || clause.phaseModifier === ts.SyntaxKind.TypeKeyword) continue;
		if (clause.name) namespaces.add(clause.name.text);
		const bindings = clause.namedBindings;
		if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
		if (bindings && ts.isNamedImports(bindings)) {
			for (const element of bindings.elements) {
				if (element.isTypeOnly) continue;
				const imported = (element.propertyName ?? element.name).text;
				const local = element.name.text;
				if (WRITE_APIS.has(imported)) found.add(imported);
				else if (OPEN_APIS.has(imported)) openAliases.add(local);
				else if (imported === "promises") namespaces.add(local);
			}
		}
	}

	// 再看调用:拿到的写入口是不是被调了,open 是不是带写标志。
	for (const { node } of findNodes(source, ts.isCallExpression)) {
		const call = node as ts.CallExpression;
		const callee = call.expression;
		if (ts.isIdentifier(callee)) {
			if (openAliases.has(callee.text) && opensForWriting(call.arguments)) found.add("open");
			continue;
		}
		if (!ts.isPropertyAccessExpression(callee)) continue;
		// `ns.api(…)` 与 `ns.promises.api(…)`
		let owner = callee.expression;
		if (ts.isPropertyAccessExpression(owner) && owner.name.text === "promises") {
			owner = owner.expression;
		}
		if (!ts.isIdentifier(owner) || !namespaces.has(owner.text)) continue;
		const api = callee.name.text;
		if (WRITE_APIS.has(api)) found.add(api);
		else if (OPEN_APIS.has(api) && opensForWriting(call.arguments)) found.add("open");
	}

	return [...found].sort();
}

/** 把一段样例当成一份 `.ts` 源码喂给判据。 */
const writesIn = (text: string) => directDiskWrites(parseSource("sample.ts", text));

describe("守卫 3:服务端只经持久化底层写盘", () => {
	it("认法:从 fs 拿了写入口就点名,自家同名方法与只读、删除不算", () => {
		expect(writesIn(`import { readFile, mkdir, rm, unlink } from "node:fs/promises";`)).toEqual([]);
		expect(
			writesIn(`import {\n\treadFile,\n\twriteFile,\n\trename,\n} from "node:fs/promises";`),
		).toEqual(["rename", "writeFile"]);
		expect(writesIn(`import { renameSync as mv, existsSync } from "node:fs";`)).toEqual([
			"renameSync",
		]);
		expect(writesIn(`import { createWriteStream } from "fs";`)).toEqual(["createWriteStream"]);
		expect(writesIn(`import type { WriteStream } from "node:fs";`)).toEqual([]);
		// 类型导入拿不到值:语法上写得出来、运行时不存在,判据不能被它骗过去。
		expect(
			writesIn(`import type { writeFile } from "node:fs/promises";\nwriteFile(p, x);`),
		).toEqual([]);
		expect(
			writesIn(`import { type rename, readFile } from "node:fs/promises";\nrename(a, b);`),
		).toEqual([]);
		expect(writesIn(`import type * as fs from "node:fs";\nfs.writeFileSync(p, x);`)).toEqual([]);
		expect(writesIn(`import { link, symlink } from "node:fs/promises";`)).toEqual([]);
		// 只认 fs:别的模块里同名的函数不归这条管。
		expect(writesIn(`import { writeFile } from "some-lib";\nwriteFile(p, x);`)).toEqual([]);
		expect(writesIn(`import path from "node:path";\npath.rename(a, b);`)).toEqual([]);
		expect(
			writesIn(
				`import { readFile } from "node:fs/promises";\nawait store.rename(id, name);\nsink.write(x);`,
			),
		).toEqual([]);
	});

	it("认法:命名空间、默认导入与 promises 别名照样点名", () => {
		expect(writesIn(`import * as fs from "node:fs";\nfs.writeFileSync(p, "x");`)).toEqual([
			"writeFileSync",
		]);
		expect(writesIn(`import fs from "node:fs";\nawait fs.promises.appendFile(p, "x");`)).toEqual([
			"appendFile",
		]);
		expect(writesIn(`import { promises as fsp } from "node:fs";\nawait fsp.rename(a, b);`)).toEqual(
			["rename"],
		);
		expect(writesIn(`import * as fs from "node:fs";\nfs.readFileSync(p);`)).toEqual([]);
	});

	it("认法:open 只在带写标志时算写盘", () => {
		expect(
			writesIn(
				`import { open } from "node:fs/promises";\nconst h = await open(join(dir, name), "w");`,
			),
		).toEqual(["open"]);
		expect(
			writesIn(`import { open } from "node:fs/promises";\nconst h = await open(dir, "r");`),
		).toEqual([]);
		expect(
			writesIn(
				`import { openSync, constants } from "node:fs";\nopenSync(p, constants.O_WRONLY | constants.O_CREAT);`,
			),
		).toEqual(["open"]);
	});

	it("认法:注释、字符串与模板里的写法不算", () => {
		expect(
			writesIn(
				`import * as fs from "node:fs";\n// 以前是 fs.writeFileSync(p, x)\n/* fs.renameSync(a, b) */\nfs.statSync(p);`,
			),
		).toEqual([]);
		expect(
			writesIn(
				[
					`import * as fs from "node:fs";`,
					`const hint = "别写 fs.writeFileSync(p, x)";`,
					`const doc = \`fs.renameSync(a, b) // \${fs.statSync(p).size}\`;`,
				].join("\n"),
			),
		).toEqual([]);
	});

	it("服务端源码没有直接写盘的", () => {
		const files = listSources(["apps/server/src"]);
		// 一份都没扫到 = 这条守卫在空转,那比没有还糟。
		expect(files.length).toBeGreaterThan(0);
		const offenders: Record<string, string[]> = {};
		for (const path of files) {
			const writes = directDiskWrites(parseSource(path));
			if (writes.length > 0) offenders[path] = writes;
		}
		expect(offenders).toEqual({});
	});
});
