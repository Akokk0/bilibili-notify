import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { ts } from "../source-scan.mjs";

/**
 * 事件载荷:总线事件表(`BusEvents`)的载荷里不许带 B 站的形状 —— 不许有 `uid` 键、不许用 `Bili*`
 * 类型、平台原始值不许以裸 `string` 进载荷(ADR-0021 决策 52:总线只留中立事件)。
 *
 * 总线上的东西一路流到统计、推送、面板;载荷里混进一个 `uid`,消费方就会按 B 站的键去认人,
 * 类型、测试、构建全绿。
 *
 * - 判据走类型层:`HistoryEntry` 这类载荷住在别的文件、还会嵌套,只解析语法树跟不进去,所以这里起一个
 *   TypeScript 程序、用类型检查器沿着每个载荷的属性、索引签名、联合、数组与接口的基类型一路往下走
 *   (同一个类型只走一次)。
 *   库里的类型(`Uint8Array`、`Date`)不往里走。
 * - `uid` 键与 `Bili*` 类型自动认得。**裸 string 认不出来**:`string` 就是 `string`,分不清是订阅 id
 *   还是 B 站的动态类型码。所以已知的几处在 `RAW_STRINGS` 里按路径点名(守卫只核它们还在、还是
 *   `string`),**新写进去的平台原始值只能靠审查**。
 * - 棘轮按事件记:表里写着的那几处之外多出一处就红,**表里的某处已经清掉也红** —— 当场删掉那一格。
 *   第 1 期 ④c 开张,3b 末清零(总线改成按订阅 id 发中立事件)。
 *
 * 判据写成纯函数 + 样例,因为判据本身也会写错:一条永远判 OK 的规则跟没有一样。
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const EVENT_TABLE_FILE = "packages/internal/src/platform.ts";
const EVENT_TABLE = "BusEvents";

/**
 * 棘轮表:事件 → 开张时违规的路径(`uid` 键写 `uid:<路径>`,`Bili*` 类型写 `bili:<路径>`)。
 * 只许删,3b 末清零。路径从载荷的根往下数,数组元素写 `[]`。
 *
 * 3b 的去向:直播状态、观看人数、动态改成按订阅 id 发中立事件(ADR-0021 决策 52);粉丝快照与历史行
 * 的身份改成 `{ sourceKey, externalId }`。订阅变更里的订阅已经是中立的订阅形状(⑥d d2:身份读 `identity`,
 * 没有 `uid` 键、没有 `Bili*` 类型了),只剩特别关注表里那一格 `uid`(它认的是 B 站用户 id,不是订阅的身份)。
 */
export const RATCHET = {
	"subscription-changed": ["uid:ops[].sub.specialUsers[].uid"],
	"history-recorded": ["uid:uid"],
	"history-updated": ["uid:uid"],
	"live-state-changed": ["uid:uid"],
	"live-viewers-changed": ["uid:uid"],
	"fans-refreshed": ["uid:entries[].uid"],
	"dynamic-detected": ["uid:uid"],
};

/**
 * 已知的「平台原始值以裸 string 进载荷」:路径 → 装的是什么。守卫只核它们还在、还是 `string`;
 * 3b 中立化以后改成中立的值,这一格当场删掉。
 */
export const RAW_STRINGS = {
	"dynamic-detected.type": "B 站的动态类型码(`DYNAMIC_TYPE_*`)原样",
	"live-viewers-changed.viewers": "B 站预格式化好的观看人数(如「1.2万」)",
};

/** 起一个只含 `file` 的 TypeScript 程序,编译选项取 `tsconfig` 那一份。 */
function createChecker(rootDir, file, tsconfig) {
	const read = ts.readConfigFile(join(rootDir, tsconfig), ts.sys.readFile);
	const parsed = ts.parseJsonConfigFileContent(
		read.config,
		ts.sys,
		dirname(join(rootDir, tsconfig)),
	);
	const program = ts.createProgram([join(rootDir, file)], { ...parsed.options, noEmit: true });
	return {
		program,
		checker: program.getTypeChecker(),
		source: program.getSourceFile(join(rootDir, file)),
	};
}

/**
 * 平台自带的接口(TypeScript 的 `lib.*.d.ts` 与 `@types/*` 里的 `Uint8Array`、`Date`、`Map`、`Buffer`)
 * 不走它的成员 —— 调用方只走它的类型参数(`Map<string, X>` 里的 `X`)。
 * ⚠️ 只认接口:`Record`、`Pick` 这类工具类型也声明在库里,可它们装的就是载荷本身,得往里走。
 * ⚠️ 也别把整个 `node_modules` 都当库:`z.infer<…>` 推导出来的类型声明在 zod 里,`HistoryEntry`、
 * `Subscription` 都是这么来的,挡掉它们就看不见里面的 `uid` 了。
 */
function isLibraryInterface(program, type) {
	if (!(type.objectFlags & ts.ObjectFlags.ClassOrInterface) && !type.target) return false;
	const symbol = (type.target ?? type).getSymbol();
	if (!symbol || !(symbol.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.Class))) return false;
	const file = symbol.declarations?.[0]?.getSourceFile();
	if (!file) return false;
	return (
		program.isSourceFileDefaultLibrary(file) || file.fileName.includes("/node_modules/@types/")
	);
}

/**
 * 一个类型写法里点名的 `Bili*` 类型,顺着我们自己源码里的类型别名展开(`Subscription` →
 * `BiliSubscription | ExtensionSubscription`)。
 *
 * 光看类型层认不全:`BiliSubscription = z.infer<…>` 这种别名,推导出来的是 zod 里已有的对象类型,
 * 别名在类型上留不住。所以写法里点名的也要看。
 */
function biliReferencesIn(checker, typeNode, seen = new Set()) {
	const found = [];
	// 只顺着「引用 → 别名 → 联合 / 交叉」走:数组元素与对象的各格由类型层那一趟逐格走到,
	// 这里再钻进去就会在上下几层重复报同一处。
	const visit = (node) => {
		if (ts.isParenthesizedTypeNode(node)) return visit(node.type);
		if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
			for (const part of node.types) visit(part);
			return;
		}
		if (!ts.isTypeReferenceNode(node)) return;
		const name = ts.isQualifiedName(node.typeName) ? node.typeName.right : node.typeName;
		if (name.text.startsWith("Bili")) found.push(name.text);
		let symbol = checker.getSymbolAtLocation(name);
		if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
		for (const decl of symbol?.declarations ?? []) {
			if (!ts.isTypeAliasDeclaration(decl) || seen.has(decl)) continue;
			if (decl.getSourceFile().fileName.includes("/node_modules/")) continue;
			seen.add(decl);
			visit(decl.type);
		}
	};
	visit(typeNode);
	return found;
}

/**
 * 一张事件表里每个事件的载荷违规:`{ [事件]: { violations: string[], strings: Map<路径, 是不是 string> } }`。
 * `violations` 里是 `uid:<路径>` 与 `bili:<路径>`。
 */
export function auditEventTable({ program, checker, source }, tableName) {
	const table = source.statements.find(
		(s) => ts.isInterfaceDeclaration(s) && s.name.text === tableName,
	);
	if (!table) throw new Error(`${source.fileName} 里没有 ${tableName}`);
	const result = {};
	for (const member of table.members) {
		if (!ts.isPropertySignature(member) || !member.type) continue;
		const event = ts.isStringLiteral(member.name) ? member.name.text : member.name.getText();
		const violations = new Set();
		const strings = new Map();
		const visited = new Set();
		const bili = (path) => violations.add(`bili:${path || "(根)"}`);
		const walk = (type, path) => {
			const named = type.aliasSymbol?.name ?? type.getSymbol()?.name;
			if (named?.startsWith("Bili")) bili(path);
			// 可选的格是 `string | undefined`:任何一支是 string 就算。
			if (type.flags & ts.TypeFlags.String) strings.set(path, true);
			else if (!strings.has(path)) strings.set(path, false);
			if (type.isUnion() || type.isIntersection()) {
				for (const part of type.types) walk(part, path);
				return;
			}
			if (checker.isArrayType(type) || checker.isTupleType(type)) {
				for (const element of checker.getTypeArguments(type)) walk(element, `${path}[]`);
				return;
			}
			if (!(type.flags & ts.TypeFlags.Object)) return;
			if (isLibraryInterface(program, type)) {
				// `Map<string, X>`、`Promise<X>`:成员不走,装的东西要走。
				for (const arg of checker.getTypeArguments(type) ?? []) walk(arg, `${path}<>`);
				return;
			}
			if (visited.has(type)) return;
			visited.add(type);
			// 接口继承来的 Bili*:属性会并进来,可接口自己的名字不带 Bili,得看它的基类型。
			if (type.objectFlags & ts.ObjectFlags.ClassOrInterface) {
				for (const base of checker.getBaseTypes(type)) {
					if ((base.aliasSymbol ?? base.getSymbol())?.name.startsWith("Bili")) bili(path);
				}
			}
			// 索引签名(`Record<string, X>`)的值没有属性名,单独走一趟。
			for (const info of checker.getIndexInfosOfType(type)) walk(info.type, `${path}[*]`);
			for (const property of checker.getPropertiesOfType(type)) {
				const childPath = path ? `${path}.${property.name}` : property.name;
				if (property.name === "uid") violations.add(`uid:${childPath}`);
				const decl = property.valueDeclaration ?? property.declarations?.[0];
				if (decl?.type && biliReferencesIn(checker, decl.type).length > 0) bili(childPath);
				walk(checker.getTypeOfSymbolAtLocation(property, member), childPath);
			}
		};
		if (biliReferencesIn(checker, member.type).length > 0) bili("");
		walk(checker.getTypeFromTypeNode(member.type), "");
		result[event] = { violations: [...violations].sort(), strings };
	}
	return result;
}

/**
 * 拿审计结果对照棘轮表与裸 string 表。
 *
 * @returns 人话描述的问题清单;空数组 = 通过
 */
export function auditBusPayloads(audited, { ratchet, rawStrings }) {
	const problems = [];
	for (const [event, { violations }] of Object.entries(audited)) {
		const allowed = new Set(ratchet[event] ?? []);
		for (const v of violations) {
			if (!allowed.has(v)) problems.push(`${event}: ${v} —— 载荷里带了 B 站的形状,不在棘轮表里`);
		}
		for (const v of allowed) {
			if (!violations.includes(v)) {
				problems.push(`${event}: ${v} 已经清掉了,棘轮表里还写着 —— 把这一格删掉`);
			}
		}
	}
	for (const event of Object.keys(ratchet)) {
		if (!(event in audited)) problems.push(`${event}: 事件表里已经没有这个事件 —— 把这一行删掉`);
	}
	for (const [path, what] of Object.entries(rawStrings)) {
		const [event, ...rest] = path.split(".");
		const isString = audited[event]?.strings.get(rest.join("."));
		if (isString === undefined) {
			problems.push(`${path}(${what}): 载荷里找不到这一格了 —— 中立化了就把它从裸 string 表里删掉`);
		} else if (!isString) {
			problems.push(`${path}(${what}): 不再是裸 string 了 —— 把它从裸 string 表里删掉`);
		}
	}
	return problems;
}

/** 把一段样例当成一个包里的 `.ts`,审计里面叫 `Events` 的那张表。 */
function auditSample(text) {
	const file = "sample.ts";
	const host = ts.createCompilerHost({ strict: true, noEmit: true });
	const original = host.getSourceFile;
	host.getSourceFile = (name, version) =>
		name === file ? ts.createSourceFile(file, text, version) : original(name, version);
	const program = ts.createProgram([file], { strict: true, noEmit: true }, host);
	const checker = program.getTypeChecker();
	return auditEventTable({ program, checker, source: program.getSourceFile(file) }, "Events");
}

const violationsIn = (text) =>
	Object.fromEntries(Object.entries(auditSample(text)).map(([e, r]) => [e, r.violations]));

describe("载荷的判据:算", () => {
	it("uid 键:顶层、嵌套对象、数组元素、联合的某一支里都认得", () => {
		expect(
			violationsIn(`
				interface Row { uid: string; name: string }
				interface Events {
					a: { uid: string; status: "live" };
					b: { entry: { creator: { uid: string } } };
					c: { entries: Row[] };
					d: { kind: "x"; uid: string } | { kind: "y"; id: string };
				}`),
		).toEqual({
			a: ["uid:uid"],
			b: ["uid:entry.creator.uid"],
			c: ["uid:entries[].uid"],
			d: ["uid:uid"],
		});
	});

	it("Bili* 类型:接口、类型别名,载荷本身或它的某一格", () => {
		expect(
			violationsIn(`
				interface BiliDynamic { id: string }
				type BiliCard = { title: string };
				interface Events {
					a: BiliDynamic;
					b: { card: BiliCard };
					c: { cards: BiliCard[] };
				}`),
		).toEqual({ a: ["bili:(根)"], b: ["bili:card"], c: ["bili:cards[]"] });
	});

	it("类型上留不住名字的 Bili* 别名(像 z.infer 那样):顺着写法里的别名认", () => {
		expect(
			violationsIn(`
				interface Schema { _output: { id: string } }
				type BiliSubscription = Schema["_output"];
				type ExtensionSubscription = { id: string; extensionId: string };
				type Subscription = BiliSubscription | ExtensionSubscription;
				type Op = { type: "add"; sub: Subscription };
				interface Events { changed: { ops: Op[] } }`),
		).toEqual({ changed: ["bili:ops[].sub"] });
	});

	it("索引签名(Record<string, X>)、库里泛型接口(Map)装的东西、继承来的 Bili* 接口也认得", () => {
		expect(
			violationsIn(`
				interface BiliBase { id: string }
				interface Card extends BiliBase { title: string }
				interface Events {
					a: { byId: Record<string, { uid: string }> };
					b: { card: Card };
					c: { byName: Map<string, { uid: string }> };
				}`),
		).toEqual({ a: ["uid:byId[*].uid"], b: ["bili:card"], c: ["uid:byName<>.uid"] });
	});

	it("自己引用自己的类型只走一次,不死循环", () => {
		expect(
			violationsIn(`
				interface TreeNode { uid: string; children: TreeNode[] }
				interface Events { tree: { root: TreeNode } }`),
		).toEqual({ tree: ["uid:root.uid"] });
	});
});

describe("载荷的判据:不算", () => {
	it("中立的键、void、库里的类型、别的名字里带 uid 的键", () => {
		expect(
			violationsIn(`
				interface Events {
					a: void;
					b: { subscriptionId: string; externalId: string; upUid: string };
					c: { bytes: Uint8Array; at: Date };
					d: { ids: string[] };
				}`),
		).toEqual({ a: [], b: [], c: [], d: [] });
	});

	it("名字里只是含 Bili、不以它打头的类型", () => {
		expect(
			violationsIn(`interface MyBiliView { id: string }\ninterface Events { a: MyBiliView }`),
		).toEqual({
			a: [],
		});
	});
});

describe("对照棘轮表与裸 string 表", () => {
	const audited = auditSample(`
		interface Events {
			a: { uid: string; viewers: string };
			b: { id: string };
		}`);

	it("棘轮表里写着的放行,多出来的点名", () => {
		expect(
			auditBusPayloads(audited, { ratchet: { a: ["uid:uid"] }, rawStrings: { "a.viewers": "x" } }),
		).toEqual([]);
		expect(auditBusPayloads(audited, { ratchet: {}, rawStrings: {} })).toEqual([
			"a: uid:uid —— 载荷里带了 B 站的形状,不在棘轮表里",
		]);
	});

	it("棘轮表里的某格清掉了、事件没了,都红:只许往下走", () => {
		expect(
			auditBusPayloads(audited, { ratchet: { a: ["uid:uid"], b: ["uid:uid"] }, rawStrings: {} }),
		).toEqual(["b: uid:uid 已经清掉了,棘轮表里还写着 —— 把这一格删掉"]);
		expect(
			auditBusPayloads(audited, { ratchet: { a: ["uid:uid"], gone: [] }, rawStrings: {} }),
		).toEqual(["gone: 事件表里已经没有这个事件 —— 把这一行删掉"]);
	});

	it("裸 string 表里的格找不到了或不再是 string:红,提示删掉", () => {
		const table = { ratchet: { a: ["uid:uid"] } };
		expect(auditBusPayloads(audited, { ...table, rawStrings: { "b.type": "动态类型码" } })).toEqual(
			["b.type(动态类型码): 载荷里找不到这一格了 —— 中立化了就把它从裸 string 表里删掉"],
		);
		const typed = auditSample(`interface Events { a: { uid: string; viewers: number } }`);
		expect(auditBusPayloads(typed, { ...table, rawStrings: { "a.viewers": "观看人数" } })).toEqual([
			"a.viewers(观看人数): 不再是裸 string 了 —— 把它从裸 string 表里删掉",
		]);
	});
});

/**
 * 🔴 **真去查总线的事件表。**
 */
describe("总线的事件载荷不带 B 站的形状", () => {
	const audited = auditEventTable(
		createChecker(REPO_ROOT, EVENT_TABLE_FILE, "packages/internal/tsconfig.json"),
		EVENT_TABLE,
	);

	it("事件表真找到了、每个事件都走到了(扫空了比没有还糟)", () => {
		expect(Object.keys(audited)).toEqual(
			expect.arrayContaining(["engine-error", "live-state-changed", "history-recorded"]),
		);
		expect(Object.keys(audited).length).toBeGreaterThan(15);
	});

	it("棘轮表之外没有 uid 键与 Bili* 类型,裸 string 表里的格都还在", () => {
		expect(auditBusPayloads(audited, { ratchet: RATCHET, rawStrings: RAW_STRINGS })).toEqual([]);
	});
});
