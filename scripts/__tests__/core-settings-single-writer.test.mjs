import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { findNodes, parseSource, ts } from "../source-scan.mjs";

/**
 * 形状守卫:核心设置(`config/settings/core.json`)只有一个落盘口。
 *
 * 落盘前要把仍被隔离的坏格盖回盘上原文(`withRawSettings`),这件事只放在 `persistGlobals` 里;
 * 别的方法里再写一次 `atomicWriteJson(this.path("globals"), …)`,就绕过了放回原文,坏格原文会被默认值
 * 悄悄换掉,而类型、构建与大部分测试都是绿的。所以:实参是 `this.path("globals")` 的写盘调用只许出现在
 * `persistGlobals` 的方法体里。按语法树判,注释与字符串里提到不算。
 *
 * 钉的是形状,不是性质:性质(坏格原文不丢)由配置仓的行为测试钉着。集成段的落盘口本来就有两处,不照抄。
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const STORE_FILE = "apps/server/src/config/store.ts";
const WRITERS = new Set(["atomicWriteJson", "atomicWriteFile"]);
const SINGLE_WRITER = "persistGlobals";

/** `this.path("globals")`。 */
function isGlobalsPath(node) {
	return (
		ts.isCallExpression(node) &&
		ts.isPropertyAccessExpression(node.expression) &&
		node.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
		node.expression.name.text === "path" &&
		node.arguments.length === 1 &&
		node.arguments[0] !== undefined &&
		ts.isStringLiteralLike(node.arguments[0]) &&
		node.arguments[0].text === "globals"
	);
}

/** 一处写盘调用:被调的是 `atomicWriteJson` / `atomicWriteFile`,第一个实参是 `this.path("globals")`。 */
function isCoreSettingsWrite(node) {
	if (!ts.isCallExpression(node)) return false;
	if (!ts.isIdentifier(node.expression) || !WRITERS.has(node.expression.text)) return false;
	const first = node.arguments[0];
	return first !== undefined && isGlobalsPath(first);
}

/** 节点所在的最内层类方法名;不在方法里回 `undefined`。 */
function enclosingMethodName(node) {
	for (let cur = node.parent; cur; cur = cur.parent) {
		if (ts.isMethodDeclaration(cur) && ts.isIdentifier(cur.name)) return cur.name.text;
	}
	return undefined;
}

/**
 * 一份源码里写核心设置文件、却不在 `persistGlobals` 里的调用。
 *
 * @returns `{ line, method }[]`,`method` 是所在的方法名(不在方法里是 `undefined`)
 */
export function strayCoreSettingsWrites(source) {
	return findNodes(source, isCoreSettingsWrite)
		.map(({ node, line }) => ({ line, method: enclosingMethodName(node) }))
		.filter((hit) => hit.method !== SINGLE_WRITER);
}

const strays = (text) => strayCoreSettingsWrites(parseSource("sample.ts", text));

describe("落盘口的判据:放行", () => {
	it("persistGlobals 里的那一次", () => {
		expect(
			strays(
				[
					"class S {",
					"\tprivate async persistGlobals() {",
					'\t\tawait atomicWriteJson(this.path("globals"), x);',
					"\t}",
					"}",
				].join("\n"),
			),
		).toEqual([]);
	});

	it("注释与字符串里提到不算", () => {
		expect(
			strays(
				[
					"class S {",
					"\tasync other() {",
					'\t\t// await atomicWriteJson(this.path("globals"), x);',
					"\t\tconst s = 'atomicWriteJson(this.path(\"globals\"), x)';",
					"\t}",
					"}",
				].join("\n"),
			),
		).toEqual([]);
	});

	it("别的文件的写盘与读盘不算", () => {
		expect(
			strays(
				[
					"class S {",
					"\tasync other() {",
					'\t\tawait atomicWriteJson(this.path("targets"), x);',
					'\t\tawait readJsonOrInit(this.path("globals"), f);',
					"\t}",
					"}",
				].join("\n"),
			),
		).toEqual([]);
	});
});

describe("落盘口的判据:抓", () => {
	it("在别的方法里再写一次", () => {
		expect(
			strays(
				[
					"class S {",
					"\tprivate async persistGlobals() {",
					'\t\tawait atomicWriteJson(this.path("globals"), x);',
					"\t}",
					"\tasync patch() {",
					'\t\tawait atomicWriteJson(this.path("globals"), y);',
					"\t}",
					"}",
				].join("\n"),
			),
		).toEqual([{ line: 6, method: "patch" }]);
	});

	it("atomicWriteFile 也算,方法外的顶层调用也算", () => {
		expect(
			strays(
				[
					"class S {",
					"\tasync other() {",
					'\t\tawait atomicWriteFile(this.path("globals"), bytes);',
					"\t}",
					"}",
					'atomicWriteJson(this.path("globals"), z);',
				].join("\n"),
			),
		).toEqual([
			{ line: 3, method: "other" },
			{ line: 6, method: undefined },
		]);
	});

	it("persistGlobals 里嵌的箭头函数仍算在它里面;别的方法里嵌的不放过", () => {
		expect(
			strays(
				[
					"class S {",
					"\tasync other() {",
					'\t\tawait run(async () => atomicWriteJson(this.path("globals"), x));',
					"\t}",
					"\tasync persistGlobals() {",
					'\t\tawait run(async () => atomicWriteJson(this.path("globals"), x));',
					"\t}",
					"}",
				].join("\n"),
			),
		).toEqual([{ line: 3, method: "other" }]);
	});
});

describe("真扫 config/store.ts", () => {
	it("核心设置文件只在 persistGlobals 里落盘,且真有这一处", () => {
		const source = parseSource(resolve(REPO_ROOT, STORE_FILE));
		expect(strayCoreSettingsWrites(source)).toEqual([]);
		// 判据别因为哪天改了写法而空转:persistGlobals 里必须真有一处命中。
		const all = findNodes(source, isCoreSettingsWrite);
		expect(all.length).toBeGreaterThanOrEqual(1);
	});
});
