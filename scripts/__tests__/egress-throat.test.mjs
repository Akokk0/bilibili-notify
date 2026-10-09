import { describe, expect, it } from "vite-plus/test";
import { importsOf, listSources, parseSource } from "../source-scan.mjs";

/**
 * 出口咽喉:只有 `TargetDispatcher` 拿得到带 `send` 的适配器(ADR-0024 决策 13)。
 *
 * 适配器登记表对外的 `list()` 只给不含 `send` 的视图;带 `send` 的完整适配器只有一个取法 ——
 * `push/registry.ts` 的 `sendableAdapters`。所以这道守卫钉的是「谁引了那个取法」:白名单只有
 * `push/target-dispatcher.ts`。别处(引擎装配、devtools、路由、拓展宿主)引了就红。
 *
 * 不扫 `.send(` 这个方法名:WebSocket、响应对象都有 `send`,按名字扫只会误报一片。
 * 测试不扫(登记表自己的测试要直接问这个取法)。
 *
 * 判据写成纯函数 + 样例,因为判据本身也会写错:一条永远判 OK 的规则跟没有一样。
 */

/** 取完整适配器的那个函数,和它住的模块。 */
const PRIVILEGED_NAME = "sendableAdapters";
const REGISTRY_MODULE = /(^|\/)registry(\.js|\.ts)?$/;

/** 唯一能引它的文件。 */
export const THROAT_FILE = "apps/server/src/push/target-dispatcher.ts";

/** 扫描范围:我们自己写的、会进运行时的源码。 */
export const THROAT_ROOTS = ["apps/server/src", "packages", "extensions"];

/**
 * 一份源码里碰到特权取法的地方:从登记表模块的 import / re-export / 动态 import / require,
 * 而且那一行点了 `sendableAdapters` 的名,或者是整包引进来的(`* as`、`export *`、动态 import)。
 *
 * @param source `parseSource` 的结果
 * @returns `{ line, text }[]`,按出现顺序
 */
export function throatImports(source) {
	const lines = source.text.split("\n");
	return importsOf(source)
		.filter((ref) => REGISTRY_MODULE.test(ref.specifier))
		.map((ref) => ({ line: ref.line, text: statementAt(lines, ref.line) }))
		.filter((hit) => hit.text.includes(PRIVILEGED_NAME) || WHOLE_MODULE.test(hit.text));
}

/** 整包引进来的写法:点没点名都拿得到那个取法。 */
const WHOLE_MODULE = /\*|\bimport\s*\(|\brequire\s*\(/;

/** 从 import 起头那一行往下收到这条语句结束(多行的具名 import 名字不在第一行)。 */
function statementAt(lines, line) {
	const out = [];
	for (let i = line - 1; i < lines.length && out.length < 40; i += 1) {
		out.push(lines[i].trim());
		if (/["'`]\s*\)?\s*;?\s*$/.test(lines[i])) break;
	}
	return out.join(" ");
}

/** 把一段样例当成源码,返回命中的行号。 */
const linesIn = (text) =>
	throatImports(parseSource("apps/server/src/sample.ts", text)).map((hit) => hit.line);

describe("碰到特权取法的判据:算", () => {
	it("具名 import、改名、和别的名字混着引、多行写法都算", () => {
		expect(
			linesIn(
				[
					`import { sendableAdapters } from "./registry.js";`,
					`import { sendableAdapters as full } from "../push/registry.js";`,
					`import { type PlatformAdapterRegistry, sendableAdapters } from "../push/registry";`,
					`import {`,
					`	createPlatformAdapterRegistry,`,
					`	sendableAdapters,`,
					`} from "../push/registry.js";`,
				].join("\n"),
			),
		).toEqual([1, 2, 3, 4]);
	});

	it("re-export、整包引、动态 import、require 都算", () => {
		expect(
			linesIn(
				[
					`export { sendableAdapters } from "./registry.js";`,
					`export * from "./registry.js";`,
					`import * as registry from "../push/registry.js";`,
					`const m = await import("../push/registry.js");`,
					`const r = require("../push/registry.js");`,
				].join("\n"),
			),
		).toEqual([1, 2, 3, 4, 5]);
	});
});

describe("碰到特权取法的判据:不算", () => {
	it("从登记表引别的名字不算", () => {
		expect(
			linesIn(
				[
					`import type { PlatformAdapterRegistry } from "../push/registry.js";`,
					`import { createPlatformAdapterRegistry, deriveAdapterRegistry } from "./registry.js";`,
					`import {`,
					`	type PlatformAdapterView,`,
					`	deriveAdapterRegistry,`,
					`} from "../push/registry.js";`,
				].join("\n"),
			),
		).toEqual([]);
	});

	it("注释、字符串里的字样,和别的模块里的同名东西不算", () => {
		expect(
			linesIn(
				[
					`// import { sendableAdapters } from "./registry.js";`,
					`const s = 'import { sendableAdapters } from "./registry.js"';`,
					`import { sendableAdapters } from "./somewhere-else.js";`,
				].join("\n"),
			),
		).toEqual([]);
	});
});

describe("出口咽喉", () => {
	const hits = listSources(THROAT_ROOTS).flatMap((file) =>
		throatImports(parseSource(file)).map((hit) => `${file}:${hit.line} ${hit.text}`),
	);

	it("派发器自己引着那个取法(不然这道守卫守的是空气)", () => {
		expect(hits.filter((hit) => hit.startsWith(`${THROAT_FILE}:`))).toHaveLength(1);
	});

	it("除了派发器,谁也不引", () => {
		expect(hits.filter((hit) => !hit.startsWith(`${THROAT_FILE}:`))).toEqual([]);
	});
});
