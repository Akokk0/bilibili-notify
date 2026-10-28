/**
 * internal 的公开子路径是一张闭集。
 *
 * 这张表与 `package.json` 的 exports、Vite 的打包入口必须完全相等。子路径是浏览器端的零依赖
 * 门面(只给 Node 读的那一类除外,见 `NODE_SUBPATHS`):多开一条会把内部模块变成公开 API,少开一条会让已有面板在运行时找不到模块。表里每个源
 * 文件也只许有 type import,或指向这张表里别的源文件;一条值级 import 就能把 zod 与整张 schema
 * 图拽进前端 bundle,而且构建、类型检查、组件测试都可能全绿。
 *
 * 守卫放在仓库级 `scripts/__tests__/`:它同时读包清单、Vite 配置和包源码,并用 `source-scan.mjs`
 * 的 TypeScript AST 判 import —— 多行 import、行内 `type` 与动态 import 都不靠逐行正则猜。
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
	findNodes,
	importsOf,
	parseSource,
	resolveSpecifier,
	stripExt,
	ts,
} from "../source-scan.mjs";
import { repoRoot } from "../vite-alias.mjs";

const PACKAGE_ROOT = "packages/internal";
const PACKAGE_FILE = `${PACKAGE_ROOT}/package.json`;
const CONFIG_FILE = `${PACKAGE_ROOT}/vite.config.ts`;
const INDEX_FILE = `${PACKAGE_ROOT}/src/index.ts`;
const CONSTANTS_FILE = `${PACKAGE_ROOT}/src/constants.ts`;

/**
 * internal 的公开子路径闭集。`why` 只记一个真实读者要什么值,不是新的约束。
 *
 * 每开一条都要同时改这里、`package.json` 的 exports 与 `vite.config.ts` 的 pack entry。
 */
const SUBPATHS = [
	{
		subpath: "./ai",
		source: "src/ai.ts",
		why: "面板与 contract 取 AI 服务商、人格和锐评配置",
	},
	{
		subpath: "./bilibili-guard",
		source: "src/bilibili-guard.ts",
		why: "面板、引擎与出图器取 B 站大航海档位",
	},
	{
		subpath: "./builtin-texts",
		source: "src/builtin-texts.ts",
		why: "面板与服务端取出厂文案与内置人格",
	},
	{
		subpath: "./card-skin",
		source: "src/card-skin.ts",
		why: "面板与 contract 取卡片皮肤契约",
	},
	{
		subpath: "./extension",
		source: "src/extension/index.ts",
		why: "门与宿主取拓展契约的类型",
	},
	{
		subpath: "./extension/wire",
		source: "src/extension/wire.ts",
		why: "拓展交给面板画的形状与判据",
	},
	{
		subpath: "./features",
		source: "src/features.ts",
		why: "面板与 contract 取订阅特性和附加项词表",
	},
	{
		subpath: "./format",
		source: "src/format.ts",
		why: "卡片、推送、面板与状态页取数字和时间排版",
	},
	{
		subpath: "./history",
		source: "src/history.ts",
		why: "面板与服务端取历史状态和保留期",
	},
	{
		subpath: "./i18n",
		source: "src/i18n.ts",
		why: "面板与服务端共用字典机制",
	},
	{
		subpath: "./identity",
		source: "src/identity.ts",
		why: "面板与服务端取订阅身份和 UP 主配色",
	},
	{
		subpath: "./link-preview",
		source: "src/link-preview.ts",
		why: "面板与 contract 取链接预览契约和上限",
	},
	{
		subpath: "./live-monitor",
		source: "src/live-monitor.ts",
		why: "面板与服务端共用直播监听判定",
	},
	{
		subpath: "./patch",
		source: "src/patch.ts",
		why: "面板所有保存路径构造配置 PATCH",
	},
	{
		subpath: "./platform-descriptor",
		source: "src/platform-descriptor.ts",
		why: "拓展与宿主共用中性平台描述",
	},
	{
		subpath: "./platform-registry",
		source: "src/platform-registry.ts",
		why: "面板、服务端与 contract 取内置连接平台注册表",
	},
	{
		subpath: "./push-target",
		source: "src/push-target.ts",
		why: "面板、服务端与 contract 取推送目标和回复判定",
	},
	{
		subpath: "./result",
		source: "src/result.ts",
		why: "面板、服务端与拓展取结果与失败码",
	},
	{
		subpath: "./template-defaults",
		source: "src/template-defaults.ts",
		why: "面板判断默认文案是否有更新",
	},
	{
		subpath: "./template-variables",
		source: "src/template-variables.ts",
		why: "面板拼提示条、服务端探针取变量名",
	},
	{
		subpath: "./update",
		source: "src/update.ts",
		why: "面板、服务端与 contract 判更新镜像前缀",
	},
];

const ROOT_ONLY_ZERO_DEPENDENCY_SOURCES = [
	{
		source: "src/image-ref.ts",
		why: "图库引用形状不开子路径,只从根入口转出",
	},
];

/**
 * 只给 Node 读的子路径:拓展根上的构建配置(`vite.config.ts`)经门的 `@bilibili-notify/extension/build` 取它,
 * 从规则导出清单里的设置项。它要读写文件、调对表与清单格式,天生不零依赖,也永远不进浏览器 ——
 * 所以只进上面「子路径表」那三条(exports、pack entry、没有重复),不受下面零依赖纪律管;零依赖的条目也
 * 引不到它(它不在零依赖同伴里)。
 */
const NODE_SUBPATHS = [
	{
		subpath: "./extension/build",
		source: "src/extension/build.ts",
		why: "拓展构建时从规则导出清单里的设置项",
	},
];

const ALL_SUBPATHS = [...SUBPATHS, ...NODE_SUBPATHS];

const ZERO_DEPENDENCY_ENTRIES = [...SUBPATHS, ...ROOT_ONLY_ZERO_DEPENDENCY_SOURCES];
const packageJson = JSON.parse(readFileSync(resolve(repoRoot(), PACKAGE_FILE), "utf8"));

const sorted = (values) => [...values].sort();
const sourcePath = (source) => `${PACKAGE_ROOT}/${source}`;

function configEntries() {
	const source = parseSource(CONFIG_FILE);
	const hits = findNodes(
		source,
		(node) =>
			ts.isPropertyAssignment(node) &&
			(ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
			node.name.text === "entry",
	);
	if (hits.length !== 1 || !ts.isArrayLiteralExpression(hits[0].node.initializer)) return [];
	return hits[0].node.initializer.elements.map((element) =>
		ts.isStringLiteral(element) ? element.text : `<not-a-string:${element.getText(source.ast)}>`,
	);
}

function exportEntries() {
	return Object.entries(packageJson.exports).filter(
		([subpath]) => subpath !== "." && subpath !== "./package.json",
	);
}

function subpathTableProblems() {
	const duplicateSubpaths = ALL_SUBPATHS.map(({ subpath }) => subpath).filter(
		(subpath, index, all) => all.indexOf(subpath) !== index,
	);
	const duplicateSources = ALL_SUBPATHS.map(({ source }) => source).filter(
		(source, index, all) => all.indexOf(source) !== index,
	);
	return {
		duplicateSubpaths: sorted(new Set(duplicateSubpaths)),
		duplicateSources: sorted(new Set(duplicateSources)),
		missingReasons: ALL_SUBPATHS.filter(({ why }) => why.trim() === "").map(
			({ subpath }) => subpath,
		),
		missingSources: ALL_SUBPATHS.filter(
			({ source }) => !existsSync(resolve(repoRoot(), sourcePath(source))),
		).map(({ source }) => source),
	};
}

function packageExportProblems() {
	const expectedSubpaths = sorted(ALL_SUBPATHS.map(({ subpath }) => subpath));
	const actualSubpaths = sorted(exportEntries().map(([subpath]) => subpath));
	const expectedTargets = new Map(
		ALL_SUBPATHS.map(({ subpath, source }) => [
			subpath,
			`./lib/${source.replace(/^src\//, "").replace(/\.ts$/, ".mjs")}`,
		]),
	);
	const wrongTargets = exportEntries().flatMap(([subpath, target]) => {
		const expected = expectedTargets.get(subpath);
		return expected === undefined || target === expected
			? []
			: [`${subpath}: expected ${expected}, got ${String(target)}`];
	});
	return {
		missing: expectedSubpaths.filter((subpath) => !actualSubpaths.includes(subpath)),
		unexpected: actualSubpaths.filter((subpath) => !expectedSubpaths.includes(subpath)),
		wrongTargets,
	};
}

function viteEntryProblems() {
	const expected = sorted(["src/index.ts", ...ALL_SUBPATHS.map(({ source }) => source)]);
	const actual = sorted(configEntries());
	return {
		missing: expected.filter((entry) => !actual.includes(entry)),
		unexpected: actual.filter((entry) => !expected.includes(entry)),
		duplicates: actual.filter((entry, index) => actual.indexOf(entry) !== index),
	};
}

function zeroDependencyProblems(sourceFile) {
	const allowedSources = new Set(
		ZERO_DEPENDENCY_ENTRIES.map(({ source }) => stripExt(sourcePath(source))),
	);
	return zeroDependencyProblemsInSource(parseSource(sourceFile), allowedSources);
}

function zeroDependencyProblemsInSource(source, allowedSources) {
	return importsOf(source)
		.filter((ref) => {
			if (ref.typeOnly) return false;
			const resolved = resolveSpecifier(source.path, ref.specifier);
			if (
				resolved !== undefined &&
				/^packages\/internal\/src\/locales\/[\w-]+\.json$/.test(resolved)
			) {
				return false;
			}
			return resolved === undefined || !allowedSources.has(stripExt(resolved));
		})
		.map((ref) => `${source.path}:${ref.line} ${ref.kind} ${ref.specifier}`);
}

function rootEntryProblems(path, text) {
	const source = parseSource(path, text);
	return source.ast.statements.flatMap((statement) => {
		if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier === undefined) {
			const line =
				source.ast.getLineAndCharacterOfPosition(statement.getStart(source.ast)).line + 1;
			return [
				`${path}:${line} 不是带说明符的 export-from: ${statement.getText(source.ast).split("\n", 1)[0]}`,
			];
		}
		const specifier = ts.isStringLiteral(statement.moduleSpecifier)
			? statement.moduleSpecifier.text
			: "";
		if (specifier === "./extension" || specifier.startsWith("./extension/")) {
			const line =
				source.ast.getLineAndCharacterOfPosition(statement.getStart(source.ast)).line + 1;
			return [`${path}:${line} 根入口不许转出拓展契约: ${specifier}`];
		}
		return [];
	});
}

describe("internal 的子路径表", () => {
	it("没有重复、空白理由或找不到的源文件", () => {
		expect(subpathTableProblems()).toEqual({
			duplicateSubpaths: [],
			duplicateSources: [],
			missingReasons: [],
			missingSources: [],
		});
	});

	it("package.json 的 exports 与表完全相等,且每条都指向对应产物", () => {
		expect(packageExportProblems()).toEqual({ missing: [], unexpected: [], wrongTargets: [] });
	});

	it("Vite 的 pack entry 与表完全相等", () => {
		expect(viteEntryProblems()).toEqual({ missing: [], unexpected: [], duplicates: [] });
	});
});

describe("internal 不许重新长出 constants 杂物间", () => {
	it("src/constants.ts 不存在,exports 也没有 ./constants", () => {
		expect({
			sourceExists: existsSync(resolve(repoRoot(), CONSTANTS_FILE)),
			exportExists: Object.hasOwn(packageJson.exports, "./constants"),
		}).toEqual({ sourceExists: false, exportExists: false });
	});
});

describe("internal 子路径源文件的零依赖纪律", () => {
	it.each(ZERO_DEPENDENCY_ENTRIES.map(({ source, why }) => [source, why]))(
		"%s 的值级引用只许指向零依赖同伴或 locales JSON(%s)",
		(source) => {
			expect(zeroDependencyProblems(sourcePath(source))).toEqual([]);
		},
	);

	it("判法认得出普通与多行值级 import,放行 type import", () => {
		const sample = (text) =>
			zeroDependencyProblemsFromText("packages/internal/src/sample.ts", text);
		expect(sample('import { z } from "zod";')).toHaveLength(1);
		expect(sample('import {\n\tz\n} from "zod";')).toHaveLength(1);
		expect(sample('export { z } from "zod";')).toHaveLength(1);
		expect(sample('const z = await import("zod");')).toHaveLength(1);
		expect(sample('const z = require("zod");')).toHaveLength(1);
		expect(sample('import type { Result } from "zod";')).toEqual([]);
		expect(sample('import { type Result } from "./result";')).toEqual([]);
		expect(sample('import { ok } from "./result.js";')).toEqual([]);
		expect(sample('export { ok } from "./result";')).toEqual([]);
		expect(sample('import zh from "./locales/zh-CN.json";')).toEqual([]);
	});
});

describe("internal 根入口只做转出", () => {
	it("index.ts 的每条顶层语句都是带说明符的 export-from", () => {
		expect(rootEntryProblems(INDEX_FILE, parseSource(INDEX_FILE).text)).toEqual([]);
	});

	it("判法认得出本地声明与拓展契约转出", () => {
		expect(reexportProblems(`export const x = 1;`)).toHaveLength(1);
		expect(reexportProblems(`export * from "./extension/wire";`)).toHaveLength(1);
		expect(reexportProblems(`import { z } from "zod";\nexport * from "./result";`)).toHaveLength(1);
		expect(reexportProblems(`export { x };`)).toHaveLength(1);
		expect(
			reexportProblems(`export * from "./result";\nexport type { Result } from "./result";`),
		).toEqual([]);
	});
});

function zeroDependencyProblemsFromText(path, text) {
	const allowedSources = new Set(
		ZERO_DEPENDENCY_ENTRIES.map(({ source }) => stripExt(sourcePath(source))),
	);
	return zeroDependencyProblemsInSource(parseSource(path, text), allowedSources);
}

function reexportProblems(text) {
	return rootEntryProblems("sample.ts", text);
}
