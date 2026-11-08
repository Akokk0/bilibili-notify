import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join, posix } from "node:path";
import ts from "typescript";
import { repoRoot } from "./vite-alias.mjs";

/**
 * 扫源码的守卫共用的仓库级工具:遍历、解析、抠 import、按节点找。
 *
 * 各道守卫原先各抄一份「剥注释 + 正则」,注释、字符串、模板、正则字面量里的 `import(` /
 * `fetch(` 各自认错,遍历的跳过规则也各飘各的。这里一律走 TypeScript 语法树:字样在注释或
 * 字符串里,天生不是节点。只做语法层(`ts.createSourceFile`),不建 Program、不要类型检查器,
 * 只取引用时不保留整棵树;真正访问 `ast` 才构建带父指针与 JSDoc 的完整树。
 *
 * 类型在 `source-scan.d.mts`。白名单与逐行放行标记是各守卫自己的事,不在这里。
 *
 * `ts` 从这里再导出一份:守卫写判据要用 `ts.isXxx`,经这扇门拿,消费方的包就不用各自声明
 * `typescript`(依赖卫生)。
 */

export { ts };

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".mjs"]);
const DECLARATION_FILE = /\.d\.[cm]?ts$/;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
/** 不管在第几层,这些目录里的都不是源码:依赖、本机工作区。 */
const SKIPPED_DIRS = new Set(["node_modules", ".claude"]);
/**
 * 构建产物与覆盖率只在包根(挨着 `package.json` 的那一层)才跳过:`src` 里恰好叫 `lib` 的是源码,
 * 按名字一律跳过会让守卫在那儿静默失明。
 */
const BUILD_OUTPUT_DIRS = new Set(["lib", "dist", "coverage"]);
const TEST_DIR = "__tests__";

/**
 * 列出源码文件。直接遍历磁盘、不问 git:还没 add 的新文件也得扫到。
 *
 * @param roots 仓库根的相对路径(如 `apps/server/src`)。根不存在就报错 —— 扫空了比没有还糟。
 * @param options `tests` 为真才含测试(`__tests__/` 目录与 `*.test.*` / `*.spec.*`);
 *   `root` 换掉仓库根,给测试在临时目录里造样例用。
 * @returns 相对仓库根的 posix 路径,排好序
 */
export function listSources(roots, options = {}) {
	const base = options.root ?? repoRoot();
	const withTests = options.tests === true;
	const found = new Set();

	const walk = (relDir) => {
		const isPackageRoot = existsSync(join(base, relDir, "package.json"));
		for (const entry of readdirSync(join(base, relDir), { withFileTypes: true })) {
			const rel = `${relDir}/${entry.name}`;
			if (entry.isDirectory()) {
				if (SKIPPED_DIRS.has(entry.name)) continue;
				if (isPackageRoot && BUILD_OUTPUT_DIRS.has(entry.name)) continue;
				if (!withTests && entry.name === TEST_DIR) continue;
				walk(rel);
				continue;
			}
			if (!entry.isFile()) continue;
			if (!SOURCE_EXTENSIONS.has(extname(entry.name))) continue;
			if (DECLARATION_FILE.test(entry.name)) continue;
			if (!withTests && TEST_FILE.test(entry.name)) continue;
			found.add(rel);
		}
	};

	for (const root of roots) {
		const rel = root.replace(/^\.\//, "").replace(/\/+$/, "");
		if (!statSync(join(base, rel), { throwIfNoEntry: false })?.isDirectory()) {
			throw new Error(`source root not found or not a directory: ${root}`);
		}
		walk(rel);
	}
	return [...found].sort();
}

/** 按路径缓存读盘解析的结果,同一进程里多道守卫共用。 */
const cache = new Map();
// 缓存的是同一份原文快照；引用读者只留元数据，节点读者才保留完整树。
const sourceStates = new WeakMap();

function scriptKindOf(path) {
	switch (extname(path)) {
		case ".tsx":
			return ts.ScriptKind.TSX;
		case ".mjs":
			return ts.ScriptKind.JS;
		default:
			return ts.ScriptKind.TS;
	}
}

/**
 * 解析一份源码。
 *
 * @param path 仓库相对路径(或绝对路径);只用来读盘、选 ScriptKind、报告
 * @param text 给了就用它,不读盘也不进缓存 —— 写样例用
 */
export function parseSource(path, text) {
	const build = (content) => {
		const state = {
			createAst: (parents) =>
				ts.createSourceFile(
					path,
					content,
					parents
						? ts.ScriptTarget.Latest
						: {
								languageVersion: ts.ScriptTarget.Latest,
								jsDocParsingMode: ts.JSDocParsingMode.ParseNone,
							},
					parents,
					scriptKindOf(path),
				),
		};
		const source = {
			path,
			text: content,
			get ast() {
				state.ast ??= state.createAst(true);
				return state.ast;
			},
		};
		sourceStates.set(source, state);
		return source;
	};
	if (text !== undefined) return build(text);

	const absolute = isAbsolute(path) ? path : join(repoRoot(), path);
	let source = cache.get(absolute);
	if (!source) {
		source = build(readFileSync(absolute, "utf8"));
		cache.set(absolute, source);
	}
	return source;
}

/** 说明符对着 importer 所在目录解析成仓库相对路径(保留扩展名);非相对说明符(包名)返回 undefined。 */
export function resolveSpecifier(file, specifier) {
	if (!specifier.startsWith(".")) return undefined;
	return posix.normalize(posix.join(posix.dirname(file), specifier));
}

/** `path` 是 `dir` 本身或在它里面(按目录边界判,`a/bc` 不在 `a/b` 里)。 */
export const isInside = (path, dir) => path === dir || path.startsWith(`${dir}/`);

/** 去掉 `.js` / `.ts` 之类的尾巴,方便拿解析结果去比目录。 */
export const stripExt = (path) => path.replace(/\.(m|c)?[jt]sx?$/, "");

/**
 * 标识符切成段:驼峰的每一段与下划线(含 `$`)分开的每一段,一律小写。
 * `resolveRoomIdFromUid` → resolve / room / id / from / uid;`BILI_UID_PARAM` → bili / uid / param;
 * `XMLHttp` → xml / http。
 */
export function identifierSegments(name) {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.split(/[\s_$]+/)
		.filter(Boolean)
		.map((segment) => segment.toLowerCase());
}

/**
 * 列出 `<组>/<名>/src`(该目录真存在的才列),仓库相对路径,排好序。守卫划「扫哪些包」的共用件。
 *
 * @param groups 仓库根下的组目录,如 `["apps", "packages"]`
 * @param options `except` 是要排除的根(完整的 `<组>/<名>/src`);`root` 换掉仓库根,给测试在临时目录里造样例用
 */
export function srcRootsUnder(groups, options = {}) {
	const base = options.root ?? repoRoot();
	const except = new Set(options.except ?? []);
	const roots = [];
	for (const group of groups) {
		for (const entry of readdirSync(join(base, group), { withFileTypes: true })) {
			const root = `${group}/${entry.name}/src`;
			if (!entry.isDirectory() || except.has(root)) continue;
			if (existsSync(join(base, root))) roots.push(root);
		}
	}
	return roots.sort();
}

const lineOf = (ast, node) => ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;

/** 字面量参数(`"x"` 或不带替换的反引号串)的值;别的写法给 undefined。 */
const literalText = (node) =>
	node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
		? node.text
		: undefined;

/** `{ type A, type B }` 每一项都带 `type`;空列表不算。 */
const everyItemIsType = (elements) => elements.length > 0 && elements.every((e) => e.isTypeOnly);

/**
 * 一份源码里所有 import 类引用,按出现顺序。
 *
 * kind:`import` 是带绑定的 import 声明,`side-effect` 是 `import "x"`,`export` 是
 * `export … from`,`dynamic` 是字面量参数的 `import("x")`(类型位置的 `import("x").T` 也算,
 * 它一定是 typeOnly),`require` 是 `require("x")` 与 `import x = require("x")`。
 * typeOnly:`import type` / `export type`,或具名列表里每一项都带 `type`;别的都是值,
 * 编译后会留下一条真实引用。
 */
export function importsOf(source) {
	const state = sourceStates.get(source);
	if (state?.imports && !state.ast) return state.imports.map((ref) => ({ ...ref }));
	// 沿用同一个TS语法解析器和遍历判据。引用清单不需要父指针/JSDoc，也不持有节点。
	const ast = state ? (state.ast ?? state.createAst(false)) : source.ast;
	const refs = [];
	const add = (node, specifier, typeOnly, kind) => {
		refs.push({ specifier, typeOnly, kind, line: lineOf(ast, node) });
	};

	const visit = (node) => {
		if (ts.isImportDeclaration(node)) {
			const specifier = literalText(node.moduleSpecifier);
			if (specifier !== undefined) {
				const clause = node.importClause;
				if (!clause) {
					add(node, specifier, false, "side-effect");
				} else {
					const named = clause.namedBindings;
					const typeOnly =
						clause.phaseModifier === ts.SyntaxKind.TypeKeyword ||
						(!clause.name &&
							!!named &&
							ts.isNamedImports(named) &&
							everyItemIsType(named.elements));
					add(node, specifier, typeOnly, "import");
				}
			}
		} else if (ts.isExportDeclaration(node)) {
			const specifier = literalText(node.moduleSpecifier);
			if (specifier !== undefined) {
				const clause = node.exportClause;
				const typeOnly =
					node.isTypeOnly ||
					(!!clause && ts.isNamedExports(clause) && everyItemIsType(clause.elements));
				add(node, specifier, typeOnly, "export");
			}
		} else if (ts.isImportEqualsDeclaration(node)) {
			const ref = node.moduleReference;
			if (ts.isExternalModuleReference(ref)) {
				const specifier = literalText(ref.expression);
				if (specifier !== undefined) add(node, specifier, node.isTypeOnly, "require");
			}
		} else if (ts.isCallExpression(node)) {
			const callee = node.expression;
			const specifier = literalText(node.arguments[0]);
			if (specifier !== undefined) {
				if (callee.kind === ts.SyntaxKind.ImportKeyword) add(node, specifier, false, "dynamic");
				else if (ts.isIdentifier(callee) && callee.text === "require") {
					add(node, specifier, false, "require");
				}
			}
		} else if (ts.isImportTypeNode(node)) {
			const argument = node.argument;
			const specifier = ts.isLiteralTypeNode(argument) ? literalText(argument.literal) : undefined;
			if (specifier !== undefined) add(node, specifier, true, "dynamic");
		}
		ts.forEachChild(node, visit);
	};
	visit(ast);
	if (state && !state.ast) {
		state.imports = refs;
		return refs.map((ref) => ({ ...ref }));
	}
	return refs;
}

/**
 * 深度优先(先父后子)找出 `match` 为真的节点。命中的节点里面照样往下找,嵌套的命中都收。
 * line 是节点起点(不含前导注释)的行号,text 是节点源码的第一行。
 */
export function findNodes(source, match) {
	const { ast } = source;
	const hits = [];
	const visit = (node) => {
		if (match(node)) {
			hits.push({
				node,
				line: lineOf(ast, node),
				text: node.getText(ast).split("\n", 1)[0].replace(/\r$/, ""),
			});
		}
		ts.forEachChild(node, visit);
	};
	ts.forEachChild(ast, visit);
	return hits;
}
