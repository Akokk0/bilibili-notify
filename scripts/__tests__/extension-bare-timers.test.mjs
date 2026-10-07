import { readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { findNodes, importsOf, listSources, parseSource, ts } from "../source-scan.mjs";

/**
 * 守卫 22:拓展不裸开定时器、不裸挂服务端(ADR-0012 决策 11)。
 *
 * 拓展「卸载得干净」只有一个承重条件:它开的定时器、挂的端点都经宿主给的 `ctx`,卸载时宿主一并收走。
 * 留一条旁路,面板写着「已停用」,心跳还在照打。所以 `extensions/<id>/src`(不含测试)里出现这些就红:
 *
 * - 不经 ctx 的 `setTimeout` / `setInterval`:裸调用、挂在 `globalThis` / `global` / `window` / `self` 上的调用,
 *   以及 `node:timers` 的 import(`timers/promises` 的 `setTimeout` 同样是一只宿主收不走的定时器)。
 *   一次性的超时也不例外。`ctx.setTimeout(…)`、`opts.ctx.setInterval(…)` 这类挂在别的对象上的调用不算。
 * - `createServer(…)`:自己开端口。
 * - `new WebSocketServer(…)` 不带 `noServer: true`:自己监听端口。带了的是挂在宿主的 upgrade 上,合规。
 *
 * 只扫仓里拓展的源码;第三方拓展的打包产物不扫 —— 库自己会用定时器。
 * 没有白名单、没有棘轮:开张时是干净的。判据写成纯函数 + 样例,因为判据本身也会写错。
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const TIMER_NAMES = new Set(["setTimeout", "setInterval"]);
const GLOBAL_OBJECTS = new Set(["globalThis", "global", "window", "self"]);
const TIMERS_MODULE = /^(node:)?timers(\/.*)?$/;

/** `noServer: true` 写在第一个实参的对象字面量里。 */
function hasNoServer(node) {
	const [options] = node.arguments ?? [];
	if (!options || !ts.isObjectLiteralExpression(options)) return false;
	return options.properties.some(
		(prop) =>
			ts.isPropertyAssignment(prop) &&
			(ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) &&
			prop.name.text === "noServer" &&
			prop.initializer.kind === ts.SyntaxKind.TrueKeyword,
	);
}

function isBareCall(node) {
	if (ts.isCallExpression(node)) {
		const callee = node.expression;
		if (ts.isIdentifier(callee)) {
			return TIMER_NAMES.has(callee.text) || callee.text === "createServer";
		}
		if (ts.isPropertyAccessExpression(callee)) {
			if (callee.name.text === "createServer") return true;
			return (
				TIMER_NAMES.has(callee.name.text) &&
				ts.isIdentifier(callee.expression) &&
				GLOBAL_OBJECTS.has(callee.expression.text)
			);
		}
		return false;
	}
	if (ts.isNewExpression(node)) {
		const callee = node.expression;
		const name = ts.isIdentifier(callee)
			? callee.text
			: ts.isPropertyAccessExpression(callee)
				? callee.name.text
				: undefined;
		return name === "WebSocketServer" && !hasNoServer(node);
	}
	return false;
}

/**
 * 一份拓展源码里绕过 ctx 的定时器与服务端。
 *
 * @param source `parseSource` 的结果
 * @returns `{ line, text }[]`,按行号排
 */
export function bareHostBypasses(source) {
	const lines = source.text.split("\n");
	const fromImports = importsOf(source)
		.filter((ref) => TIMERS_MODULE.test(ref.specifier))
		.map((ref) => ({ line: ref.line, text: lines[ref.line - 1].trim() }));
	const fromCalls = findNodes(source, isBareCall).map(({ line, text }) => ({ line, text }));
	return [...fromImports, ...fromCalls].sort((a, b) => a.line - b.line);
}

/** 把一段样例当成拓展的源码,返回命中的行号。 */
const linesIn = (text) =>
	bareHostBypasses(parseSource("extensions/sample/src/index.ts", text)).map((hit) => hit.line);

describe("拓展绕过 ctx 的判据:算", () => {
	it("裸的定时器调用,一次性的也算", () => {
		expect(
			linesIn(
				[
					`const t = setTimeout(() => {}, 1000);`,
					`setInterval(tick, 5000);`,
					`await new Promise((r) => setTimeout(r, 10));`,
					`globalThis.setTimeout(fn, 1);`,
					`window.setInterval(fn, 1);`,
				].join("\n"),
			),
		).toEqual([1, 2, 3, 4, 5]);
	});

	it("node:timers 的 import", () => {
		expect(
			linesIn(
				[
					`import { setTimeout as sleep } from "node:timers/promises";`,
					`import { setInterval } from "timers";`,
				].join("\n"),
			),
		).toEqual([1, 2]);
	});

	it("自己开端口:createServer,不带 noServer 的 WebSocketServer", () => {
		expect(
			linesIn(
				[
					`const server = createServer(handler);`,
					`http.createServer(handler).listen(8080);`,
					`const wss = new WebSocketServer({ port: 8080 });`,
					`const bare = new WebSocketServer();`,
					`const off = new ws.WebSocketServer({ noServer: false });`,
				].join("\n"),
			),
		).toEqual([1, 2, 3, 4, 5]);
	});
});

describe("拓展绕过 ctx 的判据:不算", () => {
	it("经 ctx 的定时器", () => {
		expect(
			linesIn(
				[
					`ctx.setTimeout(fn, 1000);`,
					`const sweeper = opts.ctx.setInterval(sweep, 5000);`,
					`this.host.setTimeout(fn, 1);`,
				].join("\n"),
			),
		).toEqual([]);
	});

	it("挂在宿主 upgrade 上的 WebSocketServer", () => {
		expect(linesIn(`const wss = new WebSocketServer({ noServer: true, maxPayload: 1 });`)).toEqual(
			[],
		);
	});

	it("只是提到名字:类型、成员声明、注释、字符串", () => {
		expect(
			linesIn(
				[
					`type Ctx = Pick<ExtensionContext, "setInterval" | "setTimeout">;`,
					`const fake = { setTimeout: (fn) => fn(), setInterval() {} };`,
					`// setTimeout(fn, 1) 是禁止的`,
					`const hint = "别用 setInterval(";`,
				].join("\n"),
			),
		).toEqual([]);
	});
});

describe("守卫 22:仓里的拓展没有绕过 ctx 的定时器与服务端", () => {
	const roots = readdirSync(join(REPO_ROOT, "extensions"))
		.filter((id) =>
			statSync(join(REPO_ROOT, "extensions", id, "src"), { throwIfNoEntry: false })?.isDirectory(),
		)
		.map((id) => `extensions/${id}/src`);

	it("扫到了拓展(扫空了等于没有这道守卫)", () => {
		expect(roots).toContain("extensions/bridge/src");
		expect(listSources(roots).length).toBeGreaterThan(0);
	});

	it("一处都没有", () => {
		const hits = listSources(roots).flatMap((file) =>
			bareHostBypasses(parseSource(file)).map((hit) => `${file}:${hit.line}  ${hit.text}`),
		);
		expect(
			hits,
			"定时器走 ctx.setTimeout / ctx.setInterval,端点走 ctx.mount / ctx.upgrade",
		).toEqual([]);
	});
});
