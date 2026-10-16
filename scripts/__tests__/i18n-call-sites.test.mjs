import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { placeholdersOf, stemOf } from "../../packages/internal/src/i18n.ts";
import {
	importsOf,
	listSources,
	parseSource,
	resolveSpecifier,
	stripExt,
	ts,
} from "../source-scan.mjs";

/**
 * 调用处对译文(ADR-0037 决策 1、6):两道检查一趟走完。
 *
 * ① 取字的值对得上译文 —— 类型只把键推成 string,推不出占位符,所以 `t("键", { 名字 })` 里传的参数名
 *   得与简体中文那句译文的占位符一一对上(带数量的句子另外必须给 `count`);
 * ② 取字的时机 —— 出字那一刻才读当前语言(决策 1),加载文件或构造对象时取字会把语言冻在那一刻:
 *   - `top-level`:加载时就跑 —— 模块顶层、静态字段 / 静态块、装饰器与计算属性名(类或对象定义时求值)、
 *     顶层立刻执行的回调(立即执行函数,`.map` / `.flatMap` / `.filter` / `.forEach` / `.reduce` / `.some` /
 *     `.every` / `.find*` / `.sort` 等数组方法的回调,`Array.from` 的回调)。读 `i18n.state().locale|voice`
 *     (数字与时间的写法)同样算。Hono 路由、`bus.on`、定时器的回调不在这份名单上,照旧算延后执行;
 *   - `eager`:类的实例字段初始化(`label = t(…)`),构造时就跑,长期运行的对象构造一次就把文字冻住,
 *     改成 getter 或用的时候再取;
 *   - `unsubscribed`(只查面板):组件或 hook(离调用最近的函数名是大写开头或 use 开头)里直接调 `i18n.t`
 *     不会订阅,切语言后不重画(决策 6),用 `const t = useT()`;事件回调、普通函数里调 `i18n.t` 是对的。
 *   `useT()` 放在组件的哪一层(条件里、普通函数里、回调里),交给 Biome 的 `useHookAtTopLevel`
 *   (react 域,`biome.json` 里开着,对 `.tsx` 实测会报);这里只查它不在模块顶层。
 *
 * 范围:服务端与面板的源码(不含测试),各端对各端的 zh-CN 译文(平实版与女仆层合起来)。
 * 全程走语法树,不建类型检查器:注释里、字符串里的 `t("x")` 天生不是调用节点。
 *
 * 认得哪些写法(其余一律红,见下):
 * - 服务端:`import { t }` / `import { t as 别名 }` 的调用 `t("键", { … })`,以及 `import { i18n }` 的 `i18n.t("键", { … })`;
 * - 面板:`const t = useT()`(任意本地名,直接以标识符接住 `useT()` 的结果)的调用,以及 `i18n.t(…)`;
 * - 键是字面量(`"x"` 或不带替换的反引号串);值是对象字面量(属性名取标识符 / 字符串 / 数字,含简写);
 * - `i18n.set(…)`、`i18n.subscribe(…)`、`i18n.state().locale`、`i18n.state().voice` 不是取字,放行。
 *
 * **认不出的写法一律红**(放过它们,守卫会随写法漂移悄悄退化成空转):键不是字面量、值是变量或带展开、
 * `t` 当值传递或赋给别人、`import *` / default / 转出 / 动态引入译文入口、引入入口里别的名字、
 * `useT()` 不是直接接成 `const x = useT()`、本地另有同名的声明遮住了 `t`(语法树分不出作用域:把本地变量
 * 改名,或写成 `import { t as tr }` / `const tx = useT()`;面板第 4 期照惯用写法 `const t = useT()` 会和
 * `.filter((t) => …)` 一类的循环变量成片相撞,要提前留意)。
 * 确要放行的写进 `ALLOWLIST`(文件 → `{ count, reason }`),开张时为空;`count` 是该文件里认不出的写法的
 * 实数,必须正好相等 —— 多了是新漏,少了是名单过期。
 *
 * 接受的代价:`sort` / `map` 等名字也会命中非数组对象(查询构造器的 `.sort(fn)`、迭代器助手
 * `it.values().map(fn)`),一样判成立即执行,仓里没有;顶层 async 立即执行函数里 `await` 之后的取字也判
 * top-level,仓里没有这种启动写法。
 *
 * 没认的少见写法:`(function () {…}).call(null)`、`Object.groupBy`、`String.replace` 的回调。
 *
 * 已知的漏:模块顶层调用本文件里一个取字的函数(`const HELP = buildHelp()`)语法上看不出,没有调用图;
 * 构造器里 `this.x = t(…)` 不判;`t` 当参数传进别处再调,也看不出;别处直接 `createI18n` 另起一个 store、
 * `apps/desktop/src` 不在范围里。
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** 两端各自的译文入口。`minCalls`:至少扫到几处调用(扫空了比没有还糟);面板眼下零调用,豁免。 */
export const ENDS = {
	server: {
		root: "apps/server/src",
		store: "apps/server/src/i18n/index",
		localeDir: "apps/server/src/i18n/locales",
		valueNames: ["t", "i18n"],
		minCalls: 1,
	},
	web: {
		root: "apps/web/src",
		store: "apps/web/src/i18n/index",
		localeDir: "apps/web/src/i18n/locales",
		valueNames: ["useT", "i18n"],
		minCalls: 0,
		// 面板的组件里取字要订阅(useT),直接调 i18n.t 不会在切语言后重画
		react: true,
	},
};

/**
 * 认不出的写法的放行名单:文件 → `{ count, reason }`。开张时为空。
 * `count` 是这个文件里认不出的写法的实数,必须正好相等:多了是新漏,少了是名单过期。
 * 只放行 `unrecognised`,键不在译文里、参数对不上、加载时取字这些从不放行。
 */
export const ALLOWLIST = {};

/** 把 zh-CN 的平实版与女仆层读成「句 → { 占位符, 是否带数量 }」。 */
export function sentencesOf(plain, maid = {}) {
	const sentences = new Map();
	for (const layer of [plain, maid]) {
		for (const [key, text] of Object.entries(layer)) {
			const stem = stemOf(key);
			const sentence = sentences.get(stem) ?? { placeholders: new Set(), plural: false };
			for (const name of placeholdersOf(text)) sentence.placeholders.add(name);
			if (key !== stem) sentence.plural = true;
			sentences.set(stem, sentence);
		}
	}
	return sentences;
}

const readJson = (path) => JSON.parse(readFileSync(join(REPO_ROOT, path), "utf8"));

function loadSentences(end) {
	return sentencesOf(
		readJson(`${end.localeDir}/zh-CN.json`),
		readJson(`${end.localeDir}/zh-CN.maid.json`),
	);
}

const unwrap = (node) => {
	let current = node;
	while (
		ts.isParenthesizedExpression(current) ||
		ts.isAsExpression(current) ||
		ts.isSatisfiesExpression(current) ||
		ts.isNonNullExpression(current)
	) {
		current = current.expression;
	}
	return current;
};

const literalKey = (node) =>
	node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
		? node.text
		: undefined;

/** 对象字面量的属性名;任何一项认不出(展开、计算属性、方法)就回 undefined。 */
function propertyNames(object) {
	const names = [];
	for (const property of object.properties) {
		if (ts.isShorthandPropertyAssignment(property)) {
			names.push(property.name.text);
		} else if (ts.isPropertyAssignment(property)) {
			const name = property.name;
			if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
				names.push(name.text);
			} else return undefined;
		} else return undefined;
	}
	return names;
}

/** 这些数组方法的回调在调用的那一刻就跑完,不算延后执行。 */
const EAGER_CALLBACK_METHODS = new Set([
	"map",
	"flatMap",
	"filter",
	"forEach",
	"reduce",
	"reduceRight",
	"some",
	"every",
	"find",
	"findIndex",
	"findLast",
	"findLastIndex",
	"sort",
	"toSorted",
]);

const skipParens = (node) => {
	let current = node;
	while (current.parent && ts.isParenthesizedExpression(current.parent)) current = current.parent;
	return current;
};

/** 这个函数是不是「被立刻调用」:立即执行函数的被调者,或数组方法 / Array.from 的回调。 */
function runsImmediately(fn) {
	const outer = skipParens(fn);
	const call = outer.parent;
	if (call === undefined || !ts.isCallExpression(call)) return false;
	if (call.expression === outer) return true; // (() => …)()
	const callee = call.expression;
	if (!ts.isPropertyAccessExpression(callee)) return false;
	// 只有第 0 个参数是回调:`reduce(cb, 初始值)` 的初始值函数不会被调
	if (EAGER_CALLBACK_METHODS.has(callee.name.text)) return call.arguments[0] === outer;
	return (
		callee.name.text === "from" &&
		ts.isIdentifier(callee.expression) &&
		callee.expression.text === "Array" &&
		call.arguments[1] === outer
	);
}

/**
 * 这个节点什么时候执行:
 * - `undefined`:延后(在函数体里,调用时才跑);
 * - `"top-level"`:加载文件时就跑(模块顶层、静态字段 / 静态块、顶层立刻执行的回调、
 *   装饰器与计算属性名 —— 它们在类或对象定义时求值);
 * - `"eager"`:类的实例字段初始化,构造时就跑,长期运行的对象构造一次就把文字冻住。
 */
function whenRuns(node) {
	let child = node;
	let current = node.parent;
	while (current !== undefined) {
		if (ts.isDecorator(current) || ts.isComputedPropertyName(current)) {
			// 跳过它所属的整个成员:装饰器和计算属性名不在成员的函数体里
			child = current.parent;
			// 参数装饰器:所属的是参数,再往上跳过拥有这个参数的函数(类定义时求值)
			if (ts.isParameter(child)) child = child.parent;
			current = child.parent;
			continue;
		}
		if (ts.isFunctionLike(current)) {
			if (!runsImmediately(current)) return undefined;
		} else if (
			ts.isParameter(current) &&
			current.initializer === child &&
			ts.isConstructorDeclaration(current.parent) &&
			ts.isParameterPropertyDeclaration(current, current.parent)
		) {
			// `constructor(private label = t(…))`:和实例字段同类,构造时就跑
			return "eager";
		} else if (
			ts.isPropertyDeclaration(current) &&
			!(ts.getCombinedModifierFlags(current) & ts.ModifierFlags.Static) &&
			current.initializer === child
		) {
			return "eager";
		}
		child = current;
		current = current.parent;
	}
	return "top-level";
}

/** 离这个节点最近的函数有没有一个「组件或 hook」的名字(大写开头,或 use 加大写 / 数字开头)。 */
function insideComponentOrHook(node) {
	const enclosingFunction = (from) => {
		let current = from;
		while (current !== undefined && !ts.isFunctionLike(current)) current = current.parent;
		return current;
	};
	// useMemo(() => …) 的回调在渲染里就跑,和 JSX 里 items.map(…) 的回调一样,往外找真正的组件
	const isUseMemoCallback = (fn) => {
		const outer = skipParens(fn);
		const call = outer.parent;
		if (call === undefined || !ts.isCallExpression(call) || call.arguments[0] !== outer) {
			return false;
		}
		const callee = call.expression;
		return (
			(ts.isIdentifier(callee) && callee.text === "useMemo") ||
			(ts.isPropertyAccessExpression(callee) && callee.name.text === "useMemo")
		);
	};
	let fn = enclosingFunction(node.parent);
	while (fn !== undefined && (runsImmediately(fn) || isUseMemoCallback(fn))) {
		fn = enclosingFunction(fn.parent);
	}
	if (fn === undefined) return false;
	// 匿名的 `export default function () {…}` 也当组件
	if (
		ts.isFunctionDeclaration(fn) &&
		fn.name === undefined &&
		(ts.getCombinedModifierFlags(fn) & ts.ModifierFlags.Default) !== 0
	) {
		return true;
	}
	let name = fn.name !== undefined && ts.isIdentifier(fn.name) ? fn.name.text : undefined;
	if (name === undefined) {
		// `const A = () => …` / `const A = memo(() => …)`
		let holder = fn.parent;
		while (
			holder !== undefined &&
			(ts.isParenthesizedExpression(holder) || ts.isCallExpression(holder))
		) {
			holder = holder.parent;
		}
		if (holder !== undefined && ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name)) {
			name = holder.name.text;
		}
	}
	return name !== undefined && /^(use[A-Z0-9]|[A-Z])/.test(name);
}

const lineOf = (source, node) =>
	source.ast.getLineAndCharacterOfPosition(node.getStart(source.ast)).line + 1;

const isStorePath = (file, specifier, store) => {
	const resolved = resolveSpecifier(file, specifier);
	if (resolved === undefined) return false;
	const bare = stripExt(resolved.replace(/\/+$/, ""));
	return bare === store || `${bare}/index` === store;
};

/** 一个源文件 export 出来的名字。 */
export function exportedNames(source) {
	const names = new Set();
	const exported = (node) =>
		ts.canHaveModifiers(node) &&
		(ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
	for (const statement of source.ast.statements) {
		if (ts.isVariableStatement(statement) && exported(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
			}
		} else if (ts.isFunctionDeclaration(statement) && exported(statement) && statement.name) {
			names.add(statement.name.text);
		} else if (
			ts.isExportDeclaration(statement) &&
			statement.moduleSpecifier === undefined &&
			statement.exportClause !== undefined &&
			ts.isNamedExports(statement.exportClause)
		) {
			for (const element of statement.exportClause.elements) names.add(element.name.text);
		}
	}
	return names;
}

/**
 * 放行名单与扫描结果对账,回问题清单(空 = 干净)。名单项 `{ count, reason }`:这个文件里
 * 认不出的写法正好 `count` 处才放行 —— 多了是新漏,少了是名单过期;别的问题码不放行。
 */
export function applyAllowlist(files, allowlist) {
	const problems = [];
	for (const [file, entry] of Object.entries(allowlist)) {
		if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
			problems.push(`放行名单 ${file} 没写理由`);
		}
		if (!Number.isInteger(entry.count) || entry.count < 1) {
			problems.push(`放行名单 ${file} 的数目要是正整数`);
		}
		if (!(files[file] ?? []).some((finding) => finding.code === "unrecognised")) {
			problems.push(`放行名单 ${file} 过期:已经没有认不出的写法,删掉这一项`);
		}
	}
	for (const [file, findings] of Object.entries(files)) {
		const unrecognised = findings.filter((finding) => finding.code === "unrecognised");
		const allowed = allowlist[file]?.count ?? 0;
		const line = (finding) => `${file}:${finding.line} [${finding.code}] ${finding.detail}`;
		for (const finding of findings) {
			if (finding.code !== "unrecognised") problems.push(line(finding));
		}
		if (allowed === 0) {
			for (const finding of unrecognised) problems.push(line(finding));
		} else if (unrecognised.length > allowed) {
			problems.push(
				`${file} 认不出的写法多了 ${unrecognised.length - allowed} 处(放行 ${allowed} 处,现有 ${unrecognised.length} 处)`,
			);
			for (const finding of unrecognised) problems.push(line(finding));
		} else if (unrecognised.length < allowed) {
			problems.push(
				`放行名单 ${file} 过期:放行 ${allowed} 处,只剩 ${unrecognised.length} 处,把数目改小`,
			);
		}
	}
	return problems;
}

/**
 * 分析一份源码。回 `{ findings, calls }`:
 * findings 的 code:`unrecognised`(认不出的写法)、`unknown-key`(键不在译文里)、
 * `values`(参数名对不上占位符)、`top-level`(模块顶层取字)。calls 是认得的取字调用数。
 */
export function analyzeFile(source, end, sentences) {
	const findings = [];
	const report = (code, node, detail) =>
		findings.push({ code, line: lineOf(source, node), detail });
	const { ast, path } = source;

	// 1. 入口的引入:只认具名的值引入,别的形式都认不出
	// 入口导出的名字 → 本地名的集合(同一个名字可以引入多次:`import { t as tr, t }`)
	const localsOf = { t: new Set(), i18n: new Set(), useT: new Set() };
	for (const statement of ast.statements) {
		if (ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined) {
			const specifier = literalKey(statement.moduleSpecifier);
			if (specifier !== undefined && isStorePath(path, specifier, end.store)) {
				report("unrecognised", statement, "转出译文入口,下游的取字就追不到了");
			}
			continue;
		}
		if (!ts.isImportDeclaration(statement)) continue;
		const specifier = literalKey(statement.moduleSpecifier);
		if (specifier === undefined || !isStorePath(path, specifier, end.store)) continue;
		const clause = statement.importClause;
		if (clause === undefined || clause.isTypeOnly) continue;
		if (clause.name !== undefined) {
			report("unrecognised", statement, "default 引入译文入口");
		}
		const bindings = clause.namedBindings;
		if (bindings === undefined) continue;
		if (ts.isNamespaceImport(bindings)) {
			report("unrecognised", statement, "import * 引入译文入口,追不到用了哪个名字");
			continue;
		}
		for (const element of bindings.elements) {
			if (element.isTypeOnly) continue;
			const imported = (element.propertyName ?? element.name).text;
			if (end.valueNames.includes(imported)) localsOf[imported].add(element.name.text);
			else
				report(
					"unrecognised",
					element,
					`从译文入口引入了 ${imported}(取字只认 ${end.valueNames.join(" / ")})`,
				);
		}
	}
	// 动态引入与 require 也追不到
	for (const ref of importsOf(source)) {
		if ((ref.kind === "dynamic" || ref.kind === "require") && !ref.typeOnly) {
			if (isStorePath(path, ref.specifier, end.store)) {
				findings.push({ code: "unrecognised", line: ref.line, detail: "动态引入译文入口" });
			}
		}
	}

	const i18nNames = localsOf.i18n;
	const useTNames = localsOf.useT;
	const tNames = new Set(localsOf.t);

	// 2. 面板:`const x = useT()` 接住的名字就是取字函数
	const okDeclarations = new Set();
	const isUseTCall = (node) => {
		const call = unwrap(node);
		return (
			ts.isCallExpression(call) &&
			ts.isIdentifier(call.expression) &&
			useTNames.has(call.expression.text) &&
			call.arguments.length === 0
		);
	};
	const collectDeclarations = (node) => {
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.initializer !== undefined &&
			isUseTCall(node.initializer)
		) {
			tNames.add(node.name.text);
			okDeclarations.add(node.name);
		}
		ts.forEachChild(node, collectDeclarations);
	};
	collectDeclarations(ast);

	const tracked = new Set([...tNames, ...i18nNames, ...useTNames]);
	if (tracked.size === 0) return { findings, calls: 0 };

	let calls = 0;
	// 取字(以及读语言 / 口吻)的时机:加载时、构造时都会把语言冻住(决策 1)
	const checkTiming = (node) => {
		const when = whenRuns(node);
		if (when === "top-level") {
			report("top-level", node, "加载文件时取字:语言会冻在加载那一刻,要在函数里调");
		} else if (when === "eager") {
			report("eager", node, "实例字段初始化时取字:构造一次就把文字冻住,改成 getter,或用的时候再取");
		}
	};
	const checkCall = (call) => {
		calls += 1;
		checkTiming(call);
		if (
			end.react &&
			ts.isPropertyAccessExpression(call.expression) &&
			insideComponentOrHook(call)
		) {
			report(
				"unsubscribed",
				call,
				"组件或 hook 里直接调 i18n.t 不会订阅,切语言后不重画:用 const t = useT()",
			);
		}
		const [keyNode, valuesNode, ...rest] = call.arguments;
		const key = literalKey(keyNode && unwrap(keyNode));
		if (key === undefined) {
			report("unrecognised", call, "键不是字面量");
			return;
		}
		const sentence = sentences.get(key);
		if (sentence === undefined) {
			report("unknown-key", call, `译文里没有「${key}」这一句`);
			return;
		}
		const expected = new Set(sentence.placeholders);
		if (sentence.plural) expected.add("count");
		if (rest.length > 0) report("values", call, `「${key}」多传了参数`);
		let given = [];
		if (valuesNode !== undefined) {
			const object = unwrap(valuesNode);
			if (!ts.isObjectLiteralExpression(object)) {
				report("unrecognised", call, `「${key}」的值不是对象字面量`);
				return;
			}
			given = propertyNames(object);
			if (given === undefined) {
				report("unrecognised", call, `「${key}」的值里有展开、计算属性或方法`);
				return;
			}
		}
		for (const name of expected) {
			if (!given.includes(name)) report("values", call, `「${key}」缺参数 ${name}`);
		}
		for (const name of given) {
			if (!expected.has(name))
				report("values", call, `「${key}」多传了 ${name},译文里没有这个占位符`);
		}
	};

	// 3. 逐个标识符判角色
	const visit = (node) => {
		if (ts.isIdentifier(node) && tracked.has(node.text)) classify(node);
		ts.forEachChild(node, visit);
	};
	const isDeclarationName = (id) => {
		const p = id.parent;
		return (
			((ts.isParameter(p) ||
				ts.isVariableDeclaration(p) ||
				ts.isBindingElement(p) ||
				ts.isFunctionDeclaration(p) ||
				ts.isFunctionExpression(p) ||
				ts.isClassDeclaration(p) ||
				ts.isClassExpression(p) ||
				ts.isEnumDeclaration(p)) &&
				p.name === id) ||
			ts.isImportClause(p) ||
			ts.isNamespaceImport(p)
		);
	};
	const classify = (id) => {
		const p = id.parent;
		// 不是引用的位置:成员名、键名、引入的说明符、类型位置
		if (ts.isPropertyAccessExpression(p) && p.name === id) return;
		if (
			(ts.isPropertyAssignment(p) ||
				ts.isPropertyDeclaration(p) ||
				ts.isMethodDeclaration(p) ||
				ts.isPropertySignature(p) ||
				ts.isMethodSignature(p) ||
				ts.isEnumMember(p)) &&
			p.name === id
		) {
			return;
		}
		if (ts.isImportSpecifier(p) || (ts.isBindingElement(p) && p.propertyName === id)) return;
		if (ts.isTypeReferenceNode(p) || ts.isTypeQueryNode(p)) return;
		if (isDeclarationName(id)) {
			if (!okDeclarations.has(id)) {
				report(
					"unrecognised",
					id,
					`${id.text} 被别的声明占用了(语法树分不出作用域):把本地变量改名,或把取字的名字换掉(import { t as tr } / const tx = useT())`,
				);
			}
			return;
		}
		const name = id.text;
		if (tNames.has(name)) {
			if (ts.isCallExpression(p) && p.expression === id) checkCall(p);
			else report("unrecognised", id, `${name} 被当值用(传递、赋值或取成员),只认直接调用`);
			return;
		}
		if (useTNames.has(name)) {
			if (ts.isCallExpression(p) && p.expression === id && isUseTCall(p)) {
				// 已经由声明收集认过,这里只查时机;hook 放在组件的哪一层交给 Biome 的 useHookAtTopLevel
				const owner = p.parent;
				if (ts.isVariableDeclaration(owner) && ts.isIdentifier(owner.name)) {
					checkTiming(p);
					return;
				}
			}
			report("unrecognised", id, "useT() 要直接接成 const x = useT()");
			return;
		}
		if (i18nNames.has(name)) {
			if (!ts.isPropertyAccessExpression(p) || p.expression !== id) {
				report(
					"unrecognised",
					id,
					"i18n 被当值用,只认 i18n.t(…) / i18n.set / i18n.subscribe / i18n.state().locale|voice",
				);
				return;
			}
			const member = p.name.text;
			if (member === "t") {
				if (ts.isCallExpression(p.parent) && p.parent.expression === p) checkCall(p.parent);
				else report("unrecognised", p, "i18n.t 被当值用,只认直接调用");
			} else if (member === "set" || member === "subscribe") {
				// 不是取字
			} else if (member === "state") {
				const call = p.parent;
				const after = call.parent;
				const readsLocaleOrVoice =
					ts.isCallExpression(call) &&
					call.expression === p &&
					ts.isPropertyAccessExpression(after) &&
					after.expression === call &&
					["locale", "voice"].includes(after.name.text);
				if (!readsLocaleOrVoice) {
					report("unrecognised", p, "i18n.state() 只认 .locale / .voice,取字请走 t");
				} else {
					// 数字与时间的写法也是出字那一刻才读(决策 1);面板组件里读了也不会订阅
					checkTiming(p);
					if (end.react && insideComponentOrHook(p)) {
						report(
							"unsubscribed",
							p,
							"组件或 hook 里直接读 i18n.state() 不会订阅,切语言后不重画:用 useT() 取到的 t",
						);
					}
				}
			} else {
				report("unrecognised", p, `i18n.${member} 不认识`);
			}
		}
	};
	visit(ast);
	return { findings, calls };
}

// ---------------------------------------------------------------------------
// 判据的样例
// ---------------------------------------------------------------------------

const SENTENCES = sentencesOf({
	"a.plain": "没有占位符",
	"a.greet": "你好 {name}",
	"a.pair": "{left} 和 {right}",
	"a.item#other": "{count} 件",
	"a.moved#other": "{up} 发了 {count} 条",
});

const SERVER_FILE = "apps/server/src/runtime/sample.ts";
const SERVER_IMPORT = 'import { t } from "../i18n/index.js";\n';
const WEB_FILE = "apps/web/src/pages/Sample.tsx";
const WEB_IMPORT = 'import { useT } from "../i18n/index";\n';

const serverOf = (body, imports = SERVER_IMPORT) =>
	analyzeFile(parseSource(SERVER_FILE, imports + body), ENDS.server, SENTENCES);
const webOf = (body, imports = WEB_IMPORT) =>
	analyzeFile(parseSource(WEB_FILE, imports + body), ENDS.web, SENTENCES);
const codes = (result) => result.findings.map((finding) => finding.code);

describe("调用处守卫的判据(样例):干净的写法", () => {
	it("服务端:t 的字面量键加对得上的值,多种写法都认", () => {
		const result = serverOf(`
export function f(name: string) {
	t("a.plain");
	t("a.greet", { name });
	t("a.greet", { name: "x" });
	t("a.greet", { "name": 1 });
	t(\`a.pair\`, { left: 1, right: 2 });
	t("a.item", { count: 3 });
	t("a.moved", { up: "x", count: 1 });
	t("a.greet", { name } as const);
	return t("a.plain");
}
`);
		expect(result.findings).toEqual([]);
		expect(result.calls).toBe(9);
	});

	it("服务端:带数量的句子,count 不在译文占位符里也必须给", () => {
		// a.item#other 的文本里有 {count};换一句不写 {count} 的带数量句子
		const sentences = sentencesOf({ "n#other": "一些", "n#one": "一个" });
		const result = analyzeFile(
			parseSource(SERVER_FILE, `${SERVER_IMPORT}export const f = () => t("n");`),
			ENDS.server,
			sentences,
		);
		expect(codes(result)).toEqual(["values"]);
		const ok = analyzeFile(
			parseSource(SERVER_FILE, `${SERVER_IMPORT}export const f = () => t("n", { count: 2 });`),
			ENDS.server,
			sentences,
		);
		expect(ok.findings).toEqual([]);
	});

	it("服务端:别名与 i18n.t;i18n.set / subscribe / state().locale 放行", () => {
		const result = serverOf(
			`
export function f() {
	say("a.plain");
	i18n.t("a.greet", { name: "x" });
	i18n.set({ locale: "en" });
	i18n.subscribe(() => {});
	return i18n.state().locale;
}
`,
			'import { t as say, i18n } from "../i18n/index.js";\n',
		);
		expect(result.findings).toEqual([]);
		expect(result.calls).toBe(2);
	});

	it("面板:const t = useT() 之后的调用;不同组件各自接 t 也行", () => {
		const result = webOf(`
export function A() {
	const t = useT();
	return t("a.greet", { name: "x" });
}
export function B() {
	const tt = useT();
	return tt("a.plain");
}
`);
		expect(result.findings).toEqual([]);
		expect(result.calls).toBe(2);
	});

	it("注释与字符串里的 t(…) 不是调用", () => {
		const result = serverOf(`
// t("a.greet") 没传 name
/* t("nope") */
export const s = 't("a.greet")';
export const u = \`t("a.greet")\`;
`);
		expect(result).toEqual({ findings: [], calls: 0 });
	});

	it("不引入译文入口的文件不管:本地的 t 是别的东西", () => {
		const result = analyzeFile(
			parseSource(SERVER_FILE, "export const f = (t: (k: string) => string) => t(`x`);"),
			ENDS.server,
			SENTENCES,
		);
		expect(result).toEqual({ findings: [], calls: 0 });
	});

	it("只引入类型的不算", () => {
		const result = serverOf(
			"export type K = ServerTextKey;",
			'import type { ServerTextKey } from "../i18n/index.js";\n',
		);
		expect(result).toEqual({ findings: [], calls: 0 });
		const inline = serverOf(
			"export type K = ServerTextKey;",
			'import { type ServerTextKey } from "../i18n/index.js";\n',
		);
		expect(inline).toEqual({ findings: [], calls: 0 });
	});
});

describe("调用处守卫的判据(样例):参数与键", () => {
	it("参数名写错一个字母 → values(缺一个、多一个)", () => {
		const result = serverOf('export const f = () => t("a.greet", { nmae: "x" });');
		expect(codes(result)).toEqual(["values", "values"]);
	});

	it("少传一个 / 完全不传 / 多传一个 / 多传位置参数 → values", () => {
		expect(codes(serverOf('export const f = () => t("a.pair", { left: 1 });'))).toEqual(["values"]);
		expect(codes(serverOf('export const f = () => t("a.greet");'))).toEqual(["values"]);
		expect(codes(serverOf('export const f = () => t("a.plain", { extra: 1 });'))).toEqual([
			"values",
		]);
		expect(codes(serverOf('export const f = () => t("a.greet", { name: 1 }, 3);'))).toEqual([
			"values",
		]);
	});

	it("带数量的句子不给 count → values", () => {
		expect(codes(serverOf('export const f = () => t("a.item");'))).toEqual(["values"]);
		expect(codes(serverOf('export const f = () => t("a.moved", { up: "x" });'))).toEqual([
			"values",
		]);
	});

	it("键不在译文里(含写了 #类别 的键)→ unknown-key", () => {
		expect(codes(serverOf('export const f = () => t("a.nope");'))).toEqual(["unknown-key"]);
		expect(codes(serverOf('export const f = () => t("a.item#other", { count: 1 });'))).toEqual([
			"unknown-key",
		]);
	});
});

describe("调用处守卫的判据(样例):认不出的写法一律红", () => {
	const cases = {
		"键不是字面量(变量)": "export const f = (k: any) => t(k);",
		键是条件表达式: 'export const f = (c: boolean) => t(c ? "a.plain" : "a.greet");',
		// biome-ignore lint/suspicious/noTemplateCurlyInString: 样例源码里本来就要有模板串
		键是带替换的模板串: "export const f = (n: string) => t(`a.${n}`);",
		值是变量: 'export const f = (v: any) => t("a.greet", v);',
		值带展开: 'export const f = (v: any) => t("a.greet", { ...v });',
		值里有计算属性: 'export const f = (k: string) => t("a.greet", { [k]: 1 });',
		值里有方法: 'export const f = () => t("a.greet", { name() { return 1; } });',
		"t 赋给别人": "export const g = t;",
		"t 当参数传出去": "export const f = () => [1].map(t);",
		"t 取成员": 'export const f = () => t.call(null, "a.plain");',
		"本地同名参数遮住了 t": 'export const f = (t: any) => t("a.plain");',
		本地同名变量: "export function f() { const t = 1; return t; }",
		"i18n 当值传递": "export const f = () => use(i18n);",
		"i18n.t 当值用": "export const f = () => [1].map(i18n.t);",
		"i18n.state().t 绕开取字": 'export const f = () => i18n.state().t("a.plain");',
		"i18n 上不认识的成员": "export const f = () => i18n.dict;",
		"i18n 的 t 用下标取": 'export const f = () => i18n["t"]("a.plain");',
	};
	for (const [name, body] of Object.entries(cases)) {
		it(name, () => {
			const result = serverOf(body, 'import { t, i18n } from "../i18n/index.js";\n');
			expect(codes(result), name).toContain("unrecognised");
		});
	}

	it("import * / default / 转出 / 动态引入 / 引入入口里别的名字", () => {
		for (const imports of [
			'import * as texts from "../i18n/index.js";\n',
			'import texts from "../i18n/index.js";\n',
			'export { t } from "../i18n/index.js";\n',
			'import { DICTS } from "../i18n/index.js";\n',
			'import { t } from "../i18n";\nexport const lazy = () => import("../i18n/index.js");\n',
		]) {
			expect(codes(serverOf("export const x = 1;", imports)), imports).toContain("unrecognised");
		}
	});

	it("面板:useT() 不是直接接成 const;解构、直接调用、当参数", () => {
		for (const body of [
			"export function A() { const { t } = useT(); return t; }",
			'export function A() { return useT()("a.plain"); }',
			"export function A() { use(useT()); return 1; }",
			"export const h = useT;",
		]) {
			expect(codes(webOf(body)), body).toContain("unrecognised");
		}
	});

	it("面板:接住 useT() 的 t 被遮住 / 当值传", () => {
		expect(
			codes(webOf('export function A() { const t = useT(); return (t: any) => t("a.plain"); }')),
		).toContain("unrecognised");
		expect(codes(webOf("export function A() { const t = useT(); return use(t); }"))).toContain(
			"unrecognised",
		);
	});
});

describe("调用处守卫的判据(样例):模块顶层取字", () => {
	it("t(…) 在顶层 → top-level", () => {
		expect(codes(serverOf('export const text = t("a.plain");'))).toContain("top-level");
		expect(codes(serverOf('t("a.plain");'))).toContain("top-level");
	});

	it("const x = i18n.t(…) 放在顶层 → top-level", () => {
		const result = serverOf(
			'export const x = i18n.t("a.greet", { name: "x" });',
			'import { i18n } from "../i18n/index.js";\n',
		);
		expect(codes(result)).toEqual(["top-level"]);
	});

	it("顶层的模板串 / 对象 / 数组里取字,和静态类字段、静态块都算", () => {
		expect(codes(serverOf('export const o = { a: [t("a.plain")] };'))).toContain("top-level");
		expect(codes(serverOf('export class A { static x = t("a.plain"); }'))).toContain("top-level");
		expect(codes(serverOf('export class A { static { t("a.plain"); } }'))).toContain("top-level");
	});

	it("函数体里(声明、表达式、箭头、方法、构造器、非静态字段、默认参数)都是延后执行", () => {
		const result = serverOf(`
export function a() { return t("a.plain"); }
export const b = function () { return t("a.plain"); };
export const c = () => t("a.plain");
export const d = { m() { return t("a.plain"); } };
export class E {
	field = () => t("a.plain");
	constructor() { t("a.plain"); }
	get g() { return t("a.plain"); }
}
export function f(x = t("a.plain")) { return x; }
`);
		expect(result.findings).toEqual([]);
	});

	it("面板:useT() 本身在顶层也是错的", () => {
		expect(codes(webOf("const t = useT();\nexport const x = 1;"))).toContain("top-level");
	});
});

describe("调用处守卫的判据(样例):审查补的写法", () => {
	const I18N_IMPORT = 'import { i18n, t } from "../i18n/index.js";\n';

	it("同一个导出名引入两次(别名加原名、两条 import),每个本地名都追得到", () => {
		const aliasThenOriginal = serverOf(
			'export const top = tr("a.plain");\nexport const f = () => t("zzz");',
			'import { t as tr, t } from "../i18n/index.js";\n',
		);
		expect(codes(aliasThenOriginal)).toContain("top-level");
		expect(codes(aliasThenOriginal)).toContain("unknown-key");
		const twoImports = serverOf(
			'export const top = say("a.plain");\nexport const f = () => t("zzz");',
			'import { t } from "../i18n/index.js";\nimport { t as say } from "../i18n/index.js";\n',
		);
		expect(codes(twoImports)).toContain("top-level");
		expect(codes(twoImports)).toContain("unknown-key");
	});

	it("顶层读 i18n.state().locale / .voice 也算顶层取字;函数里读不算", () => {
		expect(
			codes(
				serverOf("export const fmt = new Intl.NumberFormat(i18n.state().locale);", I18N_IMPORT),
			),
		).toEqual(["top-level"]);
		expect(codes(serverOf("export const v = i18n.state().voice;", I18N_IMPORT))).toEqual([
			"top-level",
		]);
		expect(
			serverOf("export const f = () => new Intl.NumberFormat(i18n.state().locale);", I18N_IMPORT)
				.findings,
		).toEqual([]);
	});

	it("顶层立刻执行的回调:立即执行函数、数组方法的回调、Array.from 的回调,都算加载时取字", () => {
		for (const body of [
			'export const A = [1, 2].map((n) => ({ n, label: t("a.item", { count: n }) }));',
			'export const B = Object.fromEntries(["a"].map((k) => [k, t("a.plain")]));',
			'export const C = Array.from({ length: 2 }, () => t("a.plain"));',
			'export const D = (() => t("a.plain"))();',
			'export const E = (function () { return t("a.plain"); })();',
			'export const F = [1].reduce((acc) => acc + t("a.plain"), "");',
			'["a"].forEach(() => { t("a.plain"); });',
			'export const G = [1].flatMap(() => [t("a.plain")]);',
			'export const H = [1].filter(() => t("a.plain") === "x");',
			'export const I = [2, 1].toSorted(() => t("a.plain").length);',
		]) {
			expect(codes(serverOf(body)), body).toContain("top-level");
		}
	});

	it("路由、事件、定时器的回调不在名单上,照旧算延后执行", () => {
		const result = serverOf(`
declare const app: any;
declare const bus: any;
app.get("/", () => t("a.plain"));
bus.on("x", () => t("a.plain"));
setTimeout(() => t("a.plain"), 1);
export const lazy = () => [1].map(() => t("a.plain"));
`);
		expect(result.findings).toEqual([]);
	});

	it("实例字段的初始值里直接取字 → eager(构造时冻住);getter、方法、箭头字段不算", () => {
		const eager = serverOf('export class S { readonly label = t("a.plain"); }');
		expect(codes(eager)).toEqual(["eager"]);
		expect(eager.findings[0].detail).toContain("getter");
		const fine = serverOf(`
export class S {
	get label() { return t("a.plain"); }
	describe() { return t("a.plain"); }
	handler = () => t("a.plain");
}
`);
		expect(fine.findings).toEqual([]);
	});

	it("装饰器与计算属性名在定义时求值,算加载时取字", () => {
		for (const body of [
			'export class S { @dec(t("a.plain")) m() {} }',
			'export class S { @dec(t("a.plain")) f = 1 }',
			'export class S { [t("a.plain")]() {} }',
			'export class S { [t("a.plain")] = 1 }',
			'export const o = { [t("a.plain")]() {} };',
		]) {
			expect(codes(serverOf(body)), body).toContain("top-level");
		}
	});

	it("引入路径以斜杠结尾也追得到", () => {
		const result = serverOf('export const top = t("a.plain");', 'import { t } from "../i18n/";\n');
		expect(codes(result)).toEqual(["top-level"]);
	});

	it("本地变量遮住 t 的报错给出绕法", () => {
		const result = serverOf("export const f = (t: any) => t;", I18N_IMPORT);
		const shadow = result.findings.find((finding) => finding.code === "unrecognised");
		expect(shadow.detail).toContain("import { t as tr }");
		expect(shadow.detail).toContain("改名");
	});

	it("面板组件与 hook 里直接调 i18n.t 不会订阅 → unsubscribed;事件回调、普通函数里可以", () => {
		const web = (body) => webOf(body, 'import { i18n } from "../i18n/index";\n');
		for (const body of [
			'export function A() { return <p>{i18n.t("a.plain")}</p>; }',
			'export const B = () => <p>{i18n.t("a.plain")}</p>;',
			'export function useLabel() { return i18n.t("a.plain"); }',
			'export const C = memo(function C() { return i18n.t("a.plain"); });',
			'export const D = memo(() => i18n.t("a.plain"));',
		]) {
			expect(codes(web(body)), body).toContain("unsubscribed");
		}
		expect(
			web(`
export function A() {
	const handle = () => i18n.t("a.plain");
	return <button type="button" onClick={() => i18n.t("a.plain")} onBlur={handle} />;
}
export function helper() { return i18n.t("a.plain"); }
`).findings,
		).toEqual([]);
		// 服务端没有「组件」一说
		expect(
			serverOf('export function A() { return i18n.t("a.plain"); }', I18N_IMPORT).findings,
		).toEqual([]);
	});

	it("面板组件里:JSX 的 map 回调、useMemo 的回调、匿名默认导出的组件,和 i18n.state() 读取都算 unsubscribed", () => {
		const web = (body) => webOf(body, 'import { i18n } from "../i18n/index";\n');
		for (const body of [
			'export function List({ items }: { items: string[] }) { return <ul>{items.map((i) => <li key={i}>{i18n.t("a.plain")}</li>)}</ul>; }',
			'export function A() { const label = useMemo(() => i18n.t("a.plain"), []); return <p>{label}</p>; }',
			'export default function () { return <p>{i18n.t("a.plain")}</p>; }',
			"export function B() { const fmt = new Intl.NumberFormat(i18n.state().locale); return <p>{fmt.format(1)}</p>; }",
		]) {
			expect(codes(web(body)), body).toContain("unsubscribed");
		}
		// 组件里的事件回调、非立刻调用的函数仍然放行;非组件函数里读 state 放行
		expect(
			web(`
export function C() {
	const onClick = () => i18n.t("a.plain");
	return <button type="button" onClick={onClick} onBlur={() => i18n.t("a.plain")} />;
}
export function plain() { return new Intl.NumberFormat(i18n.state().locale); }
`).findings,
		).toEqual([]);
	});

	it("数组方法只有第 0 个参数是立刻调用的回调;reduce 的初始值函数不是", () => {
		expect(
			serverOf('export const A = [1].reduce((acc) => acc, () => t("a.plain"));').findings,
		).toEqual([]);
		expect(
			codes(serverOf('export const B = [1].reduce((acc) => acc + t("a.plain"), "");')),
		).toContain("top-level");
	});

	it("构造器的参数属性默认值 → eager;参数装饰器 → top-level;普通参数的默认值不算", () => {
		expect(
			codes(serverOf('export class S { constructor(private label = t("a.plain")) {} }')),
		).toEqual(["eager"]);
		expect(
			codes(serverOf('export class S { constructor(@dec(t("a.plain")) a: string) {} }')),
		).toContain("top-level");
		expect(
			serverOf('export class S { constructor(a = t("a.plain")) { this.a = a; } a: string; }')
				.findings,
		).toEqual([]);
	});

	it("exportedNames:认得 export const / function / 具名转出", () => {
		const names = exportedNames(
			parseSource(
				"x.ts",
				"export const t = 1; export function useT() {} const a = 1; export { a as i18n }; const hidden = 1;",
			),
		);
		expect([...names].sort()).toEqual(["i18n", "t", "useT"]);
	});

	describe("放行名单:按文件的数目,正好相等", () => {
		const finding = (code) => ({ code, line: 1, detail: "d" });
		const unrecognised = Array.from({ length: 2 }, () => finding("unrecognised"));

		it("数目相等才放行;不在名单里的文件照报", () => {
			expect(
				applyAllowlist({ "a.ts": unrecognised }, { "a.ts": { count: 2, reason: "按码取字" } }),
			).toEqual([]);
			expect(applyAllowlist({ "a.ts": unrecognised }, {})).toHaveLength(2);
		});

		it("多了算新漏,少了算名单过期,文件没了或没有认不出的写法也算过期", () => {
			const entry = (count) => ({ "a.ts": { count, reason: "按码取字" } });
			expect(applyAllowlist({ "a.ts": unrecognised }, entry(1)).join()).toContain("多");
			expect(applyAllowlist({ "a.ts": unrecognised }, entry(3)).join()).toContain("过期");
			expect(applyAllowlist({}, entry(1)).join()).toContain("过期");
		});

		it("放行只管认不出的写法,别的问题照报;名单项必须有理由和正整数的数目", () => {
			expect(
				applyAllowlist(
					{ "a.ts": [...unrecognised, finding("values")] },
					{ "a.ts": { count: 2, reason: "按码取字" } },
				),
			).toHaveLength(1);
			expect(
				applyAllowlist({ "a.ts": unrecognised }, { "a.ts": { count: 2, reason: " " } }).join(),
			).toContain("理由");
			expect(
				applyAllowlist({ "a.ts": unrecognised }, { "a.ts": { count: 0, reason: "x" } }).join(),
			).toContain("数目");
		});
	});
});

// ---------------------------------------------------------------------------
// 扫全仓
// ---------------------------------------------------------------------------

/** 两端各自的译文入口文件本身不扫(里面的 `export const t = i18n.t` 就是定义)。 */
const STORE_FILES = Object.values(ENDS).map((end) => `${end.store}.ts`);

/** 真去扫仓库:端 → { files: 文件 → findings, calls }。 */
export function scanRepo() {
	const result = {};
	for (const [name, end] of Object.entries(ENDS)) {
		const sentences = loadSentences(end);
		const files = {};
		let calls = 0;
		for (const file of listSources([end.root])) {
			if (STORE_FILES.includes(file)) continue;
			const analysis = analyzeFile(parseSource(file), end, sentences);
			calls += analysis.calls;
			if (analysis.findings.length > 0) files[file] = analysis.findings;
		}
		result[name] = { files, calls };
	}
	return result;
}

/** 放行名单里属于这一端的文件(按路径前缀分端)。 */
const allowlistOf = (name) =>
	Object.fromEntries(
		Object.entries(ALLOWLIST).filter(([file]) => file.startsWith(`${ENDS[name].root}/`)),
	);

describe("服务端与面板的取字调用", () => {
	const scanned = scanRepo();

	for (const [name, end] of Object.entries(ENDS)) {
		it(`${name}:译文入口在,并且导出了守卫要认的名字 ${end.valueNames.join(" / ")}`, () => {
			// 入口挪了位置或改了名,所有文件的 import 都对不上,守卫会恒绿
			const entry = `${end.store}.ts`;
			expect(existsSync(join(REPO_ROOT, entry)), `${entry} 不在了`).toBe(true);
			const exported = exportedNames(parseSource(entry));
			for (const valueName of end.valueNames) {
				expect(exported.has(valueName), `${entry} 没有导出 ${valueName}`).toBe(true);
			}
		});

		it(`${name}:没有取字问题(认不出的写法按放行名单的数目对账)`, () => {
			expect(applyAllowlist(scanned[name].files, allowlistOf(name))).toEqual([]);
		});

		if (end.minCalls === 0) {
			it(`${name}:眼下零调用,豁免「至少一处」;一旦开始取字就红,逼着把豁免删掉`, () => {
				expect(scanned[name].calls, `${name} 已经开始取字:把 ENDS.${name}.minCalls 改成 1`).toBe(0);
			});
		} else {
			it(`${name}:至少扫到 ${end.minCalls} 处调用(扫空了比没有还糟)`, () => {
				expect(scanned[name].calls).toBeGreaterThanOrEqual(end.minCalls);
			});
		}
	}

	it("放行名单里的文件都在某一端的范围里(写错路径的名单项不会静默失效)", () => {
		for (const file of Object.keys(ALLOWLIST)) {
			expect(
				Object.values(ENDS).some((end) => file.startsWith(`${end.root}/`)),
				`${file} 不在任何一端的范围里`,
			).toBe(true);
		}
	});

	it("两端的译文都读得到、服务端的译文不是空的", () => {
		expect(loadSentences(ENDS.server).size).toBeGreaterThan(0);
		expect(() => loadSentences(ENDS.web)).not.toThrow();
	});
});
