/**
 * 核心 `src/devtools/` 不认识任何一家来源:里面(非测试文件)不许有任何对 `bilibili/` 的 import ——
 * 含 `import type`、副作用 import、动态 `import()`、`export ... from`。B 站的场景在
 * `src/bilibili/devtools/` 里,经登记表 `devtoolsProviders` 汇进来(ADR-0021 决策 54)。
 * 入口文件 `src/index.ts` 与组装根 `src/compose.ts` 引用 `bilibili/` 是允许的,不在这条的范围里。
 *
 * 认的是**模块说明符**(`from "…"` / `import("…")` / `import "…"` 后面那串字),不是整行文字:
 * 注释里提一句「bilibili/」不该误报。
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import {
	findNodes,
	importsOf,
	isInside,
	parseSource,
	resolveSpecifier,
	ts,
} from "../../../../scripts/source-scan.mjs";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const CORE_DEVTOOLS = join(SRC, "devtools");
const REPO_EXTENSIONS = join(SRC, "../../..", "extensions");
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

/** 仓里每个拓展清单声明的 id。 */
function extensionIdsIn(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.flatMap((entry) => {
			const manifestFile = join(dir, entry.name, "extension.json");
			if (!existsSync(manifestFile)) return [];
			const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as {
				id?: unknown;
			};
			if (typeof manifest.id !== "string") {
				throw new Error(`${entry.name}/extension.json 没有字符串 id`);
			}
			return [manifest.id];
		})
		.sort();
}

/** 相对说明符从核心 devtools 解析出来之后，是不是落在仓根 `extensions/`。 */
function pointsAtRepoExtensions(file: string, specifier: string): boolean {
	const resolved = resolveSpecifier(file, specifier);
	return resolved !== undefined && isInside(resolved, "extensions");
}

/**
 * 一段核心源码里点到拓展的地方:整字符串字面量等于某个拓展 id,或模块说明符指向仓根
 * `extensions/`。按行号给出,方便守卫直接点名;注释和更长的句子里带 id 都不算。
 */
export function extensionReferencesIn(
	source: ReturnType<typeof parseSource>,
	extensionIds: ReadonlySet<string>,
): string[] {
	const found: { line: number; detail: string }[] = [];
	for (const hit of findNodes(source, (node) => {
		return (
			(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
			extensionIds.has(node.text)
		);
	})) {
		const literal = hit.node as ts.StringLiteral | ts.NoSubstitutionTemplateLiteral;
		found.push({ line: hit.line, detail: `literal "${literal.text}"` });
	}
	for (const ref of importsOf(source)) {
		if (pointsAtRepoExtensions(source.path, ref.specifier)) {
			found.push({ line: ref.line, detail: `module "${ref.specifier}"` });
		}
	}
	return found
		.sort((a, b) => a.line - b.line || a.detail.localeCompare(b.detail))
		.map((hit) => `${hit.line}: ${hit.detail}`);
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

describe("核心 devtools 不认识任何拓展", () => {
	it("src/devtools 里没有拓展 id 的字面量,也没有指向仓根 extensions/ 的说明符", () => {
		const ids = new Set(extensionIdsIn(REPO_EXTENSIONS));
		const offenders: string[] = [];
		for (const file of sources(CORE_DEVTOOLS)) {
			for (const hit of extensionReferencesIn(parseSource(file), ids)) {
				offenders.push(`${relative(SRC, file)} → ${hit}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("整串 id 与指向仓根 extensions/ 的说明符都认;注释、长句与别处的 extensions/ 不算", () => {
		const text = [
			'const selected = "bridge";',
			"const fake = `fake-source`;",
			'// 注释里写 "bridge" 不算',
			'const nearby = "bridgeway";',
			'import type { Frame } from "../../../../../extensions/bridge/src/contract.js";',
			'const server = await import("../extensions/discovery.js");',
			'import { wire } from "@bilibili-notify/extension/wire";',
			'const label = "已装 bridge";',
			"const dynamic = await import(`../../../../../extensions/fake-source/src/devtools.mjs`);",
			'const flags = { "bridge": true };',
		].join("\n");
		const source = parseSource("apps/server/src/devtools/scenarios/sample.ts", text);

		expect(extensionReferencesIn(source, new Set(["bridge", "fake-source"]))).toEqual([
			'1: literal "bridge"',
			'2: literal "fake-source"',
			'5: module "../../../../../extensions/bridge/src/contract.js"',
			'9: module "../../../../../extensions/fake-source/src/devtools.mjs"',
			'10: literal "bridge"',
		]);
	});
});
