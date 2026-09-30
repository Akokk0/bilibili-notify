/**
 * 守卫 13 后半:数据根下的每个一级目录都在目录表里(`runtime/roots.ts`)。
 *
 * 漏登是静默的:数据代换代时,迁移只搬表里登记过的目录,没登记的那份数据就被丢在旧代里,
 * 而类型、测试、构建全绿。前缀本身由类型层守:`dataPath` / `hostPath` 的第一段只收表里的键。
 * 这里钉的是**没人绕开它们** ——
 *
 * 1. 配置键 `dataDir` 只在边界上出现(定出它的地方、boot 的那份重实现、推出两个根的地方)。
 *    下游只认 `hostRoot` / `dataRoot`,不然两个根又混回一个名字,换代那天分不清谁该跟着代走。
 * 2. 在两个根上直接 `join` / `resolve` / 拼模板串的,只许 `runtime/roots.ts` 自己。
 * 3. 宿主表里的 `logs` 与冻住的桌面壳写死的那一处对得上。
 *
 * 判据写成纯函数 + 样例,因为判据本身也会写错:一条永远判 OK 的规则跟没有一样。
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import {
	findNodes,
	listSources,
	parseSource,
	type Source,
	ts,
} from "../../../../scripts/source-scan.mjs";
import { HOST_ROOT_LAYOUT } from "../runtime/roots.js";

const ROOTS_MODULE = "apps/server/src/runtime/roots.ts";

/** 配置键 `dataDir` 可以出现的地方。每个都得真的用到它,不然这张名单就在烂。 */
const DATA_DIR_BOUNDARY: Record<string, string> = {
	"apps/server/src/config/schema.ts": "配置键本身",
	"apps/server/src/config/loader.ts": "文件 / 环境变量 / 命令行三路定出它",
	"apps/server/src/update/versions-root.ts": "boot 加载不了 loader,自己解一遍 dataDir(有对拍测试)",
	"apps/server/src/runtime/bootstrap.ts": "推出宿主根与数据根的唯一一处",
	"apps/server/src/index.ts": "开机清扫跑在建运行时之前,那里先取一次宿主根",
};

const ROOT_NAMES = new Set(["dataRoot", "hostRoot"]);
const PATH_JOINERS = new Set(["join", "resolve"]);
const PATH_MODULE = /^(?:node:)?path(?:\/posix|\/win32)?$/;

/** `x`、`a.b.x` 的尾名;别的写法回 undefined。 */
function tailName(node: ts.Node): string | undefined {
	if (ts.isIdentifier(node)) return node.text;
	if (ts.isPropertyAccessExpression(node)) return node.name.text;
	if (ts.isParenthesizedExpression(node)) return tailName(node.expression);
	return undefined;
}

const isRoot = (node: ts.Node | undefined) => {
	const name = node && tailName(node);
	return name !== undefined && ROOT_NAMES.has(name);
};

/** 一份源码里标识符 `dataDir` 出现的行(属性名、简写、参数、变量都算;注释与字符串不算)。 */
export function dataDirMentions(source: Source): number[] {
	return findNodes(source, (node) => ts.isIdentifier(node) && node.text === "dataDir").map(
		(hit) => hit.line,
	);
}

/** 一份源码里在 `dataRoot` / `hostRoot` 上直接拼路径的地方(按行)。 */
export function rawRootJoins(source: Source): string[] {
	// 从 path 模块拿到的 join / resolve 本地名(含改名),以及命名空间 / 默认导入的名字。
	const joiners = new Set<string>();
	const namespaces = new Set<string>();
	for (const statement of source.ast.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
			continue;
		}
		if (!PATH_MODULE.test(statement.moduleSpecifier.text)) continue;
		const clause = statement.importClause;
		if (!clause) continue;
		if (clause.name) namespaces.add(clause.name.text);
		const bindings = clause.namedBindings;
		if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
		if (bindings && ts.isNamedImports(bindings)) {
			for (const element of bindings.elements) {
				if (PATH_JOINERS.has((element.propertyName ?? element.name).text)) {
					joiners.add(element.name.text);
				}
			}
		}
	}

	const isJoiner = (callee: ts.Expression) => {
		if (ts.isIdentifier(callee)) return joiners.has(callee.text);
		return (
			ts.isPropertyAccessExpression(callee) &&
			ts.isIdentifier(callee.expression) &&
			namespaces.has(callee.expression.text) &&
			PATH_JOINERS.has(callee.name.text)
		);
	};

	return findNodes(source, (node) => {
		if (ts.isCallExpression(node)) return isJoiner(node.expression) && isRoot(node.arguments[0]);
		if (ts.isTemplateExpression(node)) {
			return node.head.text === "" && isRoot(node.templateSpans[0]?.expression);
		}
		return (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
			isRoot(node.left)
		);
	}).map((hit) => `${hit.line}: ${hit.text.trim()}`);
}

const sample = (text: string) => parseSource("sample.ts", text);

describe("守卫 13 后半:数据根下只经目录表拼路径", () => {
	it("认法:`dataDir` 当标识符出现就算,注释与字符串不算", () => {
		const source = sample(
			[
				"// dataDir 在注释里",
				'const label = "dataDir";',
				"const a = bootstrap.dataDir;",
				"function f(dataDir: string) {}",
				"const b = { dataDir };",
			].join("\n"),
		);
		expect(dataDirMentions(source)).toEqual([3, 4, 5]);
	});

	it("认法:path 的 join / resolve(含改名与命名空间)、模板串、加号拼到根上都点名", () => {
		const source = sample(
			[
				'import { join, resolve as resolvePath } from "node:path";',
				'import * as path from "path";',
				'join(dataRoot, "state");',
				'resolvePath(opts.dataRoot, "extensions");',
				'path.join(runtime.hostRoot, "logs");',
				// biome-ignore lint/suspicious/noTemplateCurlyInString: 样例源码里本来就要有模板串
				"const t = `${dataRoot}/history`;",
				'const s = dataRoot + "/fans";',
			].join("\n"),
		);
		expect(rawRootJoins(source)).toEqual([
			'3: join(dataRoot, "state")',
			'4: resolvePath(opts.dataRoot, "extensions")',
			'5: path.join(runtime.hostRoot, "logs")',
			// biome-ignore lint/suspicious/noTemplateCurlyInString: 样例源码里本来就要有模板串
			"6: `${dataRoot}/history`",
			'7: dataRoot + "/fans"',
		]);
	});

	it("认法:经目录表的拼法、在子目录上接着拼、根不在第一位的,都不算", () => {
		const source = sample(
			[
				'import { join, relative } from "node:path";',
				'const stateDir = dataPath(dataRoot, "state");',
				'join(stateDir, "globals.json");',
				"relative(dataRoot, file);",
				"join(other, dataRoot);",
				// biome-ignore lint/suspicious/noTemplateCurlyInString: 样例源码里本来就要有模板串
				"const t = `root=${dataRoot}`;",
				'myJoin(dataRoot, "x");',
			].join("\n"),
		);
		expect(rawRootJoins(source)).toEqual([]);
	});

	it("配置键 `dataDir` 只出现在边界上", () => {
		const offenders = listSources(["apps/server/src"])
			.filter((path) => !(path in DATA_DIR_BOUNDARY))
			.flatMap((path) => dataDirMentions(parseSource(path)).map((line) => `${path}:${line}`));
		expect(offenders, "下游改用 runtime 上的 hostRoot / dataRoot").toEqual([]);
	});

	it("边界名单上的每个文件都真的用到 `dataDir`", () => {
		const unused = Object.keys(DATA_DIR_BOUNDARY).filter(
			(path) => dataDirMentions(parseSource(path)).length === 0,
		);
		expect(unused, "名单上的这些已经不碰 dataDir 了,删掉它们").toEqual([]);
	});

	it("在两个根上直接拼路径的只有 runtime/roots.ts", () => {
		const offenders = listSources(["apps/server/src"])
			.filter((path) => path !== ROOTS_MODULE)
			.flatMap((path) => rawRootJoins(parseSource(path)).map((hit) => `${path}:${hit}`));
		expect(offenders, "改用 dataPath / hostPath,新的一级目录先登进目录表").toEqual([]);
	});

	/**
	 * 桌面壳是冻住的(老安装包不随应用内更新替换),它把日志目录写死成 `<dataDir>/logs`。
	 * 宿主表那一行改了名,新版就往壳看不见的地方写日志,「打开日志目录」打开的是空目录。
	 */
	it("宿主表的 logs 和桌面壳写死的日志目录是同一个", () => {
		const shell = readFileSync(
			new URL("../../../desktop/src-tauri/src/main.rs", import.meta.url),
			"utf8",
		);
		expect(Object.keys(HOST_ROOT_LAYOUT)).toContain("logs");
		expect(shell).toContain('data_dir.join("logs")');
	});
});
