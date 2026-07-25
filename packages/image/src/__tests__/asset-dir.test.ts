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
