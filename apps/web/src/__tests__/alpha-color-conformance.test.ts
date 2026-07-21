/// <reference types="node" />
/**
 * alpha 拼接颜色 conformance —— 扫 `apps/web/src/{pages,components}` 全 .tsx,
 * 断言传给 `accent=` / `color=` 的值不是 `var(--…)`。
 *
 * 为什么需要静态护栏:`GlassPanel` / `GlassStatCard` 会把这个值**拼上 alpha 后缀**
 * 来造渐变底色与描边:
 *
 *     background: `linear-gradient(135deg, ${color}1a, …)`
 *     border:     `1px solid ${color}33`
 *
 * 传十六进制(`#fb7299`)会得到合法的 `#fb72991a`;传 CSS 变量则拼出
 * `var(--color-bn-pink)1a` —— **非法值,浏览器静默丢弃整条声明**。于是 KPI 卡
 * 失去底色和边框、面板失去 accent 光晕,而 typecheck 管不着(那是字符串)、
 * Biome 管不着、组件测试查 role/文本也管不着 —— **整套门禁全绿,卡片却是裸的**。
 * 数据统计页初版就这么翻过车,只能靠肉眼发现。
 *
 * 只管这两个会参与拼接的 prop。SVG 属性(`fill` / `stroke`)直接吃 `var()`,
 * 完全合法,不在此列。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(TEST_DIR, "..");

/** 只有这两个 prop 会被拼 alpha 后缀。 */
const ALPHA_PROPS = ["accent", "color"] as const;

function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) {
			if (name !== "__tests__") walk(full, out);
		} else if (full.endsWith(".tsx")) {
			out.push(full);
		}
	}
	return out;
}

describe("alpha 拼接颜色 conformance", () => {
	it("accent= / color= 不得传 var(--…) —— 拼上 alpha 后缀会变成非法 CSS", () => {
		const offenders: string[] = [];
		for (const dir of ["pages", "components"]) {
			for (const file of walk(join(SRC_DIR, dir))) {
				const src = readFileSync(file, "utf8");
				for (const prop of ALPHA_PROPS) {
					// 只匹配 JSX 上的字面量写法 accent={VAR} / color="var(--…)";
					// 变量透传(color={focusColor})交由值的定义处负责。
					// 不带 `g`:只 test 一次,而带 `g` 的正则会记住 lastIndex ——
					// 哪天有人把它提到循环外复用,第二次 test 就会从上次的位置续查、
					// 静默漏报。这里没有多次匹配的需求,别留这个隐患。
					const re = new RegExp(`${prop}=\\{?["'\`]?var\\(--`);
					if (re.test(src)) {
						offenders.push(`${relative(SRC_DIR, file)} 的 ${prop}=`);
					}
				}
			}
		}
		expect(offenders).toEqual([]);
	});
});
