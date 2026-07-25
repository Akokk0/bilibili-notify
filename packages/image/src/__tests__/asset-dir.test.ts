/**
 * 单元测试 —— 自带静态资源的定位,以及「ESM 源码里不许用裸 `__dirname`」这条守卫。
 *
 * 起因是主人报的一个 bug:dev 服务器下生成词云当场
 * `__dirname is not defined`。这些包全是 ESM(`"type": "module"`),源码里本来就没有
 * 这个变量;当时 `vite.config.ts` 开着 `shims: true`,给**产物**注入了一个,所以
 * 生产一直好的。而 dev 服务器不走产物 —— `apps/server/tsconfig.dev.json` 的 paths
 * 把工作区包直接映到各包的 `src/index.ts`,tsx 加载源码,shim 无从注入。
 *
 * 修法是改用 `dirname(fileURLToPath(import.meta.url))`(见 ASSET_DIR),源码与两种
 * 产物都成立,那个 shims 开关也就一并撤了。
 *
 * ## 为什么守卫是「扫源码」而不是「跑一遍」
 *
 * 因为 vitest **会**给源码注入 `__dirname`(它的 SSR 变换为 CJS 互操作补的)。
 * 也就是说在这个测试文件里调 `generateWordCloudImg`,裸 `__dirname` 照样能过 ——
 * 那是一条假绿的测试,恰恰漏掉的就是主人踩到的这个坑。实测确认过:同一段代码在
 * `tsx --tsconfig tsconfig.dev.json` 下报 `__dirname is not defined`,在 vitest 下
 * 一切正常。
 *
 * 所以要抓住它只有两条路:去 spawn 一个 tsx 进程(慢且脆),或者**静态扫源码**。
 * 取后者。
 */

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { ASSET_DIR } from "../image-renderer";
import { buildWordCloudHtml } from "../templates/wordcloud";

describe("ASSET_DIR — 自带静态资源的所在", () => {
	it("目录下确实躺着词云那两个脚本", () => {
		// 源码下是 `src/static/`,打包产物下是 `lib/static/`(pack 的 copy 规则搬过去)。
		// 两边相对 ASSET_DIR 都是同级的 `static/`,所以同一行代码两种形态都成立。
		expect(existsSync(join(ASSET_DIR, "static/wordcloud2.min.js"))).toBe(true);
		expect(existsSync(join(ASSET_DIR, "static/render.js"))).toBe(true);
	});

	it("拿它真能把两个脚本读进词云 HTML —— 不是只算出一个看着像的路径", async () => {
		const html = await buildWordCloudHtml("咩栗", [["弹幕", 3]], ASSET_DIR);
		// wordcloud2.min.js 的入口名与 render.js 里的函数名,各证明一个文件读到了。
		expect(html).toContain("WordCloud");
		expect(html).toContain("renderAutoFitWordCloud");
	});
});

/**
 * 谁把这个包打进 bundle,谁就得把 `static/` 一起搬过去。
 *
 * `ASSET_DIR` 指的是「本模块所在的那个目录」。被内联进别人的 bundle 之后,那就变成
 * **别人的**产物目录 —— pack 给 `packages/image/lib/` 拷的那一份完全帮不上忙。三个
 * 下游打包目标各自得管自己:
 *
 *   - koishi 插件         → `koishi/lib/static/`
 *   - 独立端 server bundle → `dist/static/`
 *   - AstrBot sidecar     → `app/static/`
 *
 * koishi 这一处就漏过:它的构建只拷了 jieba 的 wasm,`static/` 没管,于是词云在
 * koishi 端必 ENOENT —— 而且构建全绿,打出来的 npm 包也全绿,只有用户点一次词云
 * 才看得到。这条测试就是为了不再漏第二次。
 *
 * 只查「配置里声明了没有」而不去查产物:`vp test` 不该依赖先跑一遍 build。产物层面
 * 的验证靠手动跑一次真实词云(三种形态都跑过)。
 */
describe("凡是内联 image 的打包目标,都必须随包带 static/", () => {
	const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
	const TARGETS = [
		{ label: "koishi 插件 bundle", file: "koishi/vite.config.ts" },
		{ label: "独立端 server bundle", file: "scripts/assemble-server-bundle.mjs" },
		{ label: "AstrBot sidecar", file: "scripts/build-astrbot-sidecar.mjs" },
	];

	it.each(TARGETS)("$label 的构建里搬了 static", async ({ file }) => {
		const text = await readFile(join(REPO_ROOT, file), "utf8");
		// 三处都用 monorepo 源路径(始终存在、与 lib/static 同内容)。理由见
		// build-astrbot-sidecar.mjs:对 workspace 包做 require.resolve 是 CJS 解析,
		// CI 全新环境里没有残留的 lib/index.cjs,会直接 Cannot find module。
		const code = text
			.split("\n")
			.filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
			.join("\n");
		expect(code).toContain("packages/image/src/static");
	});
});

/**
 * 这条守卫管的是**整个** `packages/`,不只是 image —— 任何一个包在源码里写裸
 * `__dirname`,dev 服务器加载它的那一刻就会以同样的方式炸,而产物照旧全绿。
 * 守卫落在 image 包只是因为这里是踩坑现场。
 *
 * `koishi/` 不在范围内:那边只出 CJS 产物,`__dirname` 原生就有,而且 dev 服务器
 * 从不从 koishi 源码加载东西。
 */
describe("packages 源码里不许出现裸 __dirname", () => {
	const PACKAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../..");

	// `__tests__` 也跳过:测试文件不会被 dev 服务器加载,而它们(包括本文件)为了
	// 讲清楚这条规则,正文里必然要提到那个标识符。
	const SKIP = new Set(["node_modules", "lib", "dist", "__tests__"]);

	async function* walk(dir: string): AsyncGenerator<string> {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			if (SKIP.has(entry.name)) continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) yield* walk(full);
			else if (/\.(ts|tsx|mts)$/.test(entry.name)) yield full;
		}
	}

	it("扫一遍所有 src,一处都不该有", async () => {
		const pkgs = (await readdir(PACKAGES_DIR, { withFileTypes: true }))
			.filter((e) => e.isDirectory())
			.map((e) => join(PACKAGES_DIR, e.name, "src"))
			.filter((p) => existsSync(p));
		expect(pkgs.length).toBeGreaterThan(3); // 目录没扫到时别假绿

		const offenders: string[] = [];
		for (const pkgSrc of pkgs) {
			for await (const file of walk(pkgSrc)) {
				const text = await readFile(file, "utf8");
				for (const [i, line] of text.split("\n").entries()) {
					// 只看代码里真的**读**这个标识符的地方。注释里提它是允许的 ——
					// 本文件和 image 的 vite.config 都得解释这件事。
					const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
					if (/(?<![\w$."'])__dirname\b/.test(code)) {
						offenders.push(`${relative(PACKAGES_DIR, file)}:${i + 1}`);
					}
				}
			}
		}
		expect(
			offenders,
			"ESM 源码里 __dirname 不存在;改用 dirname(fileURLToPath(import.meta.url))",
		).toEqual([]);
	});
});
