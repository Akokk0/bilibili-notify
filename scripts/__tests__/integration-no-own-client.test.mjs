import { describe, expect, it } from "vite-plus/test";
import { findNodes, listSources, parseSource, srcRootsUnder, ts } from "../source-scan.mjs";

/**
 * 守卫:集成不自造客户端。
 *
 * 集成的请求客户端与 cookie 罐由宿主统一造(`integrations/http.ts`),经 `openIntegration`
 * (`integrations/open.ts`)递到手里:默认头、单跳超时、cookie 存盘与打码、连接池的收尾都挂在那儿。
 * 集成自己 `new HttpClient(…)` / `new CookieJar(…)` 就绕开了这一整套 —— 罐子不进存盘、登录态随进程丢,
 * cookie 明文进日志,代理、超时、风控各写各的。所以 `bilibili/`、`platforms/` 与各拓展的 `src` 里出现
 * 这两种构造就红;上限为零。
 *
 * 按语法树判,不按字符串:`new HttpClient()` / `new CookieJar()`、具名 import 的 `as` 别名
 * (`import { HttpClient as Hc } from "…"; new Hc()`)、属性访问(`new http.HttpClient()`)都算;
 * 只当类型用(`let c: HttpClient`、`import type { CookieJar }`)、注释与字符串里的字样都不算。
 *
 * 没有白名单:共用工厂住在 `apps/server/src/integrations/`,不在扫描根里,自己不会撞上。
 * 不扫测试(`__tests__/`、`*.test.*`):夹具里造这两个类是常有的事。
 *
 * 判据写成纯函数 + 样例,因为判据本身也会写错:一条永远判 OK 的规则跟没有一样。
 */

/** 集成所在的目录:拓展的 `src` 在运行时再列。 */
export const INTEGRATION_ROOTS = ["apps/server/src/bilibili", "apps/server/src/platforms"];

/** 宿主替集成造、集成自己不造的类。 */
const CLIENT_NAMES = new Set(["HttpClient", "CookieJar"]);

/** 具名 import 里取的本地名(`HttpClient` / `CookieJar` 及其 `as` 别名);`import type` 擦除,不收。 */
function clientLocals(source) {
	const locals = new Set();
	for (const statement of source.ast.statements) {
		if (!ts.isImportDeclaration(statement)) continue;
		const clause = statement.importClause;
		const named = clause?.namedBindings;
		if (!clause || clause.phaseModifier === ts.SyntaxKind.TypeKeyword) continue;
		if (!named || !ts.isNamedImports(named)) continue;
		for (const element of named.elements) {
			const imported = (element.propertyName ?? element.name).text;
			if (!element.isTypeOnly && CLIENT_NAMES.has(imported)) locals.add(element.name.text);
		}
	}
	return locals;
}

/**
 * 一份集成源码里自己构造客户端或 cookie 罐的地方。
 *
 * @param source `parseSource` 的结果
 * @returns `{ line, text }[]`,按出现顺序
 */
export function ownClientConstructions(source) {
	const locals = new Set([...CLIENT_NAMES, ...clientLocals(source)]);
	return findNodes(source, (node) => {
		if (!ts.isNewExpression(node)) return false;
		const callee = node.expression;
		if (ts.isIdentifier(callee)) return locals.has(callee.text);
		return ts.isPropertyAccessExpression(callee) && CLIENT_NAMES.has(callee.name.text);
	}).map(({ line, text }) => ({ line, text }));
}

/** 把一段样例当成集成的源码,返回命中的行号。 */
const linesIn = (text) =>
	ownClientConstructions(parseSource("apps/server/src/bilibili/sample.ts", text)).map(
		(hit) => hit.line,
	);

describe("自造客户端的判据:算", () => {
	it("直接 new HttpClient 与 new CookieJar", () => {
		expect(
			linesIn([`const client = new HttpClient();`, `const jar = new CookieJar();`].join("\n")),
		).toEqual([1, 2]);
	});

	it("具名 import 的 as 别名", () => {
		expect(
			linesIn(
				[
					`import { HttpClient as Hc } from "@bilibili-notify/http";`,
					`import { CookieJar as Jar } from "@bilibili-notify/http";`,
					`const client = new Hc();`,
					`const jar = new Jar();`,
				].join("\n"),
			),
		).toEqual([3, 4]);
	});

	it("属性访问,末段是这两个名字", () => {
		expect(
			linesIn(
				[
					`import * as http from "@bilibili-notify/http";`,
					`const client = new http.HttpClient();`,
					`const jar = new http.CookieJar();`,
				].join("\n"),
			),
		).toEqual([2, 3]);
	});

	it("命中带那一行的源码", () => {
		expect(
			ownClientConstructions(
				parseSource(
					"apps/server/src/platforms/sample.ts",
					`import { z } from "zod";\nconst client = new HttpClient({ jar });`,
				),
			),
		).toEqual([{ line: 2, text: `new HttpClient({ jar })` }]);
	});
});

describe("自造客户端的判据:不算", () => {
	it("只当类型用:类型注解与 import type", () => {
		expect(
			linesIn(
				[
					`import type { CookieJar, HttpClient } from "@bilibili-notify/http";`,
					`import type { HttpClient as Hc } from "@bilibili-notify/http";`,
					`import { type CookieJar as Jar } from "@bilibili-notify/http";`,
					`let client: HttpClient;`,
					`function take(jar: CookieJar) { return jar; }`,
					// 类型绑出来的别名没有值:语法上 new 得出来,判据不能被骗过去。
					`const a = new Hc();`,
					`const b = new Jar();`,
				].join("\n"),
			),
		).toEqual([]);
	});

	it("注释与字符串里的字样", () => {
		expect(
			linesIn([`// const c = new HttpClient();`, `const hint = "别 new CookieJar()";`].join("\n")),
		).toEqual([]);
	});

	it("经共用工厂 openIntegration 拿客户端", () => {
		expect(
			linesIn(
				[
					`import { openIntegration } from "../integrations/open.js";`,
					`const { http } = await openIntegration({ stores, settings, logger, httpOptions: {} });`,
					`const client = http.client;`,
				].join("\n"),
			),
		).toEqual([]);
	});
});

describe("守卫:集成的目录里没有自造的客户端", () => {
	const roots = [...INTEGRATION_ROOTS, ...srcRootsUnder(["extensions"])];
	const files = listSources(roots);

	it("每个根都扫到了源码(扫空了等于没有这道守卫)", () => {
		for (const root of roots) {
			expect(
				files.some((file) => file.startsWith(`${root}/`)),
				root,
			).toBe(true);
		}
	});

	it("一处都没有", () => {
		const hits = files.flatMap((file) =>
			ownClientConstructions(parseSource(file)).map((hit) => `${file}:${hit.line}  ${hit.text}`),
		);
		expect(hits, "客户端经 openIntegration(…) 拿宿主造的那一个").toEqual([]);
	});
});
