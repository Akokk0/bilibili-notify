import { describe, expect, it } from "vite-plus/test";
import { auditRatchet } from "../ratchet-audit.mjs";
import {
	findNodes,
	importsOf,
	isInside,
	listSources,
	parseSource,
	resolveSpecifier,
	stripExt,
	ts,
} from "../source-scan.mjs";

/**
 * 入口咽喉:B 站的东西只能经 `compose.ts` 的「登记」进核心(ADR-0025;与 `egress-throat.test.mjs` 成对)。
 *
 * 入口与核心只从组装根 `compose.ts` 的**导出面**拿集成的东西。导出面上没有 B 站的类型、值、客户端句柄,
 * B 站的客户端就没法带着类型流进核心;核心里「装着客户端的槽位」再按文件记数、只降不涨。
 * 四条判据,各写成纯函数 + 「算 / 不算」样例(判据本身也会写错:一条永远判 OK 的规则跟没有一样):
 *
 * ① `compose.ts` 导出的声明,类型位置上不许出现集成的东西(从 `./bilibili/**`、`./platforms/**` import 进来的名字)。
 *    历史欠账按名字记上限(棘轮,两头钉),每处写明什么时候消。导出常量的初始化式是箭头函数 / 函数表达式时,
 *    形参与返回类型照函数声明看(函数体不看)。本地(没导出)的类型别名 / 接口 / 类 / 函数(形参与返回类型)/
 *    变量(类型标注)若引用了集成的名字,导出声明里用到这个本地名字(含 `typeof 本地函数`、`ReturnType<typeof 本地函数>`、
 *    本地类当载体)就记在**它引用的原名字**的账上(只传一层):把 `BiliDevtoolsDeps["api"]` 收成别名清不了账。
 *    导出的命名空间里导出的声明照导出面看,没导出的不看。
 * ② 集成的**值**在 `compose.ts` 里只能被调用、直接作调用的实参(含实参里对象 / 数组字面量的元素),
 *    或作导出常量数组的元素(设置登记)。指向集成目录的 `export … from` 一律不许;
 *    没有 `from` 的 `export { … }` / `export type { … }` 里是集成的绑定(含只作类型的)或上述本地别名也不许。上限 0。
 * ③ `BuiltinIntegrations.bilibili` 这一格的成员名集合必须正好等于名单,多了红、少了而名单没跟着改也红。
 * ④ 核心里名字正好是 `api` 的槽位按文件记数(棘轮):`engines.api` 这一片不删,守卫钉住读者名单只降。
 *
 * 判据按**解析后的路径**认「集成的东西」(与 `import-boundaries` 同一个办法),用 `source-scan` 的语法树,
 * 注释、字符串里的字样天生不是节点。不扫测试。
 *
 * 抓不到的(不装作抓得到):
 * - **换了名字的同一个句柄**:把槽位叫成 `client` / `reader`。起名带 `bili` 的由 B 站替身棘轮接住;起中立名字躲的,
 *   只有审查与 3a-42 的对拍够得着(`packages/ai` 的 `BiliReader` 就是这一类,在 `packages/` 里不在 ④ 的范围)。
 *   ④ 按名字数,不做类型检查:一个值是不是 B 站客户端它看不出来;`function f(api: Api)` 这种光秃秃的形参、
 *   局部变量 `const api = …` 它不数(传进去那一处的 `x.api` / `api:` 已经数过)。
 * - **工厂造出来的对象在 `compose.ts` 里怎么用**(`source?.dynamic()`、`problems.dispose()`、`icons.refs()`):不拦,
 *   拦了全是合理的例外,而它们流不出 `compose.ts`(出口由 ①、③ 管)。
 * - **`compose.ts` 里长出登记以外的逻辑**:靠审查。
 * - ① 只看**显式写出来的类型**:导出函数 / 常量不写类型标注、靠推断带出集成类型的,① 看不见;
 *   `export { x }` 这种列表式导出的本地声明里,集成的绑定、本地别名 / 类 / 函数 / 变量(带着集成的名字的)由 ② 接住,解构导出不追;
 *   导出常量的初始化式里,除了「初始化式本身是箭头函数 / 函数表达式」(看形参与返回类型)之外都不看:
 *   `as unknown as Api`、`satisfies Partial<Api>`、对象字面量里的函数、类属性里的断言。
 *   本地别名只传一层(`type A = Api; type B = A;` 之后导出里写 `B`,抓不到);别名只认没导出的 type / interface / 类 / 函数 / 变量
 *   (导出的别名在声明处已记过;本地函数只看形参与返回类型、变量只看类型标注,靠推断带出去的看不见)。② 把 `as` / `satisfies` / 括号当透明;
 *   `class X extends 工厂()` 的 `extends` 位被当类型位置放过。同名局部变量遮住集成名字,判据按名字对,会误判或漏判。
 * - ③ 只认字面量写法的 `bilibili` 成员;换成别处声明的类型引用会被点名「看不到成员」,而不是悄悄放过。
 * - 新开一个文件当「第二个组装根」:本守卫只看 `compose.ts`;别的核心文件越界 import 集成目录归 `import-boundaries`。
 */

export const COMPOSE_FILE = "apps/server/src/compose.ts";
/** 集成目录:里面的东西是「集成的东西」。 */
export const INTEGRATION_DIRS = ["apps/server/src/bilibili", "apps/server/src/platforms"];

/**
 * ① 的记账:名字 → 上限与什么时候消。
 * 同一个名字在导出类型里出现几次记几处(`BiliDevtoolsDeps["api"]` 一次)。
 */
export const EXPORTED_TYPE_LEDGER = {
	BiliDevtoolsDeps: {
		limit: 4,
		until:
			"开发场景今天仍直接用引擎、套了壳的 Api / 登录系统(api、auth、live、fans、healthCheck 五个过渡句柄);3b 场景改成只经 B 站自己的上下文时消",
	},
	DevtoolsProviderRegistry: {
		limit: 1,
		until:
			"核心 devtools 的类型,只因 devtools-isolation 不许 compose.ts 引核心的 devtools/ 才从 B 站 devtools 入口转出;随开发场景的过渡句柄一起消",
	},
};

/** ③ 的名单:`BuiltinIntegrations.bilibili` 这一格的成员名。清空之后连这一格一起删。 */
export const BILIBILI_MEMBERS = [];

/** ④ 的范围与不扫的目录。 */
export const SLOT_ROOTS = ["apps/server/src"];
export const SLOT_SKIP_DIRS = [
	"apps/server/src/bilibili",
	"apps/server/src/platforms",
	// 开发壳(`overridableApi`)自己的实现,不是读者
	"apps/server/src/devtools",
];

/**
 * ④ 的棘轮:文件 → `api` 槽位的处数。只许降不许涨:一个读者消失就当场调低,清零了整行删掉。
 * 今天里面全是 B 站接口客户端的槽位或开发壳的杂音:`index.ts` 的 `devAuth.api` 是套了壳的登录口、不是接口客户端,
 * 不为它加例外(它同样是「B 站的东西经入口递出去」,随登录装配一起走,3b)。
 */
export const API_SLOT_RATCHET = {
	"apps/server/src/app.ts": 3, // 卡片预览的 `api`(属性签名、`api:` 与 `options.api`);第 4 期卡片真实预览改口时消
	"apps/server/src/index.ts": 7, // 登录装配的产物经入口递出去(套壳、引擎、createApp);含 `devAuth.api` 杂音;3b 登录装配进集成时消。3b-28 链接预览的门改问登记表(13 → 11);3b-39-6 删抓图服务(11 → 10);3b-24-10b 删粉丝轮询(10 → 7)
	"apps/server/src/routes/ai.ts": 2, // 锐评生成拿 `engines.api`;3b `AiToolProvider` 时消
	"apps/server/src/routes/cards.ts": 12, // 卡片真实预览;第 4 期消
	"apps/server/src/routes/subscriptions.ts": 5, // 旧搜人两口;第 4 期消
	"apps/server/src/runtime/engines.ts": 8, // `EnginesRuntime.api` 与粉丝轮询 / 关注同步 / 链接解析的递法;3b 随读者清掉
	"apps/server/src/runtime/follow-sync.ts": 3, // 关注同步;3b
	"apps/server/src/stats/roast-generate.ts": 2, // 锐评生成;3b `AiToolProvider`
};

// ---------------------------------------------------------------------------
// 共用:认「集成的东西」
// ---------------------------------------------------------------------------

/** 说明符是不是解析进了集成目录。 */
function pointsIntoIntegration(file, specifier, dirs = INTEGRATION_DIRS) {
	const resolved = resolveSpecifier(file, specifier);
	if (resolved === undefined) return false;
	return dirs.some((dir) => isInside(stripExt(resolved), dir));
}

const lineOf = (source, node) =>
	source.ast.getLineAndCharacterOfPosition(node.getStart(source.ast)).line + 1;

/**
 * 一份源码里从集成目录 import 进来的本地名字。
 *
 * @returns `Map<本地名字, { typeOnly: boolean }>`;`typeOnly` 为真的名字不可能当值用
 */
export function integrationBindings(file, source, dirs = INTEGRATION_DIRS) {
	const bindings = new Map();
	for (const node of source.ast.statements) {
		if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
		if (!pointsIntoIntegration(file, node.moduleSpecifier.text, dirs)) continue;
		const clause = node.importClause;
		if (!clause) continue;
		const clauseTypeOnly = clause.phaseModifier === ts.SyntaxKind.TypeKeyword;
		if (clause.name) bindings.set(clause.name.text, { typeOnly: clauseTypeOnly });
		const named = clause.namedBindings;
		if (!named) continue;
		if (ts.isNamespaceImport(named)) {
			bindings.set(named.name.text, { typeOnly: clauseTypeOnly });
		} else {
			for (const element of named.elements) {
				bindings.set(element.name.text, { typeOnly: clauseTypeOnly || element.isTypeOnly });
			}
		}
	}
	return bindings;
}

/** `A.B.C` / `a.b` 的最左边那个标识符。 */
function leftmost(node) {
	let current = node;
	for (;;) {
		if (ts.isQualifiedName(current)) current = current.left;
		else if (ts.isPropertyAccessExpression(current)) current = current.expression;
		else return ts.isIdentifier(current) ? current : undefined;
	}
}

const isExported = (node) =>
	ts.canHaveModifiers(node) &&
	(ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

/**
 * 这个节点若是一处「类型位置上的引用」,给出落点与它代表的集成的名字(`resolve` 把本地名字译成集成的名字,不是集成的给空数组)。
 * 类型引用(含 `X["k"]` 里的 X、泛型实参)、`typeof X`、接口 / 类的 `extends`、`import("…").T`。
 *
 * @returns `{ at, names } | undefined`
 */
function typeRefOf(node, resolve, file, dirs) {
	let id;
	if (ts.isTypeReferenceNode(node)) id = leftmost(node.typeName);
	else if (ts.isTypeQueryNode(node)) id = leftmost(node.exprName);
	else if (ts.isExpressionWithTypeArguments(node)) id = leftmost(node.expression);
	else if (ts.isImportTypeNode(node)) {
		const arg = node.argument;
		const specifier =
			ts.isLiteralTypeNode(arg) && ts.isStringLiteral(arg.literal) ? arg.literal.text : undefined;
		return specifier !== undefined && pointsIntoIntegration(file, specifier, dirs)
			? { at: node, names: [specifier] }
			: undefined;
	}
	const names = id ? resolve(id.text) : [];
	return names.length > 0 ? { at: id, names } : undefined;
}

/** 导出常量的初始化式剥掉括号 / as / satisfies / 非空断言之后,若是箭头函数或函数表达式就给出它。 */
function functionInitializer(init) {
	let current = init;
	while (
		ts.isParenthesizedExpression(current) ||
		ts.isAsExpression(current) ||
		ts.isSatisfiesExpression(current) ||
		ts.isNonNullExpression(current)
	) {
		current = current.expression;
	}
	return ts.isArrowFunction(current) || ts.isFunctionExpression(current) ? current : undefined;
}

/**
 * 一个声明里「类型位置上」的引用,逐个交给 `visit`:函数体(块)、`body`、变量与属性的初始化式是值,不看;
 * 初始化式本身是箭头函数 / 函数表达式的,形参与返回类型照函数声明看。
 */
function walkTypePositions(root, visit) {
	const walk = (node) => {
		visit(node);
		ts.forEachChild(node, (child) => {
			if (ts.isBlock(child) || child === node.body) return;
			if (child === node.initializer) {
				const fn = ts.isVariableDeclaration(node) ? functionInitializer(child) : undefined;
				if (fn) walk(fn);
				return;
			}
			walk(child);
		});
	};
	walk(root);
}

/**
 * 本地(没导出)的声明里直接引用了集成的名字的:`Map<本地名字, 集成的名字[]>`。本地声明 = 类型别名、接口、类、
 * 函数(形参与返回类型)、变量(类型标注;初始化式是函数的看形参与返回类型)。后三种是 `ReturnType<typeof 本地函数>`、
 * 本地类当载体这类写法的出口。只传一层:别名的别名抓不到(文件头写明)。
 * 导出的声明不算 —— 它在声明处已经被 ① 记过,用到它的地方再记会重复。
 */
export function integrationAliases(file, source, dirs = INTEGRATION_DIRS) {
	const bindings = integrationBindings(file, source, dirs);
	const resolve = (name) => (bindings.has(name) ? [name] : []);
	const aliases = new Map();
	const record = (name, root) => {
		const names = new Set();
		walkTypePositions(root, (node) => {
			for (const n of typeRefOf(node, resolve, file, dirs)?.names ?? []) names.add(n);
		});
		if (names.size > 0) aliases.set(name, [...names]);
	};
	for (const statement of source.ast.statements) {
		if (isExported(statement)) continue;
		if (
			ts.isTypeAliasDeclaration(statement) ||
			ts.isInterfaceDeclaration(statement) ||
			ts.isClassDeclaration(statement) ||
			ts.isFunctionDeclaration(statement)
		) {
			if (statement.name) record(statement.name.text, statement);
		} else if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				if (ts.isIdentifier(declaration.name)) record(declaration.name.text, declaration);
			}
		}
	}
	return aliases;
}

// ---------------------------------------------------------------------------
// ① 导出声明的类型位置上不许出现集成的东西
// ---------------------------------------------------------------------------

/**
 * `compose.ts` 里每个带 `export` 的声明,类型位置上出现的集成的东西,一个标识符一处。
 * 类型位置 = 类型引用(含 `typeof X`、`X["k"]` 里的 X、泛型实参)、接口 / 类的 `extends`、`import("…").T`;
 * 函数体、变量与属性的初始化式、形参默认值是值,不看。
 *
 * @returns `{ line, text }[]`,`text` 是那个集成的名字
 */
export function exportedTypeUses(file, source, dirs = INTEGRATION_DIRS) {
	const bindings = integrationBindings(file, source, dirs);
	const aliases = integrationAliases(file, source, dirs);
	const hits = [];
	const hit = (node, name) => hits.push({ line: lineOf(source, node), text: name });
	// 名字 → 它代表的集成的名字:集成自己的绑定就是它自己,本地别名记在它引用的原名字上
	const resolve = (name) => (bindings.has(name) ? [name] : (aliases.get(name) ?? []));

	const visit = (node) => {
		const ref = typeRefOf(node, resolve, file, dirs);
		if (ref) for (const name of ref.names) hit(ref.at, name);
		ts.forEachChild(node, (child) => {
			if (ts.isBlock(child)) return;
			if (child === node.initializer) {
				// 导出常量的初始化式是箭头函数 / 函数表达式:形参与返回类型照函数声明看,函数体仍不看
				const fn = ts.isVariableDeclaration(node) ? functionInitializer(child) : undefined;
				if (fn) visit(fn);
				return;
			}
			if (child === node.body) {
				// 导出的命名空间的体:里面导出的声明照导出面看,没导出的不看(函数体是 Block,仍不看)
				if (ts.isModuleDeclaration(node) && child && ts.isModuleBlock(child)) {
					for (const inner of child.statements) if (isExported(inner)) visit(inner);
				}
				return;
			}
			visit(child);
		});
	};

	for (const statement of source.ast.statements) {
		if (isExported(statement)) visit(statement);
	}
	return hits;
}

/** 按名字归拢成 `{ [名字]: { line, text }[] }`,喂给 `auditRatchet`。 */
const groupByText = (hits) => {
	const found = {};
	for (const h of hits) {
		found[h.text] = [...(found[h.text] ?? []), h];
	}
	return found;
};

/** ① 的对账。 */
export function auditExportedTypes(file, source, ledger = EXPORTED_TYPE_LEDGER) {
	return auditRatchet(groupByText(exportedTypeUses(file, source)), {
		allowlist: {},
		ratchet: Object.fromEntries(Object.entries(ledger).map(([name, { limit }]) => [name, limit])),
		what: "导出类型里的集成类型",
	});
}

// ---------------------------------------------------------------------------
// ② 集成的值只能被调用 / 直接作参数
// ---------------------------------------------------------------------------

const isWrapper = (node) =>
	ts.isParenthesizedExpression(node) ||
	ts.isAsExpression(node) ||
	ts.isSatisfiesExpression(node) ||
	ts.isNonNullExpression(node);

/** 这个节点是不是在类型位置(类型节点内部,或接口 `extends` / 类 `implements`)。 */
function inTypePosition(node) {
	for (let current = node.parent; current; current = current.parent) {
		if (ts.isExpressionWithTypeArguments(current)) {
			const clause = current.parent;
			if (
				clause &&
				ts.isHeritageClause(clause) &&
				(ts.isInterfaceDeclaration(clause.parent) ||
					clause.token === ts.SyntaxKind.ImplementsKeyword)
			) {
				return true;
			}
			continue;
		}
		if (ts.isTypeNode(current)) return true;
	}
	return false;
}

/** 这个标识符是不是只是在「叫名字」(属性名、声明名、import 里的名字),不是对值的引用。 */
function isNameOnly(id) {
	const parent = id.parent;
	if (!parent) return false;
	if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) {
		return true;
	}
	if (ts.isPropertyAccessExpression(parent)) return parent.name === id;
	if (ts.isQualifiedName(parent)) return parent.right === id;
	if (ts.isPropertyAssignment(parent)) return parent.name === id;
	if (
		ts.isMethodDeclaration(parent) ||
		ts.isPropertyDeclaration(parent) ||
		ts.isPropertySignature(parent) ||
		ts.isMethodSignature(parent) ||
		ts.isGetAccessorDeclaration(parent) ||
		ts.isSetAccessorDeclaration(parent) ||
		ts.isEnumMember(parent) ||
		ts.isParameter(parent) ||
		ts.isVariableDeclaration(parent) ||
		ts.isFunctionDeclaration(parent) ||
		ts.isClassDeclaration(parent) ||
		ts.isTypeAliasDeclaration(parent) ||
		ts.isInterfaceDeclaration(parent)
	) {
		return parent.name === id;
	}
	if (ts.isBindingElement(parent)) return parent.name === id || parent.propertyName === id;
	return false;
}

/** 一个值的引用是不是登记写法:被调用 / 直接作实参 / 实参里字面量的元素 / 导出常量数组的元素。 */
function isRegistrationUse(id) {
	const direct = id.parent;
	if ((ts.isCallExpression(direct) || ts.isNewExpression(direct)) && direct.expression === id) {
		return true;
	}
	// 往外爬:属性值 → 对象字面量 → 数组字面量 → (as / 括号) …,直到碰到调用的实参;爬到别的东西就不是登记写法。
	let node = id;
	for (;;) {
		const parent = node.parent;
		if (!parent) return false;
		if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
			return (parent.arguments ?? []).includes(node);
		}
		if (ts.isArrayLiteralExpression(parent) && node === id && isExportedConstInitializer(parent)) {
			return true;
		}
		const passThrough =
			(ts.isPropertyAssignment(parent) && parent.initializer === node) ||
			ts.isShorthandPropertyAssignment(parent) ||
			ts.isObjectLiteralExpression(parent) ||
			ts.isArrayLiteralExpression(parent) ||
			isWrapper(parent);
		if (!passThrough) return false;
		node = parent;
	}
}

/** 这个节点(剥掉 as / satisfies / 括号之后)是不是 `export const X = <它>` 的初始化式。 */
function isExportedConstInitializer(node) {
	let current = node;
	while (current.parent && isWrapper(current.parent)) current = current.parent;
	const declaration = current.parent;
	if (
		!declaration ||
		!ts.isVariableDeclaration(declaration) ||
		declaration.initializer !== current
	) {
		return false;
	}
	const list = declaration.parent;
	const statement = list?.parent;
	return (
		!!list &&
		!!statement &&
		ts.isVariableStatement(statement) &&
		(list.flags & ts.NodeFlags.Const) !== 0 &&
		isExported(statement)
	);
}

/**
 * `compose.ts` 里集成的值不合「登记」写法的地方。
 *
 * @returns `{ line, text }[]`
 */
export function misusedValues(file, source, dirs = INTEGRATION_DIRS) {
	const hits = [];
	const bindings = integrationBindings(file, source, dirs);
	const aliases = integrationAliases(file, source, dirs);
	const values = new Set([...bindings].filter(([, b]) => !b.typeOnly).map(([name]) => name));
	// 没有 `from` 的 `export { … }` / `export type { … }`:名字是集成的绑定(含只作类型的)或本地别名就是「转出去」。
	// 值的绑定上面按标识符已经记过一处,这里只补只作类型的与别名。
	for (const statement of source.ast.statements) {
		if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier) continue;
		const clause = statement.exportClause;
		if (!clause || !ts.isNamedExports(clause)) continue;
		for (const element of clause.elements) {
			const local = (element.propertyName ?? element.name).text;
			if (values.has(local)) continue;
			if (bindings.has(local) || aliases.has(local)) {
				hits.push({ line: lineOf(source, element), text: local });
			}
		}
	}
	if (values.size > 0) {
		const visit = (node) => {
			if (ts.isIdentifier(node) && values.has(node.text)) {
				const skip = isNameOnly(node) || inTypePosition(node) || isRegistrationUse(node);
				if (!skip) hits.push({ line: lineOf(source, node), text: node.text });
			}
			ts.forEachChild(node, visit);
		};
		for (const statement of source.ast.statements) {
			if (ts.isImportDeclaration(statement)) continue;
			visit(statement);
		}
	}
	// 指向集成目录的 export … from、值的动态 import / require、副作用 import:都是「转出去 / 绕开登记」。
	for (const ref of importsOf(source)) {
		if (!pointsIntoIntegration(file, ref.specifier, dirs)) continue;
		const bad =
			ref.kind === "export" ||
			ref.kind === "require" ||
			ref.kind === "side-effect" ||
			(ref.kind === "dynamic" && !ref.typeOnly);
		if (bad) hits.push({ line: ref.line, text: `${ref.kind} ${ref.specifier}` });
	}
	return hits;
}

/** ② 的对账:上限 0。 */
export function auditMisusedValues(file, source) {
	const hits = misusedValues(file, source);
	return auditRatchet(hits.length > 0 ? { [file]: hits } : {}, {
		allowlist: {},
		ratchet: {},
		what: "集成的值不是登记写法(只许被调用 / 直接作参数)",
	});
}

// ---------------------------------------------------------------------------
// ③ BuiltinIntegrations.bilibili 的成员只许少
// ---------------------------------------------------------------------------

/**
 * `BuiltinIntegrations`(接口或类型别名)里名为 `bilibili` 的属性的成员名。
 *
 * @returns `undefined` = 没有这个属性;`null` = 有但类型不是字面量(看不到成员);否则成员名数组
 */
export function bilibiliMembersOf(source) {
	const members = [];
	for (const statement of source.ast.statements) {
		if (ts.isInterfaceDeclaration(statement) && statement.name.text === "BuiltinIntegrations") {
			members.push(...statement.members);
		} else if (
			ts.isTypeAliasDeclaration(statement) &&
			statement.name.text === "BuiltinIntegrations" &&
			ts.isTypeLiteralNode(statement.type)
		) {
			members.push(...statement.type.members);
		}
	}
	const nameOf = (member) =>
		member.name && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))
			? member.name.text
			: undefined;
	const prop = members.find(
		(member) => ts.isPropertySignature(member) && nameOf(member) === "bilibili",
	);
	if (!prop) return undefined;
	if (!prop.type || !ts.isTypeLiteralNode(prop.type)) return null;
	return prop.type.members.map((member) => nameOf(member) ?? member.getText(source.ast));
}

/** ③ 的对账:成员名集合必须正好等于名单(顺序不论);名单空了 = 这一格不该再有。 */
export function auditBilibiliMembers(source, expected = BILIBILI_MEMBERS) {
	const actual = bilibiliMembersOf(source);
	if (actual === null) {
		return [
			"BuiltinIntegrations.bilibili 的类型不是字面量,看不到成员 —— 写成字面量,或把这一格删掉",
		];
	}
	if (actual === undefined) {
		return expected.length === 0
			? []
			: [
					`BuiltinIntegrations 里没有 bilibili 这一格,名单还写着 [${expected.join(", ")}] —— 把名单清空`,
				];
	}
	if (expected.length === 0) {
		return ["名单已空:BuiltinIntegrations.bilibili 这一格该整个删掉(判据改成「没有 bilibili」)"];
	}
	const problems = [];
	for (const name of actual) {
		if (!expected.includes(name)) {
			problems.push(
				`BuiltinIntegrations.bilibili 多了成员 ${name} —— 只许少不许多(别把句柄递给入口)`,
			);
		}
	}
	for (const name of expected) {
		if (!actual.includes(name)) {
			problems.push(
				`BuiltinIntegrations.bilibili 已经没有成员 ${name},名单还写着 —— 把它从名单里删掉`,
			);
		}
	}
	return problems;
}

// ---------------------------------------------------------------------------
// ④ 核心里 `api` 槽位按文件记数
// ---------------------------------------------------------------------------

const isApiName = (node) =>
	!!node &&
	((ts.isIdentifier(node) && node.text === "api") ||
		(ts.isStringLiteral(node) && node.text === "api"));

/**
 * 一份源码里名字正好是 `api` 的槽位:属性访问 `x.api`(`this.api` 不算)、`x["api"]`、对象字面量里的 `api: …` 与简写 `api`、
 * 接口 / 类型字面量里的 `api` 属性签名、解构里的 `api`、类的 `api` 属性声明。
 *
 * @returns `{ line, text }[]`
 */
export function apiSlots(source) {
	return findNodes(source, (node) => {
		if (ts.isPropertyAccessExpression(node)) {
			return node.name.text === "api" && node.expression.kind !== ts.SyntaxKind.ThisKeyword;
		}
		if (ts.isElementAccessExpression(node)) {
			return (
				ts.isStringLiteral(node.argumentExpression) &&
				node.argumentExpression.text === "api" &&
				node.expression.kind !== ts.SyntaxKind.ThisKeyword
			);
		}
		if (ts.isPropertyAssignment(node)) return isApiName(node.name);
		if (ts.isShorthandPropertyAssignment(node)) return node.name.text === "api";
		if (ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) return isApiName(node.name);
		if (ts.isBindingElement(node)) return isApiName(node.propertyName ?? node.name);
		return false;
	}).map(({ line, text }) => ({ line, text }));
}

/** ④ 的对账:按文件对棘轮表(表外 = 上限 0,两头钉)。 */
export function auditApiSlots(sources, ratchet = API_SLOT_RATCHET) {
	const found = {};
	for (const [file, source] of Object.entries(sources)) {
		const hits = apiSlots(source);
		if (hits.length > 0) found[file] = hits;
	}
	return auditRatchet(found, { allowlist: {}, ratchet, what: "核心里的 api 槽位" });
}

/** ④ 扫哪些文件(与 `import-boundaries` 同范围,另不扫开发壳目录)。 */
export function slotFiles() {
	return listSources(SLOT_ROOTS).filter(
		(file) => file !== COMPOSE_FILE && !SLOT_SKIP_DIRS.some((dir) => isInside(file, dir)),
	);
}

// ---------------------------------------------------------------------------
// 样例:算 / 不算
// ---------------------------------------------------------------------------

const IMPORTS = [
	`import type { Api } from "./bilibili/api/index.js";`,
	`import { type BiliSource, createBiliSource } from "./bilibili/source.js";`,
	`import type { BiliDevtoolsDeps } from "./bilibili/devtools/index.js";`,
	`import { settingsSegment } from "./bilibili/settings.js";`,
	`import { IMAGE_REQUEST_HEADERS } from "./bilibili/images.js";`,
	`import { createOnebotAdapter } from "./platforms/onebot.js";`,
	`import type { SourceAuth } from "@bilibili-notify/internal";`,
	`import type { Neutral } from "./images/neutral.js";`,
].join("\n");

const compose = (body) => parseSource(COMPOSE_FILE, `${IMPORTS}\n${body}`);
/** 样例里的行号要减去 import 头的行数。 */
const HEAD = IMPORTS.split("\n").length;
const typeNames = (body) =>
	exportedTypeUses(COMPOSE_FILE, compose(body)).map((h) => `${h.text}:${h.line - HEAD}`);
const misused = (body) =>
	misusedValues(COMPOSE_FILE, compose(body)).map((h) => `${h.text}:${h.line - HEAD}`);

describe("① 导出类型里的集成类型:算", () => {
	it("接口成员、函数返回类型、typeof、索引访问、泛型实参都算", () => {
		expect(typeNames(`export interface X { a: Api }`)).toEqual(["Api:1"]);
		expect(typeNames(`export function f(): BiliSource { throw 1; }`)).toEqual(["BiliSource:1"]);
		expect(typeNames(`export type T = Parameters<typeof createBiliSource>[0];`)).toEqual([
			"createBiliSource:1",
		]);
		expect(typeNames(`export interface X { a: BiliDevtoolsDeps["api"] }`)).toEqual([
			"BiliDevtoolsDeps:1",
		]);
		expect(typeNames(`export interface X { a: Pick<Api, "x">; b: Map<string, Api> }`)).toEqual([
			"Api:1",
			"Api:1",
		]);
	});

	it("函数的形参类型、导出常量的类型标注、接口 extends 也算;`import(…)` 类型按说明符算", () => {
		expect(typeNames(`export function f(a: Api, b: number): void {}`)).toEqual(["Api:1"]);
		expect(typeNames(`export const x: Api | undefined = undefined;`)).toEqual(["Api:1"]);
		expect(typeNames(`export interface X extends Pick<BiliDevtoolsDeps, "api"> {}`)).toEqual([
			"BiliDevtoolsDeps:1",
		]);
		expect(typeNames(`export type T = import("./bilibili/api/index.js").Api;`)).toEqual([
			"./bilibili/api/index.js:1",
		]);
	});
});

describe("① 导出常量的初始化式是函数:形参与返回类型照函数声明看", () => {
	it("箭头函数、函数表达式的形参与返回类型算,函数体与表达式体不算", () => {
		expect(typeNames(`export const f = (a: Api): string => "";`)).toEqual(["Api:1"]);
		expect(typeNames(`export const g = function (a: Api): BiliSource { throw 1; };`)).toEqual([
			"Api:1",
			"BiliSource:1",
		]);
		expect(typeNames(`export const h = (): void => {\n\tlet s: Api;\n};`)).toEqual([]);
		expect(typeNames(`export const k = () => ({}) as Api;`)).toEqual([]);
		expect(typeNames(`export const m = ((a: Api): void => {}) satisfies unknown;`)).toEqual([
			"Api:1",
		]);
	});

	it("没导出的常量、初始化式不是函数的常量照旧不看", () => {
		expect(typeNames(`const f = (a: Api): string => "";`)).toEqual([]);
		expect(typeNames(`export const o = { f: (a: Api): void => {} };`)).toEqual([]);
	});
});

describe("① 本地的类型别名 / 接口引用了集成的名字:传一层,记在原名字的账上", () => {
	it("经别名用到集成的名字,记成原名字(别名本身不是账上的名字)", () => {
		expect(
			typeNames(`type DevDeps = BiliDevtoolsDeps;\nexport interface X { a: DevDeps["api"] }`),
		).toEqual(["BiliDevtoolsDeps:2"]);
		expect(
			typeNames(
				`interface L extends Pick<BiliDevtoolsDeps, "api"> {}\nexport function f(a: L): void {}`,
			),
		).toEqual(["BiliDevtoolsDeps:2"]);
		expect(
			typeNames(
				`type Both = Pick<Api, "x"> & BiliSource;\nexport const x: Both | undefined = undefined;`,
			),
		).toEqual(["Api:2", "BiliSource:2"]);
	});

	it("别名声明本身不记;导出的别名只在声明处记一次、用到它的地方不重复记", () => {
		expect(typeNames(`type D = Api;`)).toEqual([]);
		expect(typeNames(`export type A = Api;\nexport interface X { a: A }`)).toEqual(["Api:1"]);
	});

	it("两层以上的传递抓不到(文件头写明)", () => {
		expect(typeNames(`type A = Api;\ntype B = A;\nexport interface X { a: B }`)).toEqual([]);
	});

	it("把原来的写法全换成别名,记账不变", () => {
		const ledger = { BiliDevtoolsDeps: { limit: 2, until: "样例" } };
		const body = [
			`type D = BiliDevtoolsDeps;`,
			`export interface X { a: BiliDevtoolsDeps["api"]; b: D["api"] }`,
		].join("\n");
		expect(auditExportedTypes(COMPOSE_FILE, compose(body), ledger)).toEqual([]);
		const allAliased = [
			`type D = BiliDevtoolsDeps;`,
			`export interface X { a: D["api"]; b: D["auth"] }`,
		].join("\n");
		expect(auditExportedTypes(COMPOSE_FILE, compose(allAliased), ledger)).toEqual([]);
	});
});

describe("① 本地的函数 / 变量 / 类、导出的命名空间里带着集成的名字:同样传一层", () => {
	it("`ReturnType<typeof 本地函数>` 与 `typeof 本地变量`:函数的形参与返回类型、变量的类型标注记在原名字的账上", () => {
		expect(
			typeNames(
				`function clientOf(): Api { throw 1; }\nexport type BuiltinClient = ReturnType<typeof clientOf>;`,
			),
		).toEqual(["Api:2"]);
		expect(
			typeNames(`function useApi(a: Api): void {}\nexport type P = Parameters<typeof useApi>;`),
		).toEqual(["Api:2"]);
		expect(
			typeNames(`const held: Api | undefined = undefined;\nexport type H = typeof held;`),
		).toEqual(["Api:2"]);
		expect(
			typeNames(
				`const make = (): BiliSource => { throw 1; };\nexport type M = ReturnType<typeof make>;`,
			),
		).toEqual(["BiliSource:2"]);
	});

	it("本地的类当载体:类身上写着集成的类型,导出里用到这个类就记账", () => {
		expect(
			typeNames(
				[
					`class ClientBox { constructor(readonly client: Api) {} }`,
					`export function boxOf(box: ClientBox): ClientBox { throw 1; }`,
				].join("\n"),
			),
		).toEqual(["Api:2", "Api:2"]);
		expect(typeNames(`class Holder { api?: Api; }\nexport interface X { h: Holder }`)).toEqual([
			"Api:2",
		]);
	});

	it("导出的命名空间:里面导出的声明照导出面看,没导出的不看", () => {
		expect(typeNames(`export namespace Throat { export type Client = Api; }`)).toEqual(["Api:1"]);
		expect(
			typeNames(
				`export namespace Outer {\n\texport namespace Inner { export function f(a: BiliSource): void {} }\n}`,
			),
		).toEqual(["BiliSource:2"]);
		expect(typeNames(`export namespace N { type Hidden = Api; export type Ok = number; }`)).toEqual(
			[],
		);
	});

	it("这几类的函数体、初始化式里的类型标注不算", () => {
		expect(
			typeNames(`function f() { let a: Api; return 1; }\nexport type T = ReturnType<typeof f>;`),
		).toEqual([]);
		expect(typeNames(`class K { f() { let a: Api; } }\nexport function g(k: K): void {}`)).toEqual(
			[],
		);
		expect(typeNames(`export namespace N { export function f() { let a: Api; } }`)).toEqual([]);
	});

	it("没有 from 的 export { 本地函数 / 本地类 }:函数与类带着集成的名字就算(②)", () => {
		expect(misused(`function f(a: Api): void {}\nexport { f };`)).toEqual(["f:2"]);
		expect(misused(`class C { api?: Api }\nexport { C };`)).toEqual(["C:2"]);
		expect(misused(`function g(): number { return 1; }\nexport { g };`)).toEqual([]);
	});
});

describe("① 导出类型里的集成类型:不算", () => {
	it("函数体里的局部类型标注、注释、没导出的声明", () => {
		expect(
			typeNames(
				[
					`export function f(): void {`,
					`	let source: BiliSource | undefined;`,
					`	const a = createBiliSource as unknown as Api;`,
					`}`,
					`// export interface X { a: Api }`,
					`interface Local { a: Api }`,
				].join("\n"),
			),
		).toEqual([]);
	});

	it("从别处来的中立类型、初始化式里的值", () => {
		expect(
			typeNames(
				[
					`export interface X { a: SourceAuth; b: Neutral }`,
					`export const y = createBiliSource;`,
					`export const z: readonly Neutral[] = [settingsSegment];`,
				].join("\n"),
			),
		).toEqual([]);
	});
});

describe("① 的对账:按名字记上限,两头钉", () => {
	const ledger = { Api: { limit: 1, until: "样例" } };
	const audit = (body) => auditExportedTypes(COMPOSE_FILE, compose(body), ledger);

	it("实数等于上限:通过;多了红;少了也红;表外的名字红", () => {
		expect(audit(`export interface X { a: Api }`)).toEqual([]);
		expect(audit(`export interface X { a: Api; b: Api }`)[0]).toContain("超过棘轮上限 1");
		expect(audit(`export interface X { a: number }`)).toEqual([
			"Api: 实数 0,上限还写着 1 —— 把这一行从棘轮表里删掉",
		]);
		expect(audit(`export interface X { a: Api; b: BiliSource }`)[0]).toContain("BiliSource:");
	});
});

describe("② 集成的值只能被调用 / 直接作参数:算(红)", () => {
	it("另存一个名字、放进返回对象、从别处转出", () => {
		expect(misused(`const make = createBiliSource;`)).toEqual(["createBiliSource:1"]);
		expect(misused(`export function f() {\n\treturn { createBiliSource };\n}`)).toEqual([
			"createBiliSource:2",
		]);
		expect(misused(`const s = settingsSegment;`)).toEqual(["settingsSegment:1"]);
		expect(misused(`export { createBiliSource } from "./bilibili/source.js";`)).toEqual([
			"createBiliSource:1",
			"export ./bilibili/source.js:1",
		]);
	});

	it("export type … from、本地 export 列表、动态 import、副作用 import 都算", () => {
		expect(misused(`export type { Api } from "./bilibili/api/index.js";`)).toEqual([
			"export ./bilibili/api/index.js:1",
		]);
		expect(misused(`export { settingsSegment };`)).toEqual(["settingsSegment:1"]);
		expect(misused(`const m = await import("./platforms/onebot.js");`)).toEqual([
			"dynamic ./platforms/onebot.js:1",
		]);
		expect(misused(`import "./bilibili/x.js";`)).toEqual(["side-effect ./bilibili/x.js:1"]);
	});

	it("没有 from 的 export { … } / export type { … }:里面是集成的名字(含只作类型的、改名的、本地别名)就算", () => {
		expect(misused(`export type { Api };`)).toEqual(["Api:1"]);
		expect(misused(`export { type Api };`)).toEqual(["Api:1"]);
		expect(misused(`export type { Api, BiliSource as S };`)).toEqual(["Api:1", "BiliSource:1"]);
		expect(misused(`type DevDeps = BiliDevtoolsDeps;\nexport type { DevDeps };`)).toEqual([
			"DevDeps:2",
		]);
		// 值的绑定只记一处(不因为多加了一条判据变成两处)
		expect(misused(`export { settingsSegment, type Api };`).sort()).toEqual([
			"Api:1",
			"settingsSegment:1",
		]);
	});

	it("没有 from 的导出列表里是中立的名字:不算", () => {
		expect(misused(`const x = 1;\nexport { x };\nexport type { Neutral, SourceAuth };`)).toEqual(
			[],
		);
	});

	it("在被调者之外的位置:赋值给对象再返回、数组不是导出常量、`.call` 绕开", () => {
		expect(misused(`const xs = [settingsSegment];`)).toEqual(["settingsSegment:1"]);
		expect(misused(`createBiliSource.call(null, {});`)).toEqual(["createBiliSource:1"]);
		expect(misused(`const o = { f: createBiliSource };`)).toEqual(["createBiliSource:1"]);
	});
});

describe("② 集成的值只能被调用 / 直接作参数:不算(放行)", () => {
	it("被调用、直接作实参、实参对象里的值、new 的实参", () => {
		expect(misused(`createBiliSource({ a: 1 });`)).toEqual([]);
		expect(misused(`f({ headers: IMAGE_REQUEST_HEADERS });`)).toEqual([]);
		expect(misused(`f(settingsSegment);`)).toEqual([]);
		expect(misused(`new HttpClient({ headers: IMAGE_REQUEST_HEADERS });`)).toEqual([]);
		expect(misused(`f({ headers: { ...x, h: IMAGE_REQUEST_HEADERS } });`)).toEqual([]);
		expect(misused(`const adapters = [createOnebotAdapter({})];`)).toEqual([]);
	});

	it("导出常量数组的元素(设置登记);类型位置归 ① 管、这里不记", () => {
		expect(misused(`export const X = [settingsSegment];`)).toEqual([]);
		expect(misused(`export const X: readonly Neutral[] = [settingsSegment] as const;`)).toEqual([]);
		expect(misused(`let source: BiliSource | undefined;`)).toEqual([]);
		expect(misused(`type T = typeof createBiliSource;`)).toEqual([]);
	});

	it("同名的属性名、注释与字符串里的字样", () => {
		expect(
			misused(
				[
					`const o = { settingsSegment: 1 };`,
					`const p = o.createBiliSource;`,
					`// const s = settingsSegment;`,
					`const t = "const s = createBiliSource";`,
				].join("\n"),
			),
		).toEqual([]);
	});
});

describe("③ bilibili 这一格的成员:算(红)/ 不算", () => {
	const members = (body) => bilibiliMembersOf(parseSource(COMPOSE_FILE, body));
	const audit = (body, expected = ["problems"]) =>
		auditBilibiliMembers(parseSource(COMPOSE_FILE, body), expected);

	it("读出成员名;没有这一格给 undefined;不是字面量给 null", () => {
		expect(
			members(
				`export interface BuiltinIntegrations {\n\treadonly bilibili: { problems: P; api: Api };\n}`,
			),
		).toEqual(["problems", "api"]);
		expect(members(`export interface BuiltinIntegrations { x: 1 }`)).toBeUndefined();
		expect(members(`export interface BuiltinIntegrations { bilibili: Other }`)).toBeNull();
		expect(members(`export type BuiltinIntegrations = { bilibili: { problems: P } };`)).toEqual([
			"problems",
		]);
	});

	it("多一个成员红;名单上的成员没了而名单没改也红", () => {
		expect(
			audit(
				`export interface BuiltinIntegrations { readonly bilibili: { problems: P; api: Api } }`,
			),
		).toEqual([expect.stringContaining("多了成员 api")]);
		expect(audit(`export interface BuiltinIntegrations { readonly bilibili: { } }`)).toEqual([
			expect.stringContaining("已经没有成员 problems"),
		]);
		expect(audit(`export interface BuiltinIntegrations { readonly bilibili: Other }`)).toEqual([
			expect.stringContaining("不是字面量"),
		]);
	});

	it("正好等于名单:通过;名单清空后这一格必须一起没有", () => {
		expect(
			audit(`export interface BuiltinIntegrations { readonly bilibili: { problems: P } }`),
		).toEqual([]);
		expect(audit(`export interface BuiltinIntegrations { x: 1 }`, [])).toEqual([]);
		expect(
			audit(`export interface BuiltinIntegrations { readonly bilibili: { problems: P } }`, []),
		).toEqual([expect.stringContaining("名单已空")]);
		expect(audit(`export interface BuiltinIntegrations { x: 1 }`)).toEqual([
			expect.stringContaining("没有 bilibili 这一格"),
		]);
	});
});

describe("④ api 槽位:算 / 不算", () => {
	const slots = (text) => apiSlots(parseSource("apps/server/src/x.ts", text)).map((h) => h.line);

	it("属性访问(含 ?.)、对象字面量里的 api(两种写法)、接口属性签名(含可选)、解构", () => {
		expect(slots(`engines.api.fetchUserCard(uid);`)).toEqual([1]);
		expect(slots(`opts.api?.getMyselfInfoCached();`)).toEqual([1]);
		expect(slots(`createX({ api: engines.api });`)).toEqual([1, 1]);
		expect(slots(`createX({ api });`)).toEqual([1]);
		expect(slots(`interface O { api: Api }\ninterface P { api?: Api }`)).toEqual([1, 2]);
		expect(slots(`const { api } = opts;`)).toEqual([1]);
		expect(slots(`const { api: client } = opts;`)).toEqual([1]);
	});

	it('索引访问字符串 "api"、类的 api 属性声明也算(不然换个写法就绕过了)', () => {
		expect(slots(`engines["api"].x();`)).toEqual([1]);
		expect(slots(`class C { private api: Api; }`)).toEqual([1]);
	});

	it("this.api、字符串里的 /api、名字不正好是 api、注释、形参与局部变量不算", () => {
		expect(slots(`class C { f() { return this.api; } }`)).toEqual([]);
		expect(slots(`const url = "/api/health";`)).toEqual([]);
		expect(slots(`const k = opts.apiKey; fetchApi(x); const { apiKey } = o; o.getApi();`)).toEqual(
			[],
		);
		expect(slots(`// engines.api.x()\n/** { api: Api } */`)).toEqual([]);
		expect(slots(`function f(api: Api) { const api2 = api; }`)).toEqual([]);
		expect(slots(`const { other: api } = opts;`)).toEqual([]);
	});
});

describe("④ 的对账:按文件,两头钉", () => {
	const src = (text) => ({ "apps/server/src/a.ts": parseSource("apps/server/src/a.ts", text) });
	const TWO = `a.api.x();\nb({ api });`;

	it("等于上限通过;多了红、少了红、表外红、表里没了红", () => {
		expect(auditApiSlots(src(TWO), { "apps/server/src/a.ts": 2 })).toEqual([]);
		expect(auditApiSlots(src(TWO), { "apps/server/src/a.ts": 1 })[0]).toContain("超过棘轮上限 1");
		expect(auditApiSlots(src(TWO), { "apps/server/src/a.ts": 3 })).toEqual([
			"apps/server/src/a.ts: 实数 2,上限还写着 3 —— 把上限调低到 2",
		]);
		expect(auditApiSlots(src(TWO), {})).toHaveLength(2);
		expect(auditApiSlots(src(`const x = 1;`), { "apps/server/src/a.ts": 2 })).toEqual([
			"apps/server/src/a.ts: 实数 0,上限还写着 2 —— 把这一行从棘轮表里删掉",
		]);
	});
});

// ---------------------------------------------------------------------------
// 真扫
// ---------------------------------------------------------------------------

describe("入口咽喉:compose.ts 的导出面", () => {
	const source = parseSource(COMPOSE_FILE);

	it("compose.ts 确实从集成目录引着东西(扫空了等于没有这道守卫)", () => {
		const bindings = integrationBindings(COMPOSE_FILE, source);
		expect(bindings.size).toBeGreaterThan(0);
		expect([...bindings.values()].some((b) => !b.typeOnly)).toBe(true);
		expect(bilibiliMembersOf(source)).toBeUndefined();
	});

	it("① 导出类型里的集成类型:实数与记账一致", () => {
		expect(
			auditExportedTypes(COMPOSE_FILE, source),
			"导出面上不许新增集成的类型;记账只降不涨,清掉一处当场调低",
		).toEqual([]);
	});

	it("① 每处记账都写明了什么时候消", () => {
		for (const [name, { limit, until }] of Object.entries(EXPORTED_TYPE_LEDGER)) {
			expect(limit, name).toBeGreaterThan(0);
			expect(until.length, name).toBeGreaterThan(10);
		}
	});

	it("② 集成的值在 compose.ts 里只被调用 / 直接作参数,没有转出", () => {
		expect(auditMisusedValues(COMPOSE_FILE, source)).toEqual([]);
	});

	it("③ BuiltinIntegrations.bilibili 的成员正好等于名单", () => {
		expect(auditBilibiliMembers(source), "别往这一格里加句柄给入口用").toEqual([]);
	});
});

describe("入口咽喉:核心里的 api 槽位", () => {
	const files = slotFiles();

	it("扫到了源码,且没有扫进 compose.ts、集成目录与开发壳", () => {
		expect(files.length).toBeGreaterThan(50);
		expect(files).toContain("apps/server/src/index.ts");
		expect(files).not.toContain(COMPOSE_FILE);
		expect(files.some((f) => SLOT_SKIP_DIRS.some((dir) => isInside(f, dir)))).toBe(false);
	});

	it("按文件的实数与棘轮一致:新读者红,读者少了当场调低", () => {
		const sources = Object.fromEntries(files.map((file) => [file, parseSource(file)]));
		expect(auditApiSlots(sources), "核心里装着 B 站接口客户端的槽位只许降不许涨").toEqual([]);
	});
});
