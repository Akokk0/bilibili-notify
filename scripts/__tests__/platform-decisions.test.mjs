import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { auditRatchet } from "../ratchet-audit.mjs";
import {
	findNodes,
	identifierSegments,
	listSources,
	parseSource,
	srcRootsUnder,
	ts,
} from "../source-scan.mjs";

/**
 * `.platform` 决定棘轮:核心读连接的平台,只许构造身份、显示、记日志,不许拿它做决定
 * (docs/1.0/architecture.md 第二层静态扫描「`.platform`」那一行,ADR-0024 决策 9 一带)。
 * 「如果是 QQ 就……」写在核心里,就是核心又认了一遍平台;分叉该问适配器的能力。
 *
 * 机判把定案那句话翻成:**平台值流到「会分叉」的语法位置就算决定;流到对象字面量、模板、返回值、别名不算。**
 *
 * - 范围:核心 = `apps/server/src`、`apps/contract/src`、`packages/<包>/src`(`packages/ui` 除外:纯展示件库,读平台只可能是
 *   显示),不含测试;面板 = `apps/web/src`,另记一张表(主人 10-12 定:这道要抓的形态今天几乎全活在面板)。桌面壳、拓展不算。
 * - 核心整目录不扫:`platforms/`(适配器自己当然认自己的平台)、`migration/`(读 0.x 老数据)、`bilibili/`(集成)。面板不豁免。
 * - 白名单:空。
 * - **什么是「平台值」** `isPlatformValue`(看穿括号、`!`、`as`、`satisfies`):
 *   1. 属性读 `x.platform`、下标读 `x["platform"]`;对象是 `process`、`os`、`navigator` 的不算。
 *   2. 标识符的**最后一段**是 `platform`(`platform`、`connPlatform`、`fromPlatform`)。接住解构、形参、局部变量。
 *      全大写的常量名(`BILI_PLATFORM`)不算:它是写死的值,`useState(BILI_PLATFORM)` 是在设状态、不是在读连接
 *      (面板上两处误伤由这一条放掉);`conn.platform === BILI_PLATFORM` 仍由另一边的 `conn.platform` 接住。
 *   3. 本文件里由平台值初始化的局部名字(`const p = conn.platform`、`const p = conn.platform ?? x`、
 *      `const { platform: p } = conn`),**只传一层**、按名字在本文件内认(不做作用域分析)。
 *   4. 点名的取平台函数的调用(`PLATFORM_VALUE_CALLS`):今天只有 `platformOfTarget(…)`。
 *   - 反过来:本文件里由宿主平台初始化的名字(初始化式里任何位置有 `process.platform` / `os.platform()`)**不是**平台值,
 *     **先于**上面第 2、3 条。专为 `runtime/puppeteer.ts` 的 `const platform = options.platform ?? process.platform`。
 * - **什么算「决定」** `platformDecisions`,一处语法位置算一处:
 *   1. 相等比较(`===` `!==` `==` `!=`)一边是平台值、另一边不是,且另一边不是 `undefined` / `null` / `""`(那是在问「有没有」)。
 *   2. `switch (平台值)`。
 *   3. 平台值当下标 `TABLE[平台值]`;`平台值 in TABLE`。
 *   4. 平台值当实参传给任何函数(一次调用算一处),除非被调的是「去处表」`PLATFORM_SINKS`(名字 → 理由)里的,或者是
 *      `logger.*` / `console.*`。
 *   5. 在平台值上调方法:`.startsWith(…)`、`.includes(…)`。
 * - **不算**:`a.platform === b.platform`(平台对平台:问的是「是不是同一个身份」,ADR-0024 决策 9 明文要求
 *   「连接的平台不许变」这种比较);`x.platform === undefined`、`!x.platform`(有没有);`{ platform: conn.platform }`(构造);
 *   `` `平台变了(${a.platform})` ``(显示 / 日志);`return conn.platform`;`logger.info("…", conn.platform)`;
 *   `process.platform === "win32"`。
 * - 第 4 条为什么是「任何函数」而不是「名字像谓词的函数」:定案怕的就是「中立名谓词,词棘轮看不见」。按名字认谓词
 *   (`is*`、`supports*`)正好漏掉起了别的名字的那种;谓词要按平台分叉,函数体里就得比字面量、`switch` 或查表(第 1~3 条接住,
 *   只要形参还叫 `platform`);形参换了名字躲过去的,由调用处「把平台值传给了一个不在去处表里的函数」接住。两头各堵一半。
 * - 棘轮按文件记上限(对账见 `scripts/ratchet-audit.mjs`):多一处就红,上限高于实数也红。主人 10-12 定:清零期是 3b 末,
 *   清不了的几格照记,清零期的字面先不改,3b 收尾时再问。
 *
 * 抓不到的(靠审查与别的守卫):
 * - 别名传了两层以上、或经函数返回值、对象字段转手的。
 * - 把整个连接传进去、在 `platforms/` 以外的别的白名单目录里判的。
 * - 按 `adapterKey` 比字面量(`adapterKey === "webhook"`,今天核心 1 处,就在 `constants.ts` 的 `isWebhookPlatform` 里,
 *   与平台表同归宿;同一种越界的另一个写法,定案没点它,本片不加)。
 * - 类型层面的分叉(`Extract<…, { platform: "onebot" }>`)。
 * - 属性不叫 `platform` 的同一个值(`kind`、`provider`)、形参换了名字又不经调用传进来的。
 * - 别名按名字在整个文件里认、不看作用域:一个文件里先有 `const p = conn.platform`、别处又有不相干的 `p` 会误中;
 *   反过来形参起名 `kind` 就漏。`let` 之后再赋值、形参默认值都没管。
 *
 * 判据写成纯函数 + 样例:一条永远判 OK 的规则跟没有一样。
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** 核心整个目录放行(仓库相对、带结尾斜杠),写明理由。面板不豁免。 */
export const ALLOWED_DIRS = {
	"apps/server/src/platforms/": "内置平台适配器:认自己的平台是它的本职",
	"apps/server/src/migration/": '迁移模块:读 0.x 老数据,`entry.platform === "onebot"` 只住这里',
	"apps/server/src/bilibili/": "B 站自己的代码:集成不是核心",
};

/** 白名单:整个文件放行,写明理由。今天没有。 */
export const ALLOWLIST = {};

/** 报错后面带的那句:越界怎么办。 */
export const ADVICE =
	"这是越界(核心与面板读平台只许构造身份、显示、记日志):分叉改问适配器的能力,不要比平台名;要涨先问主人,不要起别的名字躲;数降了就当场把这一格调低";

/** 取平台值的函数:调用它的结果就是平台值。 */
export const PLATFORM_VALUE_CALLS = new Set(["platformOfTarget"]);

/** 去处表:平台值喂给它们不算决定。名字 → 属于构造身份 / 显示 / 日志哪一类、理由。 */
export const PLATFORM_SINKS = {
	neutralPlatformSnapshot: "显示:造一份中性的平台快照给展示用",
};

/** 在平台值上调它们算决定的方法。 */
const DECIDING_METHODS = new Set(["startsWith", "includes"]);

/** 宿主对象:`process.platform` 一类是操作系统,不是连接的平台。 */
const HOST_OBJECTS = new Set(["process", "os", "navigator"]);

const EQUALITY = new Set([
	ts.SyntaxKind.EqualsEqualsEqualsToken,
	ts.SyntaxKind.ExclamationEqualsEqualsToken,
	ts.SyntaxKind.EqualsEqualsToken,
	ts.SyntaxKind.ExclamationEqualsToken,
]);

/**
 * 棘轮表(核心):文件 → 命中的上限(开张时的现数)。只许往下调。
 * 行内注释只如实写这一格是什么,不写清零期。
 */
export const RATCHET = {
	// 开发场景取参数 `text(params.platform, "onebot")`:取出来只用来造假 bot,是误伤(判据不为它开例外,见文件头去处表)。
	"apps/server/src/devtools/scenarios/bridge.ts": 1,
	// 平台表自己:`PLATFORM_REGISTRY[platform]` 当下标一处,`isWebhookPlatform` 与 `addressNounFor` 里各一次 `platformDescriptor(platform)`。
	"packages/internal/src/constants.ts": 3,
};

/**
 * 棘轮表(面板):同上,面板另记一张(开张时的现数:5 个文件 23 处)。
 * 面板上方案点名的 5 处误伤:`=== ""` 两处(问有没有)与全大写常量 `BILI_PLATFORM` 两处(设状态)由判据放掉,
 * 不在表里;剩下的 `Targets.tsx` 里 `value.platform === p.value` 一处是误伤(`p.value` 是候选里的平台,
 * 语法上认不出是平台对平台),如实记在 `Targets.tsx` 那一格里。
 */
export const RATCHET_PANEL = {
	"apps/web/src/components/link-parsing-settings.tsx": 1, // `platform === "qq-official"`
	// `table[platform]` 查表、`lookup(connection.platform)` 喂函数:都是平台徽章的显示。
	"apps/web/src/components/platform-meta.tsx": 2,
	// 12 处:`platform === "onebot"` / `"qq-official"` 比字面量 6 处(`platform` 与 `value.platform` 各 3)、`platformDescriptor(platform)`、
	// `targetSessionSummary(target, platform)`、`sessionFieldsHint(value, platform)`、`platformTint(...)`×2 喂函数 5 处(其中 `platformTint` 两处是显示),
	// 以及 `value.platform === p.value` 1 处:**误伤**(`p.value` 是候选里的平台,平台对平台,语法上认不出)。
	"apps/web/src/pages/Targets.tsx": 12,
	// `isWebhookPlatform(connection.platform)`、`webhookUrlPlaceholder(platform)`、`webhookSecretHint(platform)`。
	"apps/web/src/types/connection-fields.ts": 3,
	// 两个 `switch (platform)`、`PLATFORM_REGISTRY[platform]` 查表、`platform === "onebot"` / `"qq-official"` 比字面量各一处。
	"apps/web/src/types/domain.ts": 5,
};

/** 看穿括号、`!`、`as`、`satisfies`、类型断言。 */
function unwrap(node) {
	let current = node;
	for (;;) {
		if (
			ts.isParenthesizedExpression(current) ||
			ts.isNonNullExpression(current) ||
			ts.isAsExpression(current) ||
			ts.isSatisfiesExpression(current) ||
			ts.isTypeAssertionExpression(current)
		) {
			current = current.expression;
		} else {
			return current;
		}
	}
}

/** 字面量参数(`"x"` 或不带替换的反引号串)的值;别的写法给 undefined。 */
const literalText = (node) =>
	node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
		? node.text
		: undefined;

const isHostObject = (node) => {
	const target = unwrap(node);
	return ts.isIdentifier(target) && HOST_OBJECTS.has(target.text);
};

/** `process.platform`、`navigator.platform`、`os.platform()`。 */
function isHostExpression(node) {
	const target = unwrap(node);
	if (ts.isPropertyAccessExpression(target)) {
		return target.name.text === "platform" && isHostObject(target.expression);
	}
	if (ts.isElementAccessExpression(target)) {
		return literalText(target.argumentExpression) === "platform" && isHostObject(target.expression);
	}
	if (ts.isCallExpression(target)) {
		const callee = unwrap(target.expression);
		return (
			ts.isPropertyAccessExpression(callee) &&
			callee.name.text === "platform" &&
			isHostObject(callee.expression)
		);
	}
	return false;
}

/** 这棵子树里任何位置有宿主平台。 */
function containsHostExpression(node) {
	let found = false;
	const visit = (child) => {
		if (found) return;
		if (isHostExpression(child)) {
			found = true;
			return;
		}
		ts.forEachChild(child, visit);
	};
	visit(node);
	return found;
}

/** 被调函数的名字:`f(…)` 是 `f`,`a.b.f(…)` 是 `f`;别的写法给 undefined。 */
function calleeName(call) {
	const callee = unwrap(call.expression);
	if (ts.isIdentifier(callee)) return callee.text;
	if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
	return undefined;
}

/** 全大写的常量名(`BILI_PLATFORM`):写死的一个值,不是从连接里读出来的。 */
const isConstantName = (name) => /^[A-Z][A-Z0-9_]*$/.test(name);

/** 标识符的最后一段是不是 `platform`(全大写常量不算:它是写死的值,拿它当实参是在设状态,不是在读连接)。 */
const endsWithPlatform = (name) =>
	identifierSegments(name).at(-1) === "platform" && !isConstantName(name);

/** 规则 1 与 4:不看本文件里名字的平台值(属性读、下标读、取平台函数的调用)。 */
function isPlatformBase(node) {
	const target = unwrap(node);
	if (ts.isPropertyAccessExpression(target)) {
		return target.name.text === "platform" && !isHostObject(target.expression);
	}
	if (ts.isElementAccessExpression(target)) {
		return (
			literalText(target.argumentExpression) === "platform" && !isHostObject(target.expression)
		);
	}
	if (ts.isCallExpression(target)) {
		const name = calleeName(target);
		return name !== undefined && PLATFORM_VALUE_CALLS.has(name);
	}
	return false;
}

/** 初始化式里直接就是平台值:规则 1、4,或最后一段是 `platform` 的名字;`a ?? b` / `a || b` 任一边是也算。 */
function isDirectPlatform(node) {
	const target = unwrap(node);
	if (isPlatformBase(target)) return true;
	if (ts.isIdentifier(target)) return endsWithPlatform(target.text);
	if (
		ts.isBinaryExpression(target) &&
		(target.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
			target.operatorToken.kind === ts.SyntaxKind.BarBarToken)
	) {
		return isDirectPlatform(target.left) || isDirectPlatform(target.right);
	}
	return false;
}

/**
 * 本文件里的名字:`aliases` 是由平台值初始化的局部名(规则 3),`hosts` 是由宿主平台初始化的名字。
 * 按名字认、不做作用域分析。
 */
export function namesOf(source) {
	const aliases = new Set();
	const hosts = new Set();
	const visit = (node) => {
		if (ts.isVariableDeclaration(node) && node.initializer) {
			const init = node.initializer;
			const hostSource = containsHostExpression(init) || isHostObject(init);
			if (ts.isIdentifier(node.name)) {
				if (hostSource) hosts.add(node.name.text);
				else if (isDirectPlatform(init)) aliases.add(node.name.text);
			} else if (ts.isObjectBindingPattern(node.name)) {
				for (const element of node.name.elements) {
					if (!ts.isIdentifier(element.name)) continue;
					const key = element.propertyName
						? ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName)
							? element.propertyName.text
							: undefined
						: element.name.text;
					if (hostSource) {
						if (key === "platform") hosts.add(element.name.text);
					} else if (key === "platform") {
						aliases.add(element.name.text);
					}
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source.ast);
	return { aliases, hosts };
}

/** 这个表达式是不是平台值(规则 1~4,宿主名字先于 2、3)。 */
export function isPlatformValue(node, names) {
	const target = unwrap(node);
	if (ts.isIdentifier(target)) {
		if (names.hosts.has(target.text)) return false;
		return names.aliases.has(target.text) || endsWithPlatform(target.text);
	}
	return isPlatformBase(target);
}

/** `undefined`、`null`、`void 0`、`""`:比它们是在问「有没有」,不是在认哪个平台。 */
function isAbsence(node) {
	const target = unwrap(node);
	return (
		(ts.isIdentifier(target) && target.text === "undefined") ||
		target.kind === ts.SyntaxKind.NullKeyword ||
		ts.isVoidExpression(target) ||
		literalText(target) === ""
	);
}

/** `logger.*` / `console.*` / `x.logger.*`:记日志。 */
function isLogCall(call) {
	const callee = unwrap(call.expression);
	if (!ts.isPropertyAccessExpression(callee)) return false;
	const receiver = unwrap(callee.expression);
	const name = ts.isIdentifier(receiver)
		? receiver.text
		: ts.isPropertyAccessExpression(receiver)
			? receiver.name.text
			: undefined;
	return name !== undefined && /^(logger|log|console)$/i.test(name);
}

/** 这个节点是不是一处「按平台名做决定」。 */
function isDecision(node, names) {
	const isValue = (child) => isPlatformValue(child, names);
	if (ts.isBinaryExpression(node)) {
		const op = node.operatorToken.kind;
		if (EQUALITY.has(op)) {
			const left = isValue(node.left);
			const right = isValue(node.right);
			if (left === right) return false;
			return !isAbsence(left ? node.right : node.left);
		}
		if (op === ts.SyntaxKind.InKeyword) return isValue(node.left);
		return false;
	}
	if (ts.isSwitchStatement(node)) return isValue(node.expression);
	if (ts.isElementAccessExpression(node)) return isValue(node.argumentExpression);
	if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
		if (ts.isCallExpression(node)) {
			const callee = unwrap(node.expression);
			if (
				ts.isPropertyAccessExpression(callee) &&
				DECIDING_METHODS.has(callee.name.text) &&
				isValue(callee.expression)
			) {
				return true;
			}
		}
		const name = calleeName(node);
		if (name !== undefined && Object.hasOwn(PLATFORM_SINKS, name)) return false;
		if (ts.isCallExpression(node) && isLogCall(node)) return false;
		return (node.arguments ?? []).some(isValue);
	}
	return false;
}

/** 一份源码里按平台名做的决定:`{ line, text }[]`,按出现顺序。 */
export function platformDecisions(source) {
	const names = namesOf(source);
	return findNodes(source, (node) => isDecision(node, names)).map(({ line, text }) => ({
		line,
		text,
	}));
}

const sample = (text) => platformDecisions(parseSource("sample.ts", text));

describe("`.platform` 决定的判据:算", () => {
	it("相等比较:平台值比字面量或比别的值", () => {
		expect(sample('if (conn.platform === "onebot") {}')).toHaveLength(1);
		expect(sample('if (conn.platform !== "qq-official") {}')).toHaveLength(1);
		expect(sample('if ("onebot" == conn.platform) {}')).toHaveLength(1);
		expect(sample('const ok = target["platform"] != "x";')).toHaveLength(1);
		expect(sample("if (value.platform === p.value) {}")).toHaveLength(1);
		expect(sample("if (conn.platform === WEBHOOK) {}")).toHaveLength(1);
	});

	it("switch 与查表", () => {
		expect(sample('switch (target.platform) { case "a": break; }')).toHaveLength(1);
		expect(sample("const d = REGISTRY[platform];")).toHaveLength(1);
		expect(sample("const d = REGISTRY[conn.platform];")).toHaveLength(1);
		expect(sample("const has = platform in TABLE;")).toHaveLength(1);
	});

	it("平台值当实参传给任何函数(名字像不像谓词都算)", () => {
		expect(sample("isWebhook(conn.platform);")).toHaveLength(1);
		expect(sample("atAllOk(platform);")).toHaveLength(1);
		expect(sample("whatever(a, b.platform);")).toHaveLength(1);
		expect(sample("new Thing(conn.platform);")).toHaveLength(1);
		expect(sample("obj.method(conn.platform);")).toHaveLength(1);
		// 一次调用算一处
		expect(sample("f(a.platform, b.platform);")).toHaveLength(1);
	});

	it("在平台值上调方法", () => {
		expect(sample('conn.platform.startsWith("qq");')).toHaveLength(1);
		expect(sample('platform.includes("q");')).toHaveLength(1);
	});

	it("最后一段是 platform 的名字都是平台值:形参、解构、驼峰", () => {
		for (const name of ["platform", "connPlatform", "fromPlatform", "target_platform"]) {
			expect(sample(`if (${name} === "x") {}`), name).toHaveLength(1);
		}
		expect(sample('const { platform } = conn; if (platform !== "w") {}')).toHaveLength(1);
		expect(sample('function f(platform: string) { return platform === "x"; }')).toHaveLength(1);
	});

	it("别名传一层:直接取、`??` 取、解构改名", () => {
		expect(sample('const p = conn.platform; if (p === "x") {}')).toHaveLength(1);
		expect(sample('const p = conn.platform ?? "x"; if (p === "y") {}')).toHaveLength(1);
		expect(sample('const { platform: p } = conn; if (p === "x") {}')).toHaveLength(1);
		expect(sample('const p = platform; if (p === "x") {}')).toHaveLength(1);
	});

	it("别名只传一层:别名的别名认不出(写进文件头的「抓不到」)", () => {
		expect(sample('const p = conn.platform; const q = p; if (q === "x") {}')).toEqual([]);
	});

	it("平台值比全大写常量照样算(平台值在另一边)", () => {
		expect(sample("if (conn.platform === BILI_PLATFORM) {}")).toHaveLength(1);
	});

	it("取平台函数的调用也是平台值", () => {
		expect(sample('if (platformOfTarget(t, conns) === "x") {}')).toHaveLength(1);
	});

	it("命中带行号与那一段源码", () => {
		expect(sample('\nif (conn.platform === "x") {}')).toEqual([
			{ line: 2, text: 'conn.platform === "x"' },
		]);
	});

	it("被看穿:括号、非空断言、as、satisfies", () => {
		expect(sample('if ((conn.platform as string) === "x") {}')).toHaveLength(1);
		expect(sample('if (conn.platform! === "x") {}')).toHaveLength(1);
		expect(sample('if ((conn.platform satisfies string) === "x") {}')).toHaveLength(1);
	});
});

describe("`.platform` 决定的判据:不算", () => {
	it("平台对平台:问的是是不是同一个身份", () => {
		expect(sample("if (a.platform === b.platform) {}")).toEqual([]);
		expect(sample("if (current.platform !== next.platform) {}")).toEqual([]);
		expect(sample("if (platform === other.platform) {}")).toEqual([]);
	});

	it("比 undefined / null / 空串:问的是有没有", () => {
		expect(sample("if (x.platform === undefined) {}")).toEqual([]);
		expect(sample("if (x.platform !== null) {}")).toEqual([]);
		expect(sample('if (value.platform === "") {}')).toEqual([]);
		expect(sample("if (!x.platform) {}")).toEqual([]);
	});

	it("全大写常量名不是从连接里读的平台值:拿它当实参、起别名、自己比自己都不算", () => {
		expect(sample("useState(BILI_PLATFORM);")).toEqual([]);
		expect(sample("switchPlatform(BILI_PLATFORM);")).toEqual([]);
		expect(sample('const p = BILI_PLATFORM; if (p === "x") {}')).toEqual([]);
		expect(sample("if (BILI_PLATFORM === OTHER_PLATFORM) {}")).toEqual([]);
	});

	it("构造、显示、返回值、别名本身", () => {
		expect(sample("const o = { platform: conn.platform };")).toEqual([]);
		expect(sample("const o = { platform };")).toEqual([]);
		expect(sample("const t = `平台变了(" + "$" + "{a.platform})`;")).toEqual([]);
		expect(sample("function f() { return conn.platform; }")).toEqual([]);
		expect(sample("const p = conn.platform;")).toEqual([]);
		expect(sample("const label = conn.platform ?? 'x';")).toEqual([]);
	});

	it("日志:logger.* / console.* / x.logger.*", () => {
		expect(sample('logger.info("x", conn.platform);')).toEqual([]);
		expect(sample('this.logger.warn("x", platform);')).toEqual([]);
		expect(sample("console.log(conn.platform);")).toEqual([]);
	});

	it("宿主平台:process / os / navigator", () => {
		expect(sample('if (process.platform === "win32") {}')).toEqual([]);
		expect(sample('if (os.platform() === "darwin") {}')).toEqual([]);
		expect(sample('if (navigator.platform === "MacIntel") {}')).toEqual([]);
		expect(sample('if (process["platform"] === "win32") {}')).toEqual([]);
	});

	it("宿主别名:名字既叫 platform、初始化式里又有 options.platform,宿主赢", () => {
		expect(
			sample(
				"const platform = options.platform ?? process.platform; const c = CHROME_CANDIDATES[platform]; if (platform === 'x') {}",
			),
		).toEqual([]);
		expect(sample("const { platform } = process; if (platform === 'x') {}")).toEqual([]);
	});

	it("去处表里的函数不算,表外的同样写法算", () => {
		expect(sample("neutralPlatformSnapshot(conn.platform);")).toEqual([]);
		expect(sample("mod.neutralPlatformSnapshot(platform);")).toEqual([]);
		expect(sample("somethingElse(conn.platform);")).toHaveLength(1);
	});

	it("类型位置、不是平台的名字、注释", () => {
		expect(sample("type T = Extract<A, { platform: 'onebot' }>;")).toEqual([]);
		expect(sample("interface A { platform: string }")).toEqual([]);
		expect(sample('if (kind === "onebot") {}')).toEqual([]);
		expect(sample('// if (conn.platform === "onebot") {}\nconst a = 1;')).toEqual([]);
		expect(sample('const s = "conn.platform === onebot";')).toEqual([]);
	});

	it("两边都不是平台值", () => {
		expect(sample('if (a === "x") {}')).toEqual([]);
		expect(sample("f(a.kind);")).toEqual([]);
	});
});

/** 范围(核心):服务端、contract 与 `packages/<包>/src`(`ui` 除外),仓库相对路径。 */
function coreRoots() {
	return srcRootsUnder(["apps", "packages"], {
		except: ["apps/desktop/src", "apps/web/src", "packages/ui/src"],
	});
}

/** 范围(面板):`apps/web/src`。 */
const PANEL_ROOTS = ["apps/web/src"];

/** 真去扫:文件 → 命中。核心里整目录不扫的与没有命中的文件不出现。 */
function scan(roots, skippedDirs) {
	const found = {};
	for (const file of listSources(roots)) {
		if (skippedDirs.some((dir) => file.startsWith(dir))) continue;
		const hits = platformDecisions(parseSource(file));
		if (hits.length > 0) found[file] = hits;
	}
	return found;
}

export const scanCore = () => scan(coreRoots(), Object.keys(ALLOWED_DIRS));
export const scanPanel = () => scan(PANEL_ROOTS, []);

/**
 * 🔴 **真去扫仓里的代码。** 上面的样例证明判据没写错;这几条证明表外没有人又写回来。
 */
describe("核心与面板里不再按平台名做决定", () => {
	it("范围认得对:核心有服务端、contract、核心包,没有 ui、面板、桌面壳、拓展;面板只有面板", () => {
		const roots = coreRoots();
		for (const expected of [
			"apps/server/src",
			"apps/contract/src",
			"packages/internal/src",
			"packages/push/src",
		]) {
			expect(roots).toContain(expected);
		}
		for (const unexpected of ["packages/ui/src", "apps/web/src", "apps/desktop/src"]) {
			expect(roots).not.toContain(unexpected);
		}
		expect(roots.some((root) => root.startsWith("extensions/"))).toBe(false);
		expect(PANEL_ROOTS).toEqual(["apps/web/src"]);
	});

	it("整目录不扫的目录真的存在", () => {
		for (const dir of Object.keys(ALLOWED_DIRS)) {
			expect(existsSync(join(REPO_ROOT, dir)), dir).toBe(true);
		}
	});

	it("核心:表外没有按平台名做决定,棘轮表里的文件不多于上限、也不少于上限", () => {
		expect(
			auditRatchet(scanCore(), {
				allowlist: ALLOWLIST,
				ratchet: RATCHET,
				what: "按平台名做决定(核心)",
				advice: ADVICE,
			}),
		).toEqual([]);
	});

	it("面板:同上,面板另记一张表", () => {
		expect(
			auditRatchet(scanPanel(), {
				allowlist: ALLOWLIST,
				ratchet: RATCHET_PANEL,
				what: "按平台名做决定(面板)",
				advice: ADVICE,
			}),
		).toEqual([]);
	});
});
