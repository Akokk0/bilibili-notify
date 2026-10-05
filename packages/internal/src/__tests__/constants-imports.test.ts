/**
 * 零依赖子路径的源文件(`constants.ts`、`format.ts`)**只许有 type import** —— 这条以前只是
 * 文件头上的一句话。
 *
 * 它们经 `@bilibili-notify/internal/constants`、`/format` 子路径**直供浏览器端运行时消费**,所以一条
 * 值级 import 就能把 zod(以及它拽着的整张 schema 图)拉进前端 bundle。症状不是报错,
 * 是**产物悄悄胖一圈**,而门禁全绿。
 *
 * `import type` 编译后整条擦掉,所以它随便写;值级的一条都不许有 —— 顺带也就杜绝了
 * 「A 只 import 了 B、B 才 import zod」那种传递路径。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

/** 零依赖子路径的源文件。新开一个这样的子路径,就在这里加一行。 */
// `bilibili-guard.ts` 经 `/bilibili-guard` 子路径供面板读 B 站的档位表(㉓e),同一条纪律。
const ZERO_DEP_SOURCES = ["constants.ts", "format.ts", "bilibili-guard.ts"];

function sourceOf(file: string): string {
	return readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), "utf8");
}

/** 所有从别的模块取东西的语句 —— `import … from`、`export … from`、动态 `import()`。 */
function moduleReferences(source: string): string[] {
	return source
		.split("\n")
		.map((line) => line.trim())
		.filter(
			(line) =>
				/^import\b/.test(line) || /^export\b.*\bfrom\b/.test(line) || /\bimport\s*\(/.test(line),
		);
}

describe("零依赖子路径的 import 纪律", () => {
	it.each(ZERO_DEP_SOURCES)("%s 的每一条都得是 type import —— 值级的一条都不许有", (file) => {
		const offenders = moduleReferences(sourceOf(file)).filter(
			(line) => !/^import\s+type\b/.test(line) && !/^export\s+type\b/.test(line),
		);
		expect(offenders).toEqual([]);
	});
});
