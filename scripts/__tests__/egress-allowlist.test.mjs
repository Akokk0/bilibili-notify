import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { findNodes, importsOf, listSources, parseSource, ts } from "../source-scan.mjs";

/**
 * 出网点名表:服务端进程里跑的代码,想往外发请求,要么在白名单里,要么在棘轮表里点了名。
 *
 * 规矩早就有(ADR-0025 决策 6:集成的请求经 `ctx.http`;集成副作用规范第 4 条),只是一直靠审查。
 * 集成绕过 `ctx.http` 自己发请求、核心随手长出一个出口,类型、测试、构建全绿,
 * 症状要等某天有人抓包才冒出来。
 *
 * - 范围:`packages/<包>/src`(ui 除外)、`apps/server/src`、`extensions/<拓展>/src`,不含测试。
 *   第三方拓展的打包产物不扫。
 * - 判据看语法树,不看字样:注释、字符串里的 `fetch(` 不是节点。
 * - 白名单按文件,只有两类:集成的请求客户端;BN 自己的出口(和开发版的假桥)。
 * - 棘轮按文件记上限:多一处就红,**上限高于实数也红** —— 棘轮只许往下走,清理完的那一格
 *   当场调低。3b 末清零,那时棘轮表是空的。
 *
 * 判据写成纯函数 + 样例,因为判据本身也会写错:一条永远判 OK 的规则跟没有一样。
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** 出站原语的 import 来源:从这些模块拿到的 request / get / connect / createConnection 算出站。 */
const NET_MODULES = new Set([
	"node:http",
	"http",
	"node:https",
	"https",
	"node:http2",
	"http2",
	"node:net",
	"net",
	"node:tls",
	"tls",
]);
const NET_FUNCTIONS = new Set(["request", "get", "connect", "createConnection"]);

/**
 * 白名单:整个文件放行,写明理由。
 * 只有两类 —— 集成的请求客户端;BN 自己的出口(AI 服务商走 OpenAI SDK,不扫第三方)与开发版。
 */
export const ALLOWLIST = {
	// 集成的请求客户端;第 2 期起换成 packages/http/src。
	"packages/api/src/http-client.ts": "集成的请求客户端",
	// BN 自己的出口:应用内更新、拓展市场、签名清单。
	"apps/server/src/update/fetch-through-mirrors.ts": "BN 自己的出口:更新、拓展市场、签名清单",
	"packages/ai/src/web-search.ts": "BN 自己的出口:联网搜索",
	"apps/server/src/devtools/fake-bridge.ts": "开发版专属的假桥",
};

/**
 * 棘轮表:文件 → 出站原语的上限(勘察时的实数)。只许往下调,到 3b 末清零。
 * 平台适配器的出口随连接与适配器搬走;blive 的 WebSocket 与出图器拉图也各有去处;
 * `routes/globals.ts` 是设置页的 AI 连通测试写在了路由里。
 */
export const RATCHET = {
	"apps/server/src/platforms/qq-official.ts": 8,
	"apps/server/src/platforms/onebot.ts": 2,
	"apps/server/src/platforms/qq-bind.ts": 1,
	"apps/server/src/platforms/webhook.ts": 1,
	"packages/blive/src/client.ts": 1,
	"packages/image/src/image-renderer.ts": 1,
	"apps/server/src/routes/globals.ts": 1,
};

/**
 * 一份源码里的出站原语。
 * 算:`fetch(` / `globalThis.fetch(`、`new WebSocket(`、从 http / https / http2 / net / tls 的
 * **值导入**拿到的 request / get / connect / createConnection 的调用、`undici` 的值导入。
 * 不算:`x.fetch(`(别的对象的方法)、对象键 `fetch: app.fetch`、`new WebSocketServer(`、
 * `import type`、只拿 `WebSocket` 当类型或读 `WebSocket.OPEN`。
 *
 * @returns `{ line, text, primitive }[]`,按行号排
 */
export function egressCalls(source) {
	// 先看 import:从 http / https / http2 / net / tls 的模块里拿到了什么名字。
	// `import type` 与逐项 `type` 不带值,不算。
	const namespaces = new Map(); // 本地名 → 模块名(整个模块:默认、命名空间、default as x)
	const functions = new Map(); // 本地名 → { module, name }(具名拿到的 request / get / …)
	for (const statement of source.ast.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
			continue;
		}
		const module = statement.moduleSpecifier.text;
		const clause = statement.importClause;
		if (!NET_MODULES.has(module) || !clause || clause.phaseModifier === ts.SyntaxKind.TypeKeyword)
			continue;
		if (clause.name) namespaces.set(clause.name.text, module);
		const bindings = clause.namedBindings;
		if (bindings && ts.isNamespaceImport(bindings)) namespaces.set(bindings.name.text, module);
		if (bindings && ts.isNamedImports(bindings)) {
			for (const element of bindings.elements) {
				if (element.isTypeOnly) continue;
				const imported = (element.propertyName ?? element.name).text;
				if (imported === "default") namespaces.set(element.name.text, module);
				else if (NET_FUNCTIONS.has(imported)) {
					functions.set(element.name.text, { module, name: imported });
				}
			}
		}
	}

	/** 一个节点是哪种出站原语;不是就 null。 */
	const primitiveOf = (node) => {
		if (ts.isNewExpression(node)) {
			return ts.isIdentifier(node.expression) && node.expression.text === "WebSocket"
				? "new WebSocket"
				: null;
		}
		if (!ts.isCallExpression(node)) return null;
		const callee = node.expression;
		if (ts.isIdentifier(callee)) {
			if (callee.text === "fetch") return "fetch";
			const named = functions.get(callee.text);
			return named ? `${named.module}.${named.name}` : null;
		}
		if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
			const owner = callee.expression.text;
			const member = callee.name.text;
			if (owner === "globalThis" && member === "fetch") return "globalThis.fetch";
			const module = namespaces.get(owner);
			if (module && NET_FUNCTIONS.has(member)) return `${module}.${member}`;
		}
		return null;
	};

	const hits = findNodes(source, (node) => primitiveOf(node) !== null).map((hit) => ({
		line: hit.line,
		text: hit.text,
		primitive: primitiveOf(hit.node),
	}));

	// undici 的值导入:不管拿了什么,进了这个包就是要出网。
	const lines = source.text.split("\n");
	for (const ref of importsOf(source)) {
		if (ref.typeOnly) continue;
		if (ref.specifier !== "undici" && !ref.specifier.startsWith("undici/")) continue;
		hits.push({ line: ref.line, text: lines[ref.line - 1].trim(), primitive: "undici" });
	}
	return hits.sort((a, b) => a.line - b.line);
}

/**
 * 拿各文件的命中对照白名单与棘轮表。
 *
 * @param found `{ [文件]: 命中[] }`,没有命中的文件可以不出现
 * @returns 人话描述的问题清单;空数组 = 通过
 */
export function auditEgress(found, { allowlist, ratchet }) {
	const problems = [];
	for (const file of Object.keys(allowlist)) {
		if (file in ratchet) {
			problems.push(`${file}: 既在白名单又在棘轮表里 —— 两张表打架,留一张`);
		}
	}
	for (const [file, hits] of Object.entries(found)) {
		if (file in allowlist) continue;
		const limit = ratchet[file];
		if (limit === undefined) {
			for (const hit of hits) {
				problems.push(`${file}:${hit.line}: ${hit.text} —— 出站原语,文件不在白名单也不在棘轮表里`);
			}
		} else if (hits.length > limit) {
			problems.push(`${file}: 出站原语 ${hits.length} 处,超过棘轮上限 ${limit} —— 只许少不许多`);
			for (const hit of hits) problems.push(`${file}:${hit.line}: ${hit.text}`);
		} else if (hits.length < limit) {
			problems.push(
				`${file}: 实数 ${hits.length},上限还写着 ${limit} —— 把上限调低到 ${hits.length}`,
			);
		}
	}
	for (const [file, limit] of Object.entries(ratchet)) {
		if (file in found || file in allowlist) continue;
		problems.push(`${file}: 实数 0,上限还写着 ${limit} —— 把这一行从棘轮表里删掉`);
	}
	return problems;
}

/** 把一段样例当成一份 `.ts` 源码,返回命中的原语名。 */
const primitivesIn = (text) => egressCalls(parseSource("sample.ts", text)).map((c) => c.primitive);

describe("出站原语的判据:算", () => {
	it("全局 fetch(,含 globalThis.fetch(", () => {
		expect(primitivesIn(`const res = await fetch("https://x.test/a");`)).toEqual(["fetch"]);
		expect(primitivesIn(`await globalThis.fetch(url, { method: "POST" });`)).toEqual([
			"globalThis.fetch",
		]);
		expect(primitivesIn(`await fetch?.(url);`)).toEqual(["fetch"]);
		// 嵌在别的表达式里也认得,一处一条。
		expect(primitivesIn(`const a = await Promise.all([fetch(u1), fetch(u2)]);`)).toEqual([
			"fetch",
			"fetch",
		]);
	});

	it("new WebSocket(,不管是全局的还是 ws 库的", () => {
		expect(primitivesIn(`const ws = new WebSocket("wss://x.test");`)).toEqual(["new WebSocket"]);
		expect(
			primitivesIn(
				`import { WebSocket } from "ws";\nconst ws = new WebSocket(url, { headers: {} });`,
			),
		).toEqual(["new WebSocket"]);
		expect(primitivesIn(`import WebSocket from "ws";\nnew WebSocket(url);`)).toEqual([
			"new WebSocket",
		]);
	});

	it("http / https 的 request 与 get:默认、命名空间、具名、改名导入都认", () => {
		expect(primitivesIn(`import http from "node:http";\nhttp.request(opts, cb);`)).toEqual([
			"node:http.request",
		]);
		expect(primitivesIn(`import http from "http";\nhttp.get(url, cb);`)).toEqual(["http.get"]);
		expect(primitivesIn(`import * as https from "node:https";\nhttps.get(url);`)).toEqual([
			"node:https.get",
		]);
		expect(primitivesIn(`import { request } from "node:https";\nrequest(opts);`)).toEqual([
			"node:https.request",
		]);
		expect(primitivesIn(`import { get as httpGet } from "http";\nhttpGet(url);`)).toEqual([
			"http.get",
		]);
		expect(primitivesIn(`import { default as h } from "https";\nh.request(o);`)).toEqual([
			"https.request",
		]);
	});

	it("net / tls / http2 的 connect 与 createConnection", () => {
		expect(primitivesIn(`import net from "node:net";\nnet.connect(80, host);`)).toEqual([
			"node:net.connect",
		]);
		expect(primitivesIn(`import net from "net";\nnet.createConnection({ host, port });`)).toEqual([
			"net.createConnection",
		]);
		expect(primitivesIn(`import { connect } from "node:tls";\nconnect(443, host);`)).toEqual([
			"node:tls.connect",
		]);
		expect(primitivesIn(`import http2 from "node:http2";\nhttp2.connect(origin);`)).toEqual([
			"node:http2.connect",
		]);
		expect(primitivesIn(`import { connect as h2 } from "http2";\nconst s = h2(origin);`)).toEqual([
			"http2.connect",
		]);
		// 默认导入与具名导入同一条语句。
		expect(
			primitivesIn(`import net, { createConnection } from "node:net";\ncreateConnection(80);`),
		).toEqual(["node:net.createConnection"]);
	});

	it("undici 的值导入:默认、命名空间、具名、副作用都算,报在 import 那一行", () => {
		for (const line of [
			`import { fetch as f } from "undici";`,
			`import * as undici from "undici";`,
			`import undici from "undici";`,
			`import "undici";`,
			`export { request } from "undici";`,
			`import { Agent } from "undici/lib/x.js";`,
		]) {
			expect(primitivesIn(line)).toEqual(["undici"]);
		}
		const hits = egressCalls(
			parseSource("sample.ts", `const a = 1;\nimport { Agent } from "undici";`),
		);
		expect(hits).toEqual([
			{ line: 2, text: `import { Agent } from "undici";`, primitive: "undici" },
		]);
	});

	it("命中带行号(节点起点,不含前导注释)与那一行的源码", () => {
		const hits = egressCalls(
			parseSource(
				"sample.ts",
				[
					`/**`,
					` * 说明`,
					` */`,
					`export async function pull(url) {`,
					`\t// 先拉一次`,
					`\treturn await fetch(`,
					`\t\turl,`,
					`\t);`,
					`}`,
				].join("\n"),
			),
		);
		expect(hits).toEqual([{ line: 6, text: "fetch(", primitive: "fetch" }]);
	});
});

describe("出站原语的判据:不算", () => {
	it("别的对象的 fetch 方法与对象键 fetch", () => {
		expect(primitivesIn(`const res = await app.fetch(request);`)).toEqual([]);
		expect(primitivesIn(`await this.fetch(url);`)).toEqual([]);
		expect(primitivesIn(`serve({ fetch: app.fetch, port });`)).toEqual([]);
		expect(primitivesIn(`const handler = { fetch: app.fetch };`)).toEqual([]);
		expect(primitivesIn(`class Client { fetch(url) { return url; } }`)).toEqual([]);
	});

	it("入站的 WebSocketServer、只当类型或只读常量用的 WebSocket", () => {
		expect(
			primitivesIn(
				`import { WebSocketServer } from "ws";\nnew WebSocketServer({ noServer: true });`,
			),
		).toEqual([]);
		expect(primitivesIn(`import type { WebSocket } from "ws";\nlet s: WebSocket | null;`)).toEqual(
			[],
		);
		expect(primitivesIn(`if (socket.readyState === WebSocket.OPEN) socket.send(x);`)).toEqual([]);
		expect(primitivesIn(`const ok = ws instanceof WebSocket;`)).toEqual([]);
	});

	it("import type 与逐项 type:拿不到值,谈不上调用", () => {
		// 语法上写得出来、运行时不存在:判据不能被 `type` 骗过去。
		expect(primitivesIn(`import type http from "node:http";\nhttp.get(u);`)).toEqual([]);
		expect(primitivesIn(`import type * as https from "node:https";\nhttps.request(o);`)).toEqual(
			[],
		);
		expect(
			primitivesIn(
				`import { type request } from "node:https";\nfunction f(request) { request(o); }`,
			),
		).toEqual([]);
		expect(primitivesIn(`import type { fetch } from "undici";`)).toEqual([]);
		expect(primitivesIn(`import { type Dispatcher, type Agent } from "undici";`)).toEqual([]);
		expect(primitivesIn(`export type { Agent } from "undici";`)).toEqual([]);
		expect(primitivesIn(`type T = import("undici").Dispatcher;`)).toEqual([]);
	});

	it("net 模块里跟出站无关的成员、不是这些模块的同名函数、自家客户端的 get", () => {
		expect(
			primitivesIn(`import http from "node:http";\nhttp.createServer(handler).listen(80);`),
		).toEqual([]);
		expect(
			primitivesIn(`import { createServer } from "node:http";\ncreateServer(handler);`),
		).toEqual([]);
		expect(primitivesIn(`import net from "node:net";\nnet.isIP(host);`)).toEqual([]);
		expect(primitivesIn(`import { get } from "lodash";\nget(obj, "a.b");`)).toEqual([]);
		expect(primitivesIn(`import { connect } from "react-redux";\nconnect(map)(View);`)).toEqual([]);
		expect(primitivesIn(`const r = await ctx.http.get("/a");\nclient.request(opts);`)).toEqual([]);
		// 拿了 http 却没调用出站成员:引用不是调用。
		expect(
			primitivesIn(`import { request } from "node:http";\nexport const fn = request;`),
		).toEqual([]);
	});

	it("注释、字符串、模板、正则字面量里的写法", () => {
		expect(
			primitivesIn(
				[
					`// 以前是 fetch("https://x.test")`,
					`/* new WebSocket(url) */`,
					`const a = 'fetch("https://x.test")';`,
					`const b = \`new WebSocket(\${url})\`;`,
					`const c = "import http from \\"node:http\\"; http.get(u)";`,
					`const d = /fetch\\(/;`,
					`/** @example import { fetch } from "undici"; */`,
				].join("\n"),
			),
		).toEqual([]);
	});
});

describe("对照白名单与棘轮表", () => {
	const hit = (line) => ({ line, text: `fetch(u${line})`, primitive: "fetch" });
	const tables = {
		allowlist: { "lib/client.ts": "请求客户端" },
		ratchet: { "src/old.ts": 2 },
	};

	it("白名单里的文件放行,多少处都行", () => {
		expect(
			auditEgress({ "lib/client.ts": [hit(1), hit(2), hit(3)] }, { ...tables, ratchet: {} }),
		).toEqual([]);
	});

	it("表外的文件出现出站原语:每一处报 file:line 与那一行", () => {
		expect(
			auditEgress({ "src/old.ts": [hit(1), hit(2)], "src/new.ts": [hit(7), hit(9)] }, tables),
		).toEqual([
			"src/new.ts:7: fetch(u7) —— 出站原语,文件不在白名单也不在棘轮表里",
			"src/new.ts:9: fetch(u9) —— 出站原语,文件不在白名单也不在棘轮表里",
		]);
	});

	it("棘轮表里的文件超过上限就红,并点名每一处", () => {
		const problems = auditEgress({ "src/old.ts": [hit(1), hit(2), hit(3)] }, tables);
		expect(problems[0]).toContain("src/old.ts");
		expect(problems[0]).toContain("3");
		expect(problems[0]).toContain("上限 2");
		expect(problems.join("\n")).toContain("src/old.ts:3: fetch(u3)");
	});

	it("上限高于实数也红:棘轮只许往下走,提示调低到几", () => {
		expect(auditEgress({ "src/old.ts": [hit(1)] }, tables)).toEqual([
			"src/old.ts: 实数 1,上限还写着 2 —— 把上限调低到 1",
		]);
		// 清零了:整行删掉。
		expect(auditEgress({}, tables)).toEqual([
			"src/old.ts: 实数 0,上限还写着 2 —— 把这一行从棘轮表里删掉",
		]);
	});

	it("实数等于上限就过", () => {
		expect(auditEgress({ "src/old.ts": [hit(1), hit(2)] }, tables)).toEqual([]);
	});

	it("同一个文件不许既在白名单又在棘轮表:两张表打架", () => {
		const problems = auditEgress(
			{},
			{ allowlist: { "src/both.ts": "x" }, ratchet: { "src/both.ts": 1 } },
		);
		expect(problems.join("\n")).toContain("src/both.ts");
		expect(problems.join("\n")).toContain("白名单");
		expect(problems.join("\n")).toContain("棘轮表");
	});
});

/** 范围:`packages/<包>/src`(ui 除外)、`apps/server/src`、`extensions/<拓展>/src`,仓库相对路径。 */
function scopeRoots() {
	const roots = ["apps/server/src"];
	for (const group of ["packages", "extensions"]) {
		for (const entry of readdirSync(join(REPO_ROOT, group), { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			if (group === "packages" && entry.name === "ui") continue;
			if (existsSync(join(REPO_ROOT, group, entry.name, "src"))) {
				roots.push(`${group}/${entry.name}/src`);
			}
		}
	}
	return roots;
}

/** 真去扫仓库:文件 → 命中。没有命中的文件不出现。 */
function scanRepo() {
	const found = {};
	for (const file of listSources(scopeRoots())) {
		const hits = egressCalls(parseSource(file));
		if (hits.length > 0) found[file] = hits;
	}
	return found;
}

/**
 * 🔴 **真去扫仓里的服务端代码。**
 *
 * 上面那些样例证明判据本身没写错;这一条证明**没有人真的在表外发请求**。两条都要:
 * 只有样例的话,判据再对也拦不住实际写下去的那一行。
 */
describe("仓里的出网点都点了名", () => {
	it("范围认得对:服务端、核心包与拓展在内,ui 不在", () => {
		const roots = scopeRoots();
		for (const expected of [
			"apps/server/src",
			"packages/api/src",
			"packages/blive/src",
			"packages/image/src",
			"extensions/bridge/src",
		]) {
			expect(roots).toContain(expected);
		}
		expect(roots).not.toContain("packages/ui/src");
		expect(roots).not.toContain("apps/web/src");
	});

	it("白名单里的文件都还在", () => {
		for (const file of Object.keys(ALLOWLIST)) {
			expect(existsSync(join(REPO_ROOT, file)), file).toBe(true);
		}
	});

	it("棘轮表里的文件真扫得到命中(扫空了比没有还糟)", () => {
		const found = scanRepo();
		expect(Object.keys(found)).toEqual(expect.arrayContaining(Object.keys(RATCHET)));
	});

	it("表外没有出站原语,棘轮表里的文件不多于上限、也不少于上限", () => {
		expect(auditEgress(scanRepo(), { allowlist: ALLOWLIST, ratchet: RATCHET })).toEqual([]);
	});
});
