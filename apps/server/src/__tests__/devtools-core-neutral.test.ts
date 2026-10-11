/**
 * 核心 `src/devtools/` 不认识任何一家来源:里面(非测试文件)不许有任何对 `bilibili/` 的 import ——
 * 含 `import type`、副作用 import、动态 `import()`、`export ... from`。B 站的场景在
 * `src/bilibili/devtools/` 里,经登记表 `devtoolsProviders` 汇进来(ADR-0021 决策 54)。
 * 入口文件 `src/index.ts` 与组装根 `src/compose.ts` 引用 `bilibili/` 是允许的,不在这条的范围里。
 *
 * 认的是**模块说明符**(`from "…"` / `import("…")` / `import "…"` 后面那串字),不是整行文字:
 * 注释里提一句「bilibili/」不该误报。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const CORE_DEVTOOLS = join(SRC, "devtools");
// 三种写法:`from "x"`、`import("x")`、裸 `import "x"`。说明符不跨行。
const MODULE_REF = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"'\n]+)["']/g;

function* sources(dir: string): Generator<string> {
	for (const name of readdirSync(dir)) {
		if (name === "__tests__" || name === "node_modules") continue;
		const full = join(dir, name);
		if (statSync(full).isDirectory()) yield* sources(full);
		else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) yield full;
	}
}

/** 一段源码里指向 `bilibili/` 的模块说明符。 */
function bilibiliImportsIn(text: string): string[] {
	return [...text.matchAll(MODULE_REF)]
		.map((m) => m[1] ?? "")
		.filter((spec) => /(?:^|\/)bilibili\//.test(spec));
}

describe("核心 devtools 不 import bilibili/", () => {
	it("src/devtools 里没有任何指向 bilibili/ 的说明符", () => {
		const offenders: string[] = [];
		for (const file of sources(CORE_DEVTOOLS)) {
			for (const spec of bilibiliImportsIn(readFileSync(file, "utf8"))) {
				offenders.push(`${relative(SRC, file)} → ${spec}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("识别得出各种写法(`import type`、动态、副作用、转出);注释里的不算", () => {
		const text = [
			'import type { Api } from "../bilibili/api/index.js";',
			'import { x } from "../bilibili/live/protocol/client.js";',
			'const m = await import("../bilibili/devtools/index.js");',
			'import "../bilibili/side-effect.js";',
			'export { y } from "../../bilibili/z.js";',
			'// 说的是 "bilibili/" 目录,但这是注释',
			'import { ok } from "../runtime/mute-state.js";',
		].join("\n");
		expect(bilibiliImportsIn(text)).toEqual([
			"../bilibili/api/index.js",
			"../bilibili/live/protocol/client.js",
			"../bilibili/devtools/index.js",
			"../bilibili/side-effect.js",
			"../../bilibili/z.js",
		]);
	});
});
