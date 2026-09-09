/**
 * `constants.ts` **只许有 type import** —— 这条以前只是文件头上的一句话。
 *
 * 它经 `@bilibili-notify/internal/constants` 子路径**直供浏览器端运行时消费**,所以一条
 * 值级 import 就能把 zod(以及它拽着的整张 schema 图)拉进前端 bundle。症状不是报错,
 * 是**产物悄悄胖一圈**,而门禁全绿。
 *
 * `import type` 编译后整条擦掉,所以它随便写;值级的一条都不许有 —— 顺带也就杜绝了
 * 「A 只 import 了 B、B 才 import zod」那种传递路径。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const SOURCE = readFileSync(fileURLToPath(new URL("./constants.ts", import.meta.url)), "utf8");

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

describe("constants.ts 的 import 纪律", () => {
	it("每一条都得是 type import —— 值级的一条都不许有", () => {
		const offenders = moduleReferences(SOURCE).filter(
			(line) => !/^import\s+type\b/.test(line) && !/^export\s+type\b/.test(line),
		);
		expect(offenders).toEqual([]);
	});
});
