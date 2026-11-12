import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extensionPackageFiles } from "@bilibili-notify/extension/build";
import { defineConfig } from "vite-plus";

const DIR = dirname(fileURLToPath(import.meta.url));

/**
 * 桥拓展的自包含构建。
 *
 * 🔴 **拓展跑在载荷旁边,那儿没有 node_modules** —— 装载器拿 `import()` 直接吃盘上这个
 * `index.mjs`(`discover.ts` 的 `EXTENSION_ENTRY_FILE`),没有任何东西替它解析裸依赖。
 * 所以第三方一律内联;漏一个是**构建全绿、主人拨开关那一刻才 ERR_MODULE_NOT_FOUND**。
 *
 * 内联出来的 `zod` / `ws` 与宿主那两份**不是同一个实例**,这是刻意认下的:宿主与拓展之间
 * 传的全是纯数据与函数,碰到实例身份的地方(config schema 的对表、构建时读规则的 `.meta()`)都问形状、
 * 读规则对象自己的方法,不问 `instanceof`(见 `packages/internal/src/schema/zod-def.ts`)。
 */
const shared = {
	format: ["esm"],
	dts: false,
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
} as const;

/**
 * 🔴 **两份打包配置,不是一份配置两个入口。** 同一份里写两个入口,打包器会把共用的代码拆成
 * 分块,`index.mjs` 就会 `import "./chunk-*.mjs"`;而发行包只收 `index.mjs`(`scripts/pack-extension.mjs`),
 * 发出去的包装上就坏。开发入口 `devtools.mjs` 单独一份,各自内联各自的依赖(多出来的体积只在开发版里)。
 *
 * 清理:两份是**并行**打的(日志里次序不定),所以谁也不整个清 `dist/`(`clean: true` 会和另一份
 * 的产物抢跑互删),各清各的文件。清单与译文只由第一份复制。源码挂载时由开发版 BN 直接加载两个源码入口。
 */
export default defineConfig({
	pack: [
		{
			...shared,
			entry: ["src/index.ts"],
			clean: ["dist/index.mjs", "dist/extension.json", "dist/locales"],
			// 拓展包 = 清单 + 代码 + 译文(ADR-0012 决策 8):`dist/` 原样就是能装的包目录,清单里的设置项由规则导出。
			plugins: [extensionPackageFiles(DIR)],
		},
		{
			...shared,
			entry: { devtools: "src/devtools/index.ts" },
			clean: ["dist/devtools.mjs"],
		},
	],
});
