import { describe, expect, it } from "vite-plus/test";
import { importsOf, listSources, parseSource } from "../source-scan.mjs";

/**
 * 守卫 17:集成不读写文件。
 *
 * B 站(`bilibili/`)与内置平台适配器(`platforms/`)都是集成(ADR-0025 决策 1):要存东西只经宿主给的
 * `ctx.state` / `ctx.secrets`,要图只经 `ctx.fetchImage` / `ctx.storeImage`,自己不碰盘。所以这两个目录里
 * 出现 `fs` 的 import 就红 —— 带不带 `node:` 前缀、`fs/promises`、`import type`、`require`、动态 import 都算。
 *
 * 没有白名单、没有棘轮:开张时两个目录都是干净的。3a 把 B 站四个包搬进 `bilibili/` 时,这道守卫就是
 * 「搬进来的代码不许带着读写文件的习惯」的那道闸。不扫测试(测试要用临时目录)。
 *
 * 判据写成纯函数 + 样例,因为判据本身也会写错:一条永远判 OK 的规则跟没有一样。
 */

/** 集成的目录。 */
export const INTEGRATION_ROOTS = ["apps/server/src/bilibili", "apps/server/src/platforms"];

const FS_MODULE = /^(node:)?fs(\/.*)?$/;

/**
 * 一份源码里引用文件系统模块的地方。
 *
 * @param source `parseSource` 的结果
 * @returns `{ line, text }[]`,按出现顺序
 */
export function fsImports(source) {
	const lines = source.text.split("\n");
	return importsOf(source)
		.filter((ref) => FS_MODULE.test(ref.specifier))
		.map((ref) => ({ line: ref.line, text: lines[ref.line - 1].trim() }));
}

/** 把一段样例当成源码,返回命中的行号。 */
const linesIn = (text) =>
	fsImports(parseSource("apps/server/src/bilibili/sample.ts", text)).map((hit) => hit.line);

describe("引用文件系统的判据:算", () => {
	it("带不带 node: 前缀、promises 子路径都算", () => {
		expect(
			linesIn(
				[
					`import { readFile } from "node:fs/promises";`,
					`import { existsSync } from "node:fs";`,
					`import fs from "fs";`,
					`import { writeFile } from "fs/promises";`,
				].join("\n"),
			),
		).toEqual([1, 2, 3, 4]);
	});

	it("import type、re-export、动态 import、require 都算", () => {
		expect(
			linesIn(
				[
					`import type { Stats } from "node:fs";`,
					`export { readFile } from "node:fs/promises";`,
					`const fs = await import("node:fs/promises");`,
					`const { readFileSync } = require("node:fs");`,
				].join("\n"),
			),
		).toEqual([1, 2, 3, 4]);
	});

	it("命中带那一行的源码", () => {
		expect(
			fsImports(
				parseSource(
					"apps/server/src/platforms/sample.ts",
					`import { z } from "zod";\nimport { readFile } from "node:fs/promises";`,
				),
			),
		).toEqual([{ line: 2, text: `import { readFile } from "node:fs/promises";` }]);
	});
});

describe("引用文件系统的判据:不算", () => {
	it("名字里带 fs 的别的模块、路径模块", () => {
		expect(
			linesIn(
				[
					`import { x } from "fs-extra";`,
					`import { y } from "node:fsevents";`,
					`import { join } from "node:path";`,
					`import { z } from "./fs.js";`,
					`import { w } from "@bilibili-notify/storage";`,
				].join("\n"),
			),
		).toEqual([]);
	});

	it("注释与字符串里的字样", () => {
		expect(
			linesIn(
				[`// import { readFile } from "node:fs";`, `const hint = 'import fs from "fs"';`].join(
					"\n",
				),
			),
		).toEqual([]);
	});
});

describe("守卫 17:集成的目录里没有文件系统的 import", () => {
	const files = listSources(INTEGRATION_ROOTS);

	it("两个目录都扫到了源码(扫空了等于没有这道守卫)", () => {
		for (const root of INTEGRATION_ROOTS) {
			expect(
				files.some((file) => file.startsWith(`${root}/`)),
				root,
			).toBe(true);
		}
	});

	it("一处都没有", () => {
		const hits = files.flatMap((file) =>
			fsImports(parseSource(file)).map((hit) => `${file}:${hit.line}  ${hit.text}`),
		);
		expect(hits, "集成要存东西经 ctx.state / ctx.secrets,要图经 ctx.fetchImage").toEqual([]);
	});
});
