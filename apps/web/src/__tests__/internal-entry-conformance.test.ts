/// <reference types="node" />
/**
 * internal 入口 conformance —— 扫 `apps/web/src` 全部非测试源码,断言对
 * `@bilibili-notify/internal` **根入口**的引用一律是 `import type` / `export type`
 * (编译后擦除)。要值就走零依赖子路径 `@bilibili-notify/internal/constants`
 * (或 `/patch`、`/template-defaults`)。
 *
 * 为什么需要静态护栏:根入口把 **zod** 拽进来,而这件事在任何门禁下都是绿的 ——
 * typecheck 绿(类型没错)、Biome 绿(import 合法)、全部组件测试绿(vitest 不打包,
 * 根本不在意 bundle 里有什么)。**唯一的症状是浏览器多下几十 KB**,没人会注意。
 *
 * 这不是假想:`pages/up/helpers.ts` 曾经写成
 * `export { colorFromUid, UP_COLORS } from "@bilibili-notify/internal"` —— 只为一个
 * 调色板,整个 zod(产物里 300+ 处引用)被打进页面。修法是把那两个值搬进零依赖的
 * `constants.ts`(见那边「UP 主强调色」那一段),这条测试钉住它不再回来。
 *
 * `astrbot/page` 同一条纪律,它那侧目前是干净的(`api/types.ts` 全 `import type`,
 * 值走 `/constants`)。测试留在 web 是因为这里的引用点最多、最容易顺手写错。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(TEST_DIR, "..");

/**
 * 一条 import / export … from **根入口** 的语句。`[\s\S]` 吃跨行的具名列表,`^`/`$`
 * 锚在**按分号切出来的单条语句**上。
 *
 * 不能直接拿全文去松匹配:那样 `from "@bilibili-notify/internal/constants"` 那条
 * (合法)语句的开头会跟后面某条根入口语句的结尾配成一对,报出一片假阳性。同理
 * 注释里出现「`import type`」四个字也会被卷进来 —— 所以先剥注释再切。
 */
const STATEMENT_RE = /^\s*(import|export)\b([\s\S]*?)\bfrom\s+"@bilibili-notify\/internal"\s*$/;

/** 剥掉块注释与行注释。`[^:]` 那一手是为了别把 `https://` 当行注释切了。 */
function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function listSourcesRecursive(dir: string): string[] {
	const acc: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			// 测试自己可以从根入口拿值 —— 它们不进 bundle。
			if (entry === "__tests__") continue;
			acc.push(...listSourcesRecursive(full));
			continue;
		}
		if (!/\.tsx?$/.test(full)) continue;
		if (/\.test\.tsx?$/.test(full)) continue;
		acc.push(full);
	}
	return acc;
}

/**
 * 这条语句是不是**类型专用**。
 *
 * 两种写法都算:整句 `import type { … }`,以及逐项 `import { type A, type B }`。
 * 只要有一项不带 `type`,编译后就会留下一条真实 import —— 那就是把 zod 拖进来的
 * 那一条。default / namespace 导入(`import x from`、`import * as x from`)一律算值。
 */
function isTypeOnly(clause: string): boolean {
	const body = clause.trim();
	if (body.startsWith("type ")) return true;
	const braced = body.match(/^\{([\s\S]*)\}$/);
	if (!braced) return false; // default / namespace / 裸副作用导入
	const specifiers = (braced[1] ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	return specifiers.length > 0 && specifiers.every((s) => s.startsWith("type "));
}

describe("apps/web 不得从 internal 根入口拿值", () => {
	it("对根入口的引用一律 import type / export type —— 否则 zod 进 bundle", () => {
		const offenders: string[] = [];
		for (const file of listSourcesRecursive(SRC_DIR)) {
			for (const chunk of stripComments(readFileSync(file, "utf8")).split(";")) {
				const m = chunk.match(STATEMENT_RE);
				if (!m || isTypeOnly(m[2] ?? "")) continue;
				offenders.push(`${relative(SRC_DIR, file)}: ${m[0].replace(/\s+/g, " ").trim()}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("护栏本身认得出违规写法 —— 免得它悄悄退化成一条永远通过的测试", () => {
		// 这条测的是 `isTypeOnly` 而不是仓库现状:上面那条在仓库干净时无论判据对不对
		// 都是绿的,所以判据得自己有一条测试。
		expect(isTypeOnly("type { GlobalConfig }")).toBe(true);
		expect(isTypeOnly("{ type A, type B }")).toBe(true);
		expect(isTypeOnly("{ colorFromUid, UP_COLORS }")).toBe(false);
		expect(isTypeOnly("{ type A, colorFromUid }")).toBe(false);
		expect(isTypeOnly(" everything ")).toBe(false); // default 导入
		expect(isTypeOnly(" * as internal ")).toBe(false); // namespace 导入
	});
});
