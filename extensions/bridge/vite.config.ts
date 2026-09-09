import { copyFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const DIR = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(DIR, "dist");

/**
 * 拓展包 = **清单 + 代码**(ADR-0012 决策 8),所以构建产出的是一整个能直接落地的包目录:
 * `dist/` 原样拷进 `<载荷>/extensions/bridge/` 或 `<dataDir>/extensions/bridge/` 就能跑。
 * 清单留在源码根便于人读,但它必须跟着代码一起走 —— 装载器在 import 任何一行之前先读它。
 */
const copyManifest = {
	name: "bn:extension-manifest",
	async closeBundle() {
		await copyFile(resolve(DIR, "extension.json"), resolve(OUT, "extension.json"));
	},
};

/**
 * 桥拓展的自包含构建。
 *
 * 🔴 **拓展跑在载荷旁边,那儿没有 node_modules** —— 装载器拿 `import()` 直接吃盘上这个
 * `index.mjs`(`discover.ts` 的 `EXTENSION_ENTRY_FILE`),没有任何东西替它解析裸依赖。
 * 所以第三方一律内联;漏一个是**构建全绿、主人拨开关那一刻才 ERR_MODULE_NOT_FOUND**。
 *
 * 内联出来的 `zod` / `ws` 与宿主那两份**不是同一个实例**,这是刻意认下的:宿主与拓展之间
 * 传的全是纯数据与函数,唯一碰到实例身份的地方(config schema 的对表)已经改成问形状而
 * 不是 `instanceof`(见 `apps/server/src/extensions/config-fields.ts`)。
 */
export default defineConfig({
	pack: {
		entry: ["src/index.ts"],
		format: ["esm"],
		dts: false,
		clean: true,
		outDir: "dist",
		platform: "node",
		// 与 server bundle 同档:拓展只跑在宿主进程里,宿主要 node24。
		target: "node24",
		// 内联全依赖之后 map 体积远大于代码本身,载荷不背它。
		sourcemap: false,
		deps: {
			alwaysBundle: [/^@bilibili-notify\//, /^ws(\/|$)/, /^zod(\/|$)/],
			onlyBundle: false,
		},
		plugins: [copyManifest],
	},
});
