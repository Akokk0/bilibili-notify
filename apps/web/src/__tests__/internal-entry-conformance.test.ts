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

import { describe, expect, it } from "vite-plus/test";
import {
	type ImportRef,
	importsOf,
	listSources,
	parseSource,
} from "../../../../scripts/source-scan.mjs";

/** 根入口:把 zod 拽进来的那一个。子路径(`/constants` 等)是零依赖的,不在此列。 */
const INTERNAL_ROOT = "@bilibili-notify/internal";

/**
 * 对根入口的引用里,哪些**不是**类型专用的 —— 编译后会留下一条真实引用的那些。
 *
 * 类型专用有两种写法:整句 `import type { … }` / `export type { … }`,以及逐项
 * `import { type A, type B }`。只要有一项不带 `type`,编译后就会留下一条真实 import ——
 * 那就是把 zod 拖进来的那一条。default / namespace 导入、`export *`、裸副作用导入、
 * 字面量的动态 `import()` 一律算值;类型位置的 `import("…").T` 会擦除,不算。
 */
function valueRefsToInternalRoot(refs: readonly ImportRef[]): ImportRef[] {
	return refs.filter((ref) => ref.specifier === INTERNAL_ROOT && !ref.typeOnly);
}

/** 一段样例源码里对根入口的取值引用。 */
const offendersIn = (text: string, path = "sample.tsx") =>
	valueRefsToInternalRoot(importsOf(parseSource(path, text)));

describe("apps/web 不得从 internal 根入口拿值", () => {
	it("对根入口的引用一律 import type / export type —— 否则 zod 进 bundle", () => {
		// 连 `.ts` 一起收:从根入口取值的写法在纯逻辑文件里一样会把 zod 拖进 bundle。
		// 默认不含测试:测试自己可以从根入口拿值 —— 它们不进 bundle。
		const files = listSources(["apps/web/src"]);
		// 一份都没扫到 = 这条守卫在空转,那比没有还糟。
		expect(files.length).toBeGreaterThan(0);

		const offenders: string[] = [];
		for (const file of files) {
			const source = parseSource(file);
			const lines = source.text.split("\n");
			for (const ref of valueRefsToInternalRoot(importsOf(source))) {
				offenders.push(`${file}:${ref.line}: ${lines[ref.line - 1]?.trim()}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("护栏本身认得出违规写法 —— 免得它悄悄退化成一条永远通过的测试", () => {
		// 这条测的是判据而不是仓库现状:上面那条在仓库干净时无论判据对不对都是绿的,
		// 所以判据得自己有一条测试。
		const from = (clause: string) => offendersIn(`import ${clause} from "${INTERNAL_ROOT}";`);
		expect(from("type { GlobalConfig }")).toEqual([]);
		expect(from("{ type A, type B }")).toEqual([]);
		expect(from("type Everything")).toEqual([]);
		expect(from("{ colorFromUid, UP_COLORS }")).toHaveLength(1);
		expect(from("{ type A, colorFromUid }")).toHaveLength(1);
		expect(from("everything")).toHaveLength(1); // default 导入
		expect(from("* as internal")).toHaveLength(1); // namespace 导入
	});

	it("护栏认得 export … from、跨行列表、副作用与动态引用;认不得的是注释、字符串和别的入口", () => {
		expect(offendersIn(`export { colorFromUid } from "${INTERNAL_ROOT}";`)).toHaveLength(1);
		expect(offendersIn(`export * from "${INTERNAL_ROOT}";`)).toHaveLength(1);
		expect(offendersIn(`export type { GlobalConfig } from "${INTERNAL_ROOT}";`)).toEqual([]);
		// 跨行的具名列表:最后一项不带 type 就是值。
		expect(
			offendersIn(`import {\n\ttype A,\n\ttype B,\n\tcolorFromUid,\n} from "${INTERNAL_ROOT}";`),
		).toHaveLength(1);
		expect(offendersIn(`import {\n\ttype A,\n\ttype B,\n} from "${INTERNAL_ROOT}";`)).toEqual([]);
		expect(offendersIn(`import "${INTERNAL_ROOT}";`)).toHaveLength(1);
		expect(offendersIn(`const m = await import("${INTERNAL_ROOT}");`)).toHaveLength(1);
		expect(offendersIn(`type T = import("${INTERNAL_ROOT}").GlobalConfig;`)).toEqual([]);

		// 零依赖子路径是合法的取值入口;别的包不归这条管。
		expect(offendersIn(`import { UP_COLORS } from "${INTERNAL_ROOT}/constants";`)).toEqual([]);
		expect(offendersIn(`import { z } from "zod";`)).toEqual([]);

		// 注释、字符串里写得再像也不算(原先的按分号切语句会被它们绊倒)。
		expect(
			offendersIn(
				[
					`// import { colorFromUid } from "${INTERNAL_ROOT}";`,
					`/* import type 与 export { x } from "${INTERNAL_ROOT}" */`,
					`const hint = 'import { x } from "${INTERNAL_ROOT}"';`,
				].join("\n"),
			),
		).toEqual([]);
		// 分号相邻的两条:合法的子路径语句不会和后面的根入口语句配成一对。
		expect(
			offendersIn(
				`import { a } from "${INTERNAL_ROOT}/constants"; import type { B } from "${INTERNAL_ROOT}";`,
			),
		).toEqual([]);
	});
});
