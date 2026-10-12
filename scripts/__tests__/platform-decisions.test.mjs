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
 *      `const { platform: p } = conn`,以及形参里的解构 `({ platform: p }) => …`、`function f({ platform: p }: Conn)`),
 *      **只传一层**、按名字在本文件内认(不做作用域分析)。
 *   4. 点名的取平台函数的调用(`PLATFORM_VALUE_CALLS`):今天只有 `platformOfTarget(…)`。
 *   5. 模板里**只有**平台值一段(头尾都是空串)的 `` `${conn.platform}` ``,值还是那个平台值。
 *   - **「读出来的」平台值**(`isPlatformRead`,平台对平台只认这个):`x.platform`、`x["platform"]`、`platformOfTarget(…)`、
 *     由它们或解构起的局部名字。**光秃秃的标识符不算**,哪怕名字以 `platform` 结尾(`defaultPlatform`、形参 `wantedPlatform`):
 *     局部常量、带写死默认值的形参能被写成平台名,不能放行。
 *   - 反过来:本文件里由宿主平台初始化的名字(初始化式里任何位置有 `process.platform` / `os.platform()`)**不是**平台值,
 *     **先于**上面第 2、3 条。专为 `runtime/puppeteer.ts` 的 `const platform = options.platform ?? process.platform`。
 * - **什么算「决定」** `platformDecisions`,一处语法位置算一处:
 *   1. 相等比较(`===` `!==` `==` `!=`)一边是平台值、另一边不是,且另一边不是 `undefined` / `null` / `""`(那是在问「有没有」);
 *      两边都是平台值时,只有**两边都是「读出来的」**才放行(平台对平台),否则照记;平台值读出来的属性再拿去比
 *      (`conn.platform.length === 3`、`conn.platform[0] === "q"`)也算。
 *   2. `switch (平台值)`。
 *   3. 平台值当下标 `TABLE[平台值]`;`平台值 in TABLE`。
 *   4. 平台值当实参传给任何函数(一次调用算一处),除非被调的是「去处表」`PLATFORM_SINKS`(名字 → 理由)里的,或者是
 *      `logger.*` / `console.*`。
 *   5. 在平台值上调**任何**方法(`.startsWith`、`.toLowerCase`、`.endsWith`、`.indexOf`、`.match`、`.split`、`.localeCompare`、
 *      `.slice`、`.toString` ……),一次调用算一处;调用的结果再拿去比不重复算。
 * - **不算**:`a.platform === b.platform`(平台对平台:问的是「是不是同一个身份」,ADR-0024 决策 9 明文要求
 *   「连接的平台不许变」这种比较);`x.platform === undefined`、`!x.platform`(有没有);`{ platform: conn.platform }`(构造);
 *   `` `平台变了(${a.platform})` ``(模板里拼进更长的句子:显示 / 日志 / 拼身份);`return conn.platform`;
 *   `logger.info("…", conn.platform)`;`process.platform === "win32"`;`const n = conn.platform.length`(读了属性但没拿去比)。
 * - **宁可错杀**(第 4 条的代价,经函数调用的一律算):`seen.add(conn.platform)`、`parts.push(conn.platform)`、
 *   `byPlatform.set(conn.platform, conn)`、`makeKey(conn.platform, address)`、`String(conn.platform)`、
 *   `encodeURIComponent(conn.platform)`、`counts[conn.platform] ?? 0`(最后一个是第 3 条的下标)今天都会红,哪怕是在构造身份或显示。
 *   今天核心里一处都没有。红了怎么办:确是构造身份 / 显示的,把那个函数登记进去处表 `PLATFORM_SINKS`(要主人点头)。
 *   `add` / `push` / `set` 这种通用方法名**不能**进去处表 —— 按名字认,进去就是筛子;这几种写成对象字面量或模板拼出来再传。
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
 *   与平台表同归宿;**面板今天另有 5 处**,不在上面那张 23 处的表里:`Targets.tsx:147`(`a.adapterKey === "onebot"`)、
 *   `:153`(`"qq-official"`)、`link-parsing-settings.tsx:250`(`a.adapterKey === "onebot"`)、`types/connection-credentials.ts:46` 与
 *   `types/connection-fields.ts:479`(两个 `switch (connection.adapterKey)`)。同一种越界的另一个写法,定案没点它,本片不加;
 *   要不要收进判据是主人的题)。
 * - 类型层面的分叉(`Extract<…, { platform: "onebot" }>`)。
 * - 属性不叫 `platform` 的同一个值(`kind`、`provider`)、形参换了名字又不经调用传进来的。
 * - 平台对平台放行认不出「对象路径里就带着平台名」的写法:`conn.platform === onebotAdapter.platform`、
 *   `=== REGISTRY.onebot.platform`(两边语法上都是 `x.platform` 读,分不开写死的和读连接的)。
 * - 日志放行与去处表**都按名字认**,可以当后门:接收者叫 `logger` / `log` / `console` 的调用整个放行,不看方法名
 *   (`logger.check(conn.platform)`、`log.isOnebot(conn.platform)` 不红);去处表里的函数返回值再拿去比也不管
 *   (`neutralPlatformSnapshot(conn.platform).name === "OneBot"` 不红)。
 * - 别名按名字在整个文件里认、不看作用域:一个文件里先有 `const p = conn.platform`、别处又有不相干的 `p` 会误中;
 *   反过来形参起名 `kind` 就漏(形参解构改名 `({ platform: kind })` 是认的)。`let` 之后再赋值、形参默认值都没管。
 * - **「读出来的」身份也按名字整文件认**(平台对平台放行用它):一个文件里只要别处有 `{ platform }` 解构(React 组件的 props 解构就是),
 *   `platform` 这个名字在这个文件里就整个算「读出来的」,「裸标识符照记」对它不生效 ——
 *   `function d1({ platform }) {…}` 与 `function d2(conn, platform = "onebot") { return conn.platform === platform; }` 放一起,后者不红。
 *   要真堵得做作用域分析。
 * - **写死的默认值写在解构默认值或 `??` 右边就过**:`function f(conn, { platform: want = "onebot" } = {}) { return conn.platform === want; }`、
 *   `const { platform: want = "onebot" } = opts`、`const p = cfg.platform ?? "onebot"; c.platform === p` 都不红
 *   (默认值挪了位置的 `wantedPlatform = "onebot"`;键不叫 `platform` 的 `{ deltaPlatform = "onebot" } = {}` 反而红)。
 * - **仍不红的刻意写法**(都要刻意才写得出):`const { length } = c.platform; length === 6`、`const n = c.platform.length; n === 6`、
 *   `[c.platform].includes("x")`、`c.platform + "" === "onebot"`、`` `x${c.platform}` === "xonebot" ``、`(flag ? c.platform : o.platform) === "onebot"`、
 *   `[c.platform, "x"].join(":") === "onebot:x"`、`c.platform.length > 6` 与 `c.platform < "p"`(只认相等比较);
 *   读对读:`const p = cfg.platform; c.platform === p`、`c.platform === cfg.defaults.platform`。
 * - **会误伤的**(以前放行、现在红;今天核心与面板里没有这样的代码,所以表没涨,判据打不准去问主人):
 *   - 形参对读、两个形参互比:`function f(onePlatform, other) { return onePlatform === other.platform; }`、
 *     `conns.some((x) => x.platform === iotaPlatform)`、`f(ninePlatform, tenPlatform) { return ninePlatform === tenPlatform; }`
 *     (「按给定平台找连接」最容易撞上);
 *   - 面板状态里的平台:`const [gammaPlatform] = useState(""); gammaPlatform === o.platform`(数组解构不进「读出来的」);
 *   - 带兜底的读对读,右边兜成写死的平台名:`c.platform === (o.platform ?? "onebot")`、`=== (flag ? "onebot" : o.platform)`
 *     (兜成空 `?? ""` / `|| undefined` 的放行);
 *   - 显示用的方法调用:`c.platform.trim()`、`` `平台 ${c.platform.toUpperCase()}` ``,套在 `logger.*` 里也红(红的是里面那次方法调用);
 *     `c.platform.length === 0` 红,`c.platform.length > 0` 不红;
 *   - **名字以 `platform` 结尾、装的却是描述对象的**:「派生读再比」与「任何方法都算」对任何名字以 `platform` 结尾的东西都生效,
 *     面板里 `platform` 多半是个描述对象(`Dashboard.tsx`、`History.tsx`、`Stats.tsx`、`PerUpEditor.tsx`),`descPlatform.label === "QQ"`、
 *     `c.platform.label === o.label`、`hostPlatform.describe()` 都红。今天面板只读 `.label` / `.color` / `.features`、没拿去比也没调方法,所以没红;
 *     以后写 `platform.shortLabel === platform.label` 就红。
 *   - 平台值带兜底(`c.platform ?? ""`、`p || "onebot"`)看穿了:喂函数、比字面量、`switch`、查表都算(面板 `Targets.tsx` 因此从 12 处涨到 18 处)。
 *
 * 这两道守卫(`.platform` 决定与守卫 11)按写法的样子认,认不全;上面列的是已知的,不再为新试出的绕法逐个改判据,
 * 靠审查与期末的代码审查。
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
	"若是越界(核心与面板读平台只许构造身份、显示、记日志):分叉改问适配器的能力,不要比平台名,不要起别的名字躲;若确是构造身份 / 显示(去处表 `PLATFORM_SINKS` 管得了的函数)或这道守卫的判据打不准:去问主人,由主人定是进去处表、加上限还是改判据,不要自己加;数降了就当场把这一格调低";

/** 取平台值的函数:调用它的结果就是平台值。 */
export const PLATFORM_VALUE_CALLS = new Set(["platformOfTarget"]);

/** 去处表:平台值喂给它们不算决定。名字 → 属于构造身份 / 显示 / 日志哪一类、理由。 */
export const PLATFORM_SINKS = {
	neutralPlatformSnapshot: "显示:造一份中性的平台快照给展示用",
};

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
 * 棘轮表(面板):同上,面板另记一张(开张时的现数:5 个文件 23 处;看穿兜底后 29 处)。
 * 面板上方案点名的 5 处误伤:`=== ""` 两处(问有没有)与全大写常量 `BILI_PLATFORM` 两处(设状态)由判据放掉,
 * 不在表里;剩下的 `Targets.tsx` 里 `value.platform === p.value` 一处是误伤(`p.value` 是候选里的平台,
 * 语法上认不出是平台对平台),如实记在 `Targets.tsx` 那一格里。
 */
export const RATCHET_PANEL = {
	"apps/web/src/components/link-parsing-settings.tsx": 1, // `platform === "qq-official"`
	// `table[platform]` 查表、`lookup(connection.platform)` 喂函数:都是平台徽章的显示。
	"apps/web/src/components/platform-meta.tsx": 2,
	// 原 12 处:`platform === "onebot"` / `"qq-official"` 比字面量 6 处(`platform` 与 `value.platform` 各 3)、`platformDescriptor(platform)`、
	// `targetSessionSummary(target, platform)`、`sessionFieldsHint(value, platform)`、`platformTint(...)`×2 喂函数 5 处(其中 `platformTint` 两处是显示),
	// 以及 `value.platform === p.value` 1 处:**误伤**(`p.value` 是候选里的平台,平台对平台,语法上认不出)。
	// 另 6 处是带兜底的平台值(判据看穿 `?? x` / `|| x` 后进表,10-12 主人点头,共 18 处):`addressNounFor(platform ?? "", …)`×3、
	// `platformTint(platform ?? "")`、`scopesFor(platform ?? "")`、`platformTint(platform || (…))`(这条是显示)。
	"apps/web/src/pages/Targets.tsx": 18,
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
	return someFallbackOperand(target, isDirectPlatform);
}

/** `a ?? b` / `a || b`。 */
const isFallbackChain = (target) =>
	ts.isBinaryExpression(target) &&
	(target.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
		target.operatorToken.kind === ts.SyntaxKind.BarBarToken);

/** 看穿 `a ?? b` / `a || b`:是兜底链且任一边过了 `test`(初始化式与比较里的平台值都用这一个办法)。 */
const someFallbackOperand = (target, test) =>
	isFallbackChain(target) && (test(target.left) || test(target.right));

/** 初始化式里直接就是「读出来的」平台值:规则 1、4(`x.platform`、`platformOfTarget(…)`),`a ?? b` / `a || b` 任一边是也算。裸标识符不算。 */
function isDirectRead(node) {
	const target = unwrap(node);
	if (isPlatformBase(target)) return true;
	return someFallbackOperand(target, isDirectRead);
}

/** 解构元素(变量声明里的 `const { platform: p } = x`,形参里的 `({ platform: p }) => …`)取出来的名字和它读的键。 */
function bindingEntries(pattern) {
	const entries = [];
	for (const element of pattern.elements) {
		if (!ts.isIdentifier(element.name)) continue;
		const key = element.propertyName
			? ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName)
				? element.propertyName.text
				: undefined
			: element.name.text;
		entries.push({ name: element.name.text, key });
	}
	return entries;
}

/**
 * 本文件里的名字:`aliases` 是由平台值初始化的局部名(规则 3,含形参解构 `({ platform: p })`),`reads` 是其中由「读出来的」
 * 平台值(`x.platform`、解构)初始化的那几个(不含 `const p = platform` 这种裸标识符起的),`hosts` 是由宿主平台初始化的名字。
 * 按名字认、不做作用域分析。
 */
export function namesOf(source) {
	const aliases = new Set();
	const reads = new Set();
	const hosts = new Set();
	const visit = (node) => {
		if (ts.isVariableDeclaration(node) && node.initializer) {
			const init = node.initializer;
			const hostSource = containsHostExpression(init) || isHostObject(init);
			if (ts.isIdentifier(node.name)) {
				if (hostSource) hosts.add(node.name.text);
				else if (isDirectPlatform(init)) {
					aliases.add(node.name.text);
					if (isDirectRead(init)) reads.add(node.name.text);
				}
			} else if (ts.isObjectBindingPattern(node.name)) {
				for (const { name, key } of bindingEntries(node.name)) {
					if (hostSource) {
						if (key === "platform") hosts.add(name);
					} else if (key === "platform") {
						aliases.add(name);
						reads.add(name);
					}
				}
			}
		} else if (ts.isParameter(node) && ts.isObjectBindingPattern(node.name)) {
			for (const { name, key } of bindingEntries(node.name)) {
				if (key === "platform") {
					aliases.add(name);
					reads.add(name);
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source.ast);
	return { aliases, reads, hosts };
}

/** `` `${x}` ``:模板里只有一段替换、头尾都是空串,值就是 `x` 本身。 */
function loneTemplateExpression(node) {
	return ts.isTemplateExpression(node) &&
		node.head.text === "" &&
		node.templateSpans.length === 1 &&
		node.templateSpans[0].literal.text === ""
		? node.templateSpans[0].expression
		: undefined;
}

/** 这个表达式是不是平台值(规则 1~4,宿主名字先于 2、3;`` `${平台值}` `` 还是平台值)。 */
export function isPlatformValue(node, names) {
	const target = unwrap(node);
	if (ts.isIdentifier(target)) {
		if (names.hosts.has(target.text)) return false;
		return names.aliases.has(target.text) || endsWithPlatform(target.text);
	}
	const inner = loneTemplateExpression(target);
	if (inner !== undefined) return isPlatformValue(inner, names);
	if (isFallbackChain(target)) {
		return someFallbackOperand(target, (operand) => isPlatformValue(operand, names));
	}
	return isPlatformBase(target);
}

/**
 * 这个表达式是不是「从连接 / 目标 / 候选上读出来的」平台值:`x.platform`、`x["platform"]`、`platformOfTarget(…)`,
 * 或本文件里由它们(或解构)初始化的名字。**光秃秃的标识符不算**,哪怕名字以 `platform` 结尾:`defaultPlatform = "onebot"`
 * 这样的局部常量、`wantedPlatform = "onebot"` 这样的形参,和 `conn.platform` 比就是在拿平台名做决定。
 */
function isPlatformRead(node, names) {
	const target = unwrap(node);
	if (ts.isIdentifier(target)) return !names.hosts.has(target.text) && names.reads.has(target.text);
	const inner = loneTemplateExpression(target);
	if (inner !== undefined) return isPlatformRead(inner, names);
	// 兜底链:左边是读出来的、右边也是读出来的或只是「没有」(`""` / `undefined` / `null`),整体还是读出来的;
	// 右边是写死的平台名(`o.platform ?? "onebot"`)就不是,照记
	if (isFallbackChain(target)) {
		return (
			isPlatformRead(target.left, names) &&
			(isPlatformRead(target.right, names) || isAbsence(target.right))
		);
	}
	return isPlatformBase(target);
}

/**
 * 在平台值上「读属性」:`conn.platform.length`、`conn.platform[0]`。调方法由调用那一层接住,这里只管不是调用的读。
 * 读完拿去比才算决定(见 `isDecision`)。
 */
function isDerivedRead(node, names) {
	const target = unwrap(node);
	if (isPlatformBase(target)) return false; // `cand.platform.platform`:读的还是一个 `platform` 属性,是平台值本身
	if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
		return isPlatformValue(target.expression, names);
	}
	return false;
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
			// 平台值读出来的属性再比(`conn.platform.length === 3`):拿平台值的某个性质去分叉
			const derived = isDerivedRead(node.left, names)
				? node.right
				: isDerivedRead(node.right, names)
					? node.left
					: undefined;
			if (derived !== undefined) return !isAbsence(derived);
			const left = isValue(node.left);
			const right = isValue(node.right);
			if (!left && !right) return false;
			// 两边都是平台值:只有两边都是「读出来的」才是平台对平台(问是不是同一个身份);裸标识符照记
			if (left && right)
				return !(isPlatformRead(node.left, names) && isPlatformRead(node.right, names));
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
			// 在平台值上调任何方法(`toLowerCase()`、`endsWith(…)`、`split(…)`……)都是拿平台值分叉
			if (ts.isPropertyAccessExpression(callee) && isValue(callee.expression)) return true;
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

	it("在平台值上调方法:任何方法都算,不止 startsWith / includes", () => {
		expect(sample('conn.platform.startsWith("qq");')).toHaveLength(1);
		expect(sample('platform.includes("q");')).toHaveLength(1);
		for (const text of [
			'conn.platform.toLowerCase() === "onebot"',
			'conn.platform.endsWith("official")',
			'conn.platform.indexOf("qq") === 0',
			"conn.platform.match(/qq/)",
			'conn.platform.split("-")[0] === "qq"',
			'!conn.platform.localeCompare("onebot")',
			"conn.platform.slice(0, 2)",
			"conn.platform.toString()",
			'conn.platform?.toUpperCase?.() === "X"',
		]) {
			// 一处方法调用算一处;结果再拿去比不重复算
			expect(sample(`${text};`), text).toHaveLength(1);
		}
	});

	it("平台值读出来的属性再比", () => {
		expect(sample("if (conn.platform.length === 3) {}")).toHaveLength(1);
		expect(sample('if (conn.platform[0] === "q") {}')).toHaveLength(1);
		expect(sample("if (platform.length > 3 && platform.length === n) {}")).toHaveLength(1);
	});

	it("模板里只有平台值一段,再拿去比", () => {
		expect(sample("if (`$" + '{conn.platform}` === "onebot") {}')).toHaveLength(1);
		expect(sample('if ("onebot" === `$' + "{platform}`) {}")).toHaveLength(1);
		expect(sample("lookup(`$" + "{conn.platform}`);")).toHaveLength(1);
	});

	it("平台值比写死的局部名字:名字以 platform 结尾也不算平台对平台", () => {
		expect(
			sample('const defaultPlatform = "onebot"; if (conn.platform === defaultPlatform) {}'),
		).toHaveLength(1);
		expect(
			sample(
				'function f(conn, wantedPlatform = "onebot") { return conn.platform === wantedPlatform; }',
			),
		).toHaveLength(1);
		expect(sample("const p = platform; if (conn.platform === p) {}")).toHaveLength(1);
		// 一边是形参 / 局部名字、另一边是读出来的:也算(形参可以是写死的)
		expect(sample("if (platform === other.platform) {}")).toHaveLength(1);
	});

	it("形参里解构改名跟变量声明里的一样认", () => {
		expect(sample('const f = ({ platform: kind }) => kind === "onebot";')).toHaveLength(1);
		expect(
			sample('function f({ platform: kind }: Conn) { return kind === "onebot"; }'),
		).toHaveLength(1);
		expect(sample('const { platform: kind } = conn; if (kind === "onebot") {}')).toHaveLength(1);
		// 解构的键不是 platform 就不是
		expect(sample('const f = ({ provider: kind }) => kind === "onebot";')).toEqual([]);
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

	it("宁可错杀:经一次函数调用的,构造身份、显示也红(写进文件头)", () => {
		for (const text of [
			"seen.add(conn.platform)",
			"parts.push(conn.platform)",
			"byPlatform.set(conn.platform, conn)",
			"makeKey(conn.platform, address)",
			"String(conn.platform)",
			"encodeURIComponent(conn.platform)",
			"counts[conn.platform] ?? 0",
		]) {
			expect(sample(`${text};`), text).toHaveLength(1);
		}
	});

	it("平台值带兜底(`?? x` / `|| x`)还是平台值:喂函数、比字面量、switch、查表", () => {
		expect(sample('fn(c.platform ?? "");')).toHaveLength(1);
		expect(sample('fn(c.platform || "onebot");')).toHaveLength(1);
		expect(
			sample('function f(onePlatform) { return (onePlatform ?? "") === "onebot"; }'),
		).toHaveLength(1);
		expect(sample('const p = c.platform; if ((p ?? "") === "onebot") {}')).toHaveLength(1);
		expect(sample('switch (twoPlatform ?? "") { case "a": break; }')).toHaveLength(1);
		expect(sample('const d = TABLE[c.platform ?? ""];')).toHaveLength(1);
		// 兜底在右边也一样
		expect(sample("fn(fallback ?? c.platform);")).toHaveLength(1);
		// 读对读时右边兜底成写死的平台名,不是平台对平台
		expect(sample('if (c.platform === (o.platform ?? "onebot")) {}')).toHaveLength(1);
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
		// 读出来的别名(`x.platform` 或解构起的)和读出来的比,还是平台对平台
		expect(sample("const p = a.platform; if (p === b.platform) {}")).toEqual([]);
		expect(sample("const { platform: p } = a; if (p === b.platform) {}")).toEqual([]);
		expect(sample("const f = ({ platform: p }) => p === b.platform;")).toEqual([]);
		expect(sample("if (`$" + "{a.platform}` === b.platform) {}")).toEqual([]);
		expect(sample('if (a["platform"] === b.platform) {}')).toEqual([]);
	});

	it("带兜底的读对读:两边都是读出来的(右边只兜成空)仍是平台对平台", () => {
		expect(sample('if ((c.platform ?? "") === (o.platform ?? "")) {}')).toEqual([]);
		expect(sample('if (c.platform === (o.platform ?? "")) {}')).toEqual([]);
		expect(sample("if ((c.platform || undefined) === o.platform) {}")).toEqual([]);
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
		// 模板里拼进更长的句子 / 拼身份,不是「只有平台值一段」
		expect(sample("const s = `连接 " + "$" + "{conn.platform}`;")).toEqual([]);
		expect(sample("const key = `" + "$" + "{conn.platform}:" + "$" + "{id}`;")).toEqual([]);
		expect(sample("const s = `" + "$" + "{conn.platform}`;")).toEqual([]);
		// 读属性但不拿去比
		expect(sample("const n = conn.platform.length;")).toEqual([]);
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

	it("抓不到的(钉住现状,写进文件头):对象路径里带着平台名、日志与去处表按名字认", () => {
		expect(sample("if (conn.platform === onebotAdapter.platform) {}")).toEqual([]);
		expect(sample("if (conn.platform === REGISTRY.onebot.platform) {}")).toEqual([]);
		expect(sample("logger.check(conn.platform);")).toEqual([]);
		expect(sample("log.isOnebot(conn.platform);")).toEqual([]);
		expect(sample("logger.child(conn.platform).decide();")).toEqual([]);
		expect(sample('neutralPlatformSnapshot(conn.platform).name === "OneBot";')).toEqual([]);
	});

	it("抓不到的(钉住现状,写进文件头):整文件认的名字、解构默认值与 `??` 右边的写死值、刻意写法", () => {
		// S1:别处有 `{ platform }` 解构,`platform` 整个名字都成了「读出来的」
		expect(
			sample(
				'function d1({ platform }) { return { platform }; } function d2(conn, platform = "onebot") { return conn.platform === platform; }',
			),
		).toEqual([]);
		// S2:写死的默认值挪到解构默认值或 `??` 右边
		expect(
			sample(
				'function f(conn, { platform: want = "onebot" } = {}) { return conn.platform === want; }',
			),
		).toEqual([]);
		expect(sample('const p9 = cfg.platform ?? "onebot"; if (c.platform === p9) {}')).toEqual([]);
		// 对照:键不叫 platform 的解构默认值是红的
		expect(
			sample(
				'function f(conn, { deltaPlatform = "onebot" } = {}) { return conn.platform === deltaPlatform; }',
			),
		).toHaveLength(1);
		// 刻意写法
		expect(sample("const n = c.platform.length; if (n === 6) {}")).toEqual([]);
		expect(sample('if ([c.platform].includes("x")) {}')).toEqual([]);
		expect(sample('if (c.platform + "" === "onebot") {}')).toEqual([]);
		expect(sample('if ((flag ? c.platform : o.platform) === "onebot") {}')).toEqual([]);
		expect(sample("const p = cfg.platform; if (c.platform === p) {}")).toEqual([]);
	});

	it("会误伤的(钉住现状,写进文件头):形参对读、描述对象、显示用的方法调用", () => {
		expect(
			sample("function f(onePlatform, other) { return onePlatform === other.platform; }"),
		).toHaveLength(1);
		expect(
			sample("function f(ninePlatform, tenPlatform) { return ninePlatform === tenPlatform; }"),
		).toHaveLength(1);
		expect(sample('if (descPlatform.label === "QQ") {}')).toHaveLength(1);
		expect(sample("hostPlatform.describe();")).toHaveLength(1);
		expect(sample("const t = c.platform.trim();")).toHaveLength(1);
		expect(
			sample('const [gammaPlatform] = useState(""); if (gammaPlatform === o.platform) {}'),
		).toHaveLength(1);
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
