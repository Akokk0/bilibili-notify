import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { findNodes, importsOf, listSources, parseSource } from "../source-scan.mjs";

/**
 * 扫源码守卫的共用工具:遍历、解析、抠 import、按节点找。
 *
 * 各道守卫原先各抄一份「剥注释 + 正则」,注释、字符串、模板里的 `import(` / `fetch(` 各自认错。
 * 这里一律走 TypeScript 语法树,字符串和注释里的字样天生不是节点。
 * 判据本身也会写错,所以这条测试先钉工具自己认得对不对。
 */

const at = (path, text) => parseSource(path, text);
const refs = (text, path = "a.ts") => importsOf(at(path, text));
const specifiers = (text, path) => refs(text, path).map((r) => r.specifier);

describe("importsOf:注释和字符串里的字样不算", () => {
	it("注释、字符串、模板里的 import( / require( / from 都不是引用", () => {
		expect(
			refs(
				[
					`// import("a") 与 require("b") 以前这么写`,
					`/* import x from "c"; export * from "d" */`,
					`const s = 'import("e")';`,
					`const t = "from \\"f\\"";`,
					`const u = \`require('g') \${1}\`;`,
					`const r = /import\\("h"\\)/;`,
					`/** @example import("i") */`,
					`export const ok = 1;`,
				].join("\n"),
			),
		).toEqual([]);
	});

	it("字符串里的 // 不会把后面的真 import 吃掉", () => {
		expect(specifiers(`const url = "https://x.test/a";\nimport("./real");`)).toEqual(["./real"]);
	});
});

describe("importsOf:各种写法与 kind", () => {
	it("import 声明:默认、命名空间、具名都是 import;副作用导入单独一种", () => {
		expect(
			refs(
				[
					`import a from "one";`,
					`import * as b from "two";`,
					`import { c } from "three";`,
					`import "four";`,
				].join("\n"),
			),
		).toEqual([
			{ specifier: "one", typeOnly: false, kind: "import", line: 1 },
			{ specifier: "two", typeOnly: false, kind: "import", line: 2 },
			{ specifier: "three", typeOnly: false, kind: "import", line: 3 },
			{ specifier: "four", typeOnly: false, kind: "side-effect", line: 4 },
		]);
	});

	it("export … from:多行具名列表、export *、export * as、export type", () => {
		expect(
			refs(
				[
					`export {`,
					`\ta,`,
					`\tb as c,`,
					`} from "./multi";`,
					`export * from "./star";`,
					`export * as ns from "./ns";`,
					`export type { T } from "./t";`,
					`export { type U } from "./u";`,
					`export { v, type W } from "./vw";`,
					`export const local = 1;`,
					`export { local as alias };`,
				].join("\n"),
			),
		).toEqual([
			{ specifier: "./multi", typeOnly: false, kind: "export", line: 1 },
			{ specifier: "./star", typeOnly: false, kind: "export", line: 5 },
			{ specifier: "./ns", typeOnly: false, kind: "export", line: 6 },
			{ specifier: "./t", typeOnly: true, kind: "export", line: 7 },
			{ specifier: "./u", typeOnly: true, kind: "export", line: 8 },
			{ specifier: "./vw", typeOnly: false, kind: "export", line: 9 },
		]);
	});

	it("import type 与逐项 type:整句或每一项都带 type 才算 typeOnly", () => {
		const typeOnly = (text) => refs(text)[0]?.typeOnly;
		expect(typeOnly(`import type { A } from "x";`)).toBe(true);
		expect(typeOnly(`import type A from "x";`)).toBe(true);
		expect(typeOnly(`import type * as A from "x";`)).toBe(true);
		expect(typeOnly(`import { type A, type B } from "x";`)).toBe(true);
		expect(typeOnly(`import {\n\ttype A,\n\ttype B,\n} from "x";`)).toBe(true);
		// 有一项不带 type,编译后就留下一条真 import。
		expect(typeOnly(`import { type A, b } from "x";`)).toBe(false);
		expect(typeOnly(`import { a } from "x";`)).toBe(false);
		// 默认导入是值;`{}` 空列表不含任何 type 项,也不算。
		expect(typeOnly(`import d, { type A } from "x";`)).toBe(false);
		expect(typeOnly(`import * as ns from "x";`)).toBe(false);
		expect(typeOnly(`import {} from "x";`)).toBe(false);
	});

	it("动态 import:只认字面量参数,非字面量的忽略", () => {
		expect(
			refs(
				[
					`const a = await import("./a");`,
					"const b = await import(`./b`);",
					`const c = await import(name);`,
					`const d = await import(\`./d/\${x}\`);`,
					`export const lazy = () => import('./lazy');`,
				].join("\n"),
			),
		).toEqual([
			{ specifier: "./a", typeOnly: false, kind: "dynamic", line: 1 },
			{ specifier: "./b", typeOnly: false, kind: "dynamic", line: 2 },
			{ specifier: "./lazy", typeOnly: false, kind: "dynamic", line: 5 },
		]);
	});

	it('类型位置的 import("x") 也是引用,且是纯类型', () => {
		expect(refs(`type T = import("@bilibili-notify/internal").GlobalConfig;`)).toEqual([
			{ specifier: "@bilibili-notify/internal", typeOnly: true, kind: "dynamic", line: 1 },
		]);
	});

	it('require("x") 与 import x = require("x")', () => {
		expect(
			refs(
				[
					`const a = require("./a");`,
					`import b = require("./b");`,
					`import type c = require("./c");`,
					`const d = require(name);`,
					`const e = obj.require("./not-a-require");`,
					`const f = require.resolve("./resolve-is-not-a-load");`,
				].join("\n"),
			),
		).toEqual([
			{ specifier: "./a", typeOnly: false, kind: "require", line: 1 },
			{ specifier: "./b", typeOnly: false, kind: "require", line: 2 },
			{ specifier: "./c", typeOnly: true, kind: "require", line: 3 },
		]);
	});

	it("declare module 块、类型标注里的字样不算引用", () => {
		expect(
			specifiers(
				[
					`declare module "augment" {`,
					`\tinterface Foo { bar: string }`,
					`}`,
					`const x: "from" = "from";`,
				].join("\n"),
			),
		).toEqual([]);
	});
});

describe("解析:扩展名决定 ScriptKind", () => {
	it("TSX:JSX 里的引用照样抠得出来", () => {
		const text = [
			`import { Foo } from "./foo";`,
			`export const View = () => (`,
			`\t<Foo<string> render={() => import("./lazy")} label="import('nope')">`,
			`\t\t{/* import("commented") */}`,
			`\t</Foo>`,
			`);`,
		].join("\n");
		// 真按 TSX 解析:JSX 元素是节点(按 TS 解析它会碎成类型断言与比较)。
		expect(findNodes(at("view.tsx", text), ts.isJsxElement)).toHaveLength(1);
		expect(refs(text, "view.tsx")).toEqual([
			{ specifier: "./foo", typeOnly: false, kind: "import", line: 1 },
			{ specifier: "./lazy", typeOnly: false, kind: "dynamic", line: 3 },
		]);
	});

	it(".mts 与 .mjs 也能解析", () => {
		expect(specifiers(`import type { A } from "./a.js";`, "x.mts")).toEqual(["./a.js"]);
		expect(specifiers(`import fs from "node:fs";\nexport { fs };`, "x.mjs")).toEqual(["node:fs"]);
	});

	it("Source 带回路径、原文和语法树", () => {
		const source = at("some/file.ts", "export const a = 1;");
		expect(source.path).toBe("some/file.ts");
		expect(source.text).toBe("export const a = 1;");
		expect(source.ast.statements).toHaveLength(1);
		// 父指针在:findNodes / 守卫要往上爬。
		expect(source.ast.statements[0]?.parent).toBe(source.ast);
	});
});

describe("行号", () => {
	it("前面有块注释、空行、多行语句时行号仍对", () => {
		const text = [
			`/**`,
			` * 文件头注释`,
			` * import("commented")`,
			` */`,
			``,
			`import a from "./a";`,
			`// 行注释`,
			`import {`,
			`\tb,`,
			`} from "./b";`,
			``,
			`/* 块注释 */ const x = await import("./c");`,
		].join("\n");
		expect(refs(text).map((r) => [r.specifier, r.line])).toEqual([
			["./a", 6],
			["./b", 8],
			["./c", 12],
		]);
	});

	it("CRLF 换行也数得对", () => {
		expect(refs(`import a from "./a";\r\n\r\nimport b from "./b";\r\n`).map((r) => r.line)).toEqual(
			[1, 3],
		);
	});
});

describe("findNodes", () => {
	const isCallTo = (name) => (node) =>
		ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name;

	it("只找语法树里真有的节点:注释、字符串、模板里的 fetch( 不算", () => {
		const source = at(
			"a.ts",
			[
				`// fetch("http://comment.test")`,
				`/* fetch("http://block.test") */`,
				`const s = 'fetch("http://string.test")';`,
				`const t = \`fetch(\${1})\`;`,
				`await fetch("http://real.test");`,
			].join("\n"),
		);
		const hits = findNodes(source, isCallTo("fetch"));
		expect(hits.map((h) => [h.line, h.text])).toEqual([[5, `fetch("http://real.test")`]]);
	});

	it("line 是节点起点的行号,不含前导注释;text 是节点的第一行", () => {
		const source = at(
			"a.ts",
			[
				`/**`,
				` * 说明`,
				` */`,
				`// 上一行的尾巴`,
				`const r = await fetch(`,
				`\t"http://multi.test",`,
				`\t{ method: "POST" },`,
				`);`,
			].join("\n"),
		);
		const [hit, ...rest] = findNodes(source, isCallTo("fetch"));
		expect(rest).toEqual([]);
		expect(hit?.line).toBe(5);
		expect(hit?.text).toBe("fetch(");
		expect(hit && ts.isCallExpression(hit.node)).toBe(true);
	});

	it("深度优先:嵌套的命中都收,外层在前", () => {
		const source = at("a.ts", `fetch(fetch("inner"));\nfetch("second");`);
		expect(findNodes(source, isCallTo("fetch")).map((h) => [h.line, h.text])).toEqual([
			[1, `fetch(fetch("inner"))`],
			[1, `fetch("inner")`],
			[2, `fetch("second")`],
		]);
	});

	it("没有命中就是空数组;CRLF 的多行节点 text 不带 \\r", () => {
		expect(findNodes(at("a.ts", "const a = 1;"), isCallTo("fetch"))).toEqual([]);
		const [hit] = findNodes(at("a.ts", `fetch(\r\n"x");`), isCallTo("fetch"));
		expect(hit?.text).toBe("fetch(");
	});
});

describe("parseSource:读盘与缓存", () => {
	const dir = mkdtempSync(join(tmpdir(), "bn-source-scan-parse-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("不给 text 时读盘,同一路径缓存,同一进程多道守卫共用", () => {
		const file = join(dir, "x.ts");
		writeFileSync(file, `import a from "./a";\n`);
		const first = parseSource(file);
		expect(first.text).toBe(`import a from "./a";\n`);
		expect(parseSource(file)).toBe(first);
		// 缓存的是解析结果:磁盘上之后再变,同一进程里仍是第一次读到的。
		writeFileSync(file, `import b from "./b";\n`);
		expect(parseSource(file).text).toBe(`import a from "./a";\n`);
	});

	it("给 text 时不读盘也不进缓存(写样例用)", () => {
		const file = join(dir, "never-written.ts");
		const one = parseSource(file, `export const a = 1;`);
		const two = parseSource(file, `export const b = 2;`);
		expect(one).not.toBe(two);
		expect(one.text).toBe(`export const a = 1;`);
		expect(two.text).toBe(`export const b = 2;`);
		// 没进缓存:这个路径在盘上不存在,不给 text 就该读盘失败,而不是拿到样例。
		expect(() => parseSource(file)).toThrow();
	});

	it("相对路径按仓库根解析", () => {
		const source = parseSource("scripts/vite-alias.mjs");
		expect(source.path).toBe("scripts/vite-alias.mjs");
		expect(importsOf(source).map((r) => r.specifier)).toContain("node:path");
	});
});

describe("listSources", () => {
	const root = mkdtempSync(join(tmpdir(), "bn-source-scan-list-"));
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	/** 在临时仓库里造文件(自动建目录)。 */
	function make(...paths) {
		for (const path of paths) {
			const full = join(root, path);
			mkdirSync(dirname(full), { recursive: true });
			writeFileSync(full, "export {};\n");
		}
	}

	make(
		// 收:四种后缀,含深层目录
		"pkg/src/a.ts",
		"pkg/src/deep/er/b.tsx",
		"pkg/src/c.mts",
		"pkg/src/d.mjs",
		// 不收:别的后缀、声明文件
		"pkg/src/e.js",
		"pkg/src/f.json",
		"pkg/src/g.css",
		"pkg/src/types.d.ts",
		"pkg/src/types.d.mts",
		// 不收:依赖 / 本机工作区,不管在第几层
		"pkg/src/node_modules/dep/index.ts",
		"pkg/src/.claude/worktrees/j.ts",
		// 测试:默认不含
		"pkg/src/__tests__/m.ts",
		"pkg/src/deep/__tests__/n.tsx",
		"pkg/src/o.test.ts",
		"pkg/src/p.spec.tsx",
		"pkg/src/q.test.mjs",
		// 第二个根
		"other/src/z.ts",
		"other/src/y.ts",
		// 根之外的不扫
		"unlisted/src/w.ts",
		// 构建产物只认包根下、挨着 package.json 的;src 里恰好同名的是源码
		"built/package.json",
		"built/lib/out.mjs",
		"built/dist/out.mjs",
		"built/coverage/out.mjs",
		"built/src/lib/helper.ts",
		"built/src/dist/names.ts",
		"built/src/deep/lib/x.ts",
		"built/src/node_modules/dep/index.ts",
	);

	it("默认:四种后缀、跳过声明文件与产物目录、不含测试;仓库相对 posix 路径、排好序", () => {
		expect(listSources(["pkg/src"], { root })).toEqual([
			"pkg/src/a.ts",
			"pkg/src/c.mts",
			"pkg/src/d.mjs",
			"pkg/src/deep/er/b.tsx",
		]);
	});

	it("tests: true 才含 __tests__ 目录与 *.test.* / *.spec.* 文件", () => {
		expect(listSources(["pkg/src"], { root, tests: true })).toEqual([
			"pkg/src/__tests__/m.ts",
			"pkg/src/a.ts",
			"pkg/src/c.mts",
			"pkg/src/d.mjs",
			"pkg/src/deep/__tests__/n.tsx",
			"pkg/src/deep/er/b.tsx",
			"pkg/src/o.test.ts",
			"pkg/src/p.spec.tsx",
			"pkg/src/q.test.mjs",
		]);
		expect(listSources(["pkg/src"], { root, tests: false })).toEqual(
			listSources(["pkg/src"], { root }),
		);
	});

	it("多个根合并后整体排序", () => {
		expect(listSources(["pkg/src", "other/src"], { root })).toEqual([
			"other/src/y.ts",
			"other/src/z.ts",
			"pkg/src/a.ts",
			"pkg/src/c.mts",
			"pkg/src/d.mjs",
			"pkg/src/deep/er/b.tsx",
		]);
	});

	it("lib / dist / coverage 只在包根跳过;src 里同名的源码目录照扫,不留盲区", () => {
		expect(listSources(["built"], { root })).toEqual([
			"built/src/deep/lib/x.ts",
			"built/src/dist/names.ts",
			"built/src/lib/helper.ts",
		]);
	});

	it("根不存在就报错,而不是空手而归:守卫扫空了比没有还糟", () => {
		expect(() => listSources(["nope/src"], { root })).toThrow(/nope\/src/);
	});

	it("不给 root 时按仓库根解析:真扫得到本仓的文件,测试默认不含", () => {
		const files = listSources(["scripts"]);
		expect(files).toContain("scripts/source-scan.mjs");
		expect(files).not.toContain("scripts/__tests__/source-scan.test.mjs");
		expect(listSources(["scripts"], { tests: true })).toContain(
			"scripts/__tests__/source-scan.test.mjs",
		);
		expect(files.every((f) => !f.startsWith("/") && !f.includes("\\"))).toBe(true);
	});
});
