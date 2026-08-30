/**
 * 静态守卫 —— Markdown 那一坨代码不许进初始包。
 *
 * `react-markdown` 连带 micromark / mdast 那一整套约 **153KB**(实测:主 chunk
 * 1029KB → 876KB)。站里有两处要渲染 Markdown(AI 聊天、关于页的更新日志与新手
 * 指引),两处都特意做成懒加载 —— 只要**任何一条从入口出发的静态链**碰到这个库,
 * 153KB 就进初始包,每次打开 dashboard 都加载,而所有 `lazy()` 一起变成摆设
 * (库已在主包里,没东西可懒)。
 *
 * **这道守卫原先只扫 `components/ai-chat/` 一个目录,于是漏了真事**:
 * 2026-08-30 新手指引的 `pages/guide/guide-markdown.tsx` 静态引了 react-markdown,
 * 三条测试全绿,库却已经躺进主 chunk(懒块从 153KB 缩到 2.6KB)。改回懒边界后
 * 实测主 chunk 1137KB → 970KB。所以现在改成**从入口爬静态可达图**:守的是
 * 「主包里有没有它」这件事本身,而不是某个目录的写法 —— 新文件放哪儿都躲不过。
 *
 * 扫源码而不查产物:产物断言要求先跑一遍 build,而 `vp test` 不该有那个前提。
 */

import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { blankComments } from "./source-text";
import { listSources } from "./walk";

const SRC = resolve(dirname(fileURLToPath(new URL("./placeholder", import.meta.url))), "..");
const ENTRY = join(SRC, "main.tsx");

/** 重依赖的裸包名 —— 静态可达即失败。 */
const HEAVY = /^(?:react-markdown|remark-[\w-]+)$/;

/**
 * 允许**持有** react-markdown 运行时 import 的模块(相对 `apps/web/src`)。
 * 它们各自是一个懒加载边界后面的东西;边界在不在,由上面那条可达性测试管。
 */
const HEAVY_HOLDERS = ["components/ai-chat/markdown.tsx", "pages/guide/guide-markdown.tsx"];

/** 爬静态图时不当模块看的后缀(样式、原文、图片…)。 */
const NON_JS = /\.(?:css|md|json|svg|png|jpe?g|webp|txt|ya?ml)(?:\?.*)?$/;

/**
 * 一个文件里的**静态** import / re-export 目标。
 *
 * - `import type` / `export type` 不算:编译期擦除,不产生运行时依赖;
 * - 动态 `import("…")` 不算 —— 那正是懒加载边界,爬到这里就该停。正则要求
 *   `import` 后面跟空白再跟引号(或 `… from "…"`),`import(` 两种形态都对不上。
 */
function staticDeps(file: string): string[] {
	const text = blankComments(readFileSync(file, "utf8"));
	const out: string[] = [];
	// `[^;]*?` 可以跨行(多行 import),但吃不过分号 —— 站里 import 全部以分号收尾。
	const withFrom = /(?:^|\n)\s*(?:import|export)(\s+type)?[^;]*?\sfrom\s*["']([^"']+)["']/g;
	for (const m of text.matchAll(withFrom)) if (!m[1]) out.push(m[2] as string);
	const sideEffect = /(?:^|\n)\s*import\s+["']([^"']+)["']/g;
	for (const m of text.matchAll(sideEffect)) out.push(m[1] as string);
	return out;
}

/** 相对说明符 → 磁盘路径。解析不出来返回 null(调用方会把它记进 unresolved)。 */
function resolveRelative(fromFile: string, spec: string): string | null {
	// 站里两种写法并存:无后缀的 `./x`,与 NodeNext 式的 `./x.js`(源文件是 .ts)
	const base = resolve(dirname(fromFile), spec.replace(/\?.*$/, "").replace(/\.js$/, ""));
	for (const cand of [
		base,
		`${base}.ts`,
		`${base}.tsx`,
		join(base, "index.ts"),
		join(base, "index.tsx"),
	]) {
		try {
			if (readFileSync(cand)) return cand;
		} catch {
			// 试下一个候选
		}
	}
	return null;
}

/** 从入口出发的静态可达集。返回访问过的文件、撞上的重依赖、解析不出的说明符。 */
function crawl(): { visited: Set<string>; heavy: string[]; unresolved: string[] } {
	const visited = new Set<string>();
	const heavy: string[] = [];
	const unresolved: string[] = [];
	const queue = [ENTRY];
	while (queue.length > 0) {
		const file = queue.pop() as string;
		if (visited.has(file)) continue;
		visited.add(file);
		for (const spec of staticDeps(file)) {
			if (!spec.startsWith(".")) {
				if (HEAVY.test(spec)) heavy.push(`${relative(SRC, file)} → ${spec}`);
				continue; // 其余裸包不进 node_modules 爬
			}
			if (NON_JS.test(spec)) continue;
			const target = resolveRelative(file, spec);
			if (target === null) unresolved.push(`${relative(SRC, file)} → ${spec}`);
			else queue.push(target);
		}
	}
	return { visited, heavy, unresolved };
}

describe("markdown 重依赖不许进初始包", () => {
	it("从 main.tsx 出发的静态可达图里没有 react-markdown / remark-*", () => {
		const { visited, heavy, unresolved } = crawl();
		// 爬歪了(解析不出、只走到几个文件)会让守卫安静地失效,先钉住爬得动
		expect(unresolved, "静态说明符没解析出来,守卫射程有洞").toEqual([]);
		expect(visited.size).toBeGreaterThan(80);
		expect(visited.has(join(SRC, "pages", "About.tsx"))).toBe(true);
		expect(heavy, '库要放在懒加载边界后面:lazy(() => import("…")),别从入口静态引到').toEqual([]);
	});

	it("只有指定的那两个模块持有 react-markdown 的运行时 import", () => {
		const files = listSources(SRC, {
			exts: [".ts", ".tsx"],
			skipTestDirs: true,
			skipTestFiles: true,
		});
		expect(files.length).toBeGreaterThan(80); // 目录没扫到时别假绿
		const offenders: string[] = [];
		for (const file of files) {
			const rel = relative(SRC, file);
			if (HEAVY_HOLDERS.includes(rel)) continue;
			// `import type { Components } from "react-markdown"` 不算 —— 类型会被擦除,
			// doc-markdown.tsx 正是靠这条只导出组件映射、把 eager/lazy 留给消费方。
			if (staticDeps(file).some((s) => HEAVY.test(s))) offenders.push(rel);
		}
		expect(offenders, `新增持有点请一并写进 HEAVY_HOLDERS 并确认它在懒边界后`).toEqual([]);
	});

	it("指定的持有模块确实装着那个重依赖 —— 守卫别守了个空壳", () => {
		// 上面两条只说「别人没引」。万一哪天有人把 react-markdown 挪出去,
		// 两条都会继续绿,而依赖已经跑到别处了。
		for (const rel of HEAVY_HOLDERS) {
			const text = readFileSync(join(SRC, rel), "utf8");
			expect(text, `${rel} 不再持有 react-markdown`).toMatch(/from\s+["']react-markdown["']/);
		}
	});
});
