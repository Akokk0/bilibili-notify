import { createRequire } from "node:module";
import { defineConfig } from "vite-plus";

/**
 * 把 vue 相关的裸 specifier 精确解析到 **不含运行时模板编译器** 的构建。
 *
 * 因为产物是 CJS,默认解析会落到各包的 CJS 入口,而那两个 CJS 入口都拖着编译器:
 * - `vue` → `vue.cjs.js`,full build,自带编译器
 * - `@vue/server-renderer` → `server-renderer.cjs.js`,里面硬写着 `require('@vue/compiler-ssr')`
 *
 * 于是 `@vue/compiler-{core,dom,ssr}` 连同 `@babel/parser` 一起被拖进 bundle,白背约 900KB。
 * 而卡片模板是 `.tsx` —— 编译期就已经变成 `h()` 调用了,`packages/image` 只用
 * `createSSRApp` + `h()` + `renderToString`,运行时编译器一行都用不上。
 *
 * 对应的 esm-bundler 构建都不碰编译器(`server-renderer.esm-bundler.js` 只 import
 * `@vue/shared`),所以精确改指它们即可。
 *
 * 为什么是插件而不是 `alias: {...}`:字符串 alias 是**前缀匹配**,会把 `vue/jsx-runtime`
 * 一并改写成 `.../vue.runtime.esm-bundler.js/jsx-runtime` → 解析不到。这里只认裸
 * specifier,子路径原样放行(`vue/jsx-runtime` 内部的 `from "vue"` 仍会被命中,编译器照样切干净)。
 *
 * 注意:编译器一旦缺席,任何**运行时 template 字符串**都会渲染成空 —— 且构建全绿、
 * 只在渲染那一刻炸。改动这里之后必须真的渲一张卡片验证(见 CLAUDE.md 的同类雷)。
 */
const require = createRequire(import.meta.url);
const NO_COMPILER = {
	vue: "vue/dist/vue.runtime.esm-bundler.js",
	"@vue/server-renderer": "@vue/server-renderer/dist/server-renderer.esm-bundler.js",
} as const;

const vueRuntimeOnly = {
	name: "vue-runtime-only",
	resolveId(id: string) {
		const target = NO_COMPILER[id as keyof typeof NO_COMPILER];
		return target ? require.resolve(target) : null;
	},
};

export default defineConfig({
	pack: {
		entry: ["src/index.ts"],
		plugins: [vueRuntimeOnly],
		// vue 的 esm-bundler 构建把这三个当**编译期常量**读。不 define 就会原样留在产物里,
		// 运行时 ReferenceError —— 同样是构建全绿、跑起来才炸。
		// OPTIONS_API 关得掉:卡片是纯函数式组件(`export function DynamicCard(p)`),
		// 不碰 data/computed/mixins。
		define: {
			__VUE_OPTIONS_API__: "false",
			__VUE_PROD_DEVTOOLS__: "false",
			__VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
		},
		// koishi 生产模式只认 CJS。只发一种格式省掉整整一半产物,且 CJS 里 `__dirname`
		// 天然可用 —— 这正是内联 jieba-wasm 的前提(见下方 alwaysBundle)。
		format: ["cjs"],
		dts: true,
		clean: true,
		outDir: "lib",
		exports: true,
		deps: {
			// @bilibili-notify/* 全部内联 → 插件是自包含单文件,内部包不必再发 npm
			// (它们已 private),koishi 版本与内部包版本彻底解耦。
			//
			// jieba-wasm 一并内联 JS 胶水:它的 npm 包里有四份等大的 wasm(deno /
			// nodejs / web / bundler,共 16MB),external 的话用户要全扛下来。内联胶水 +
			// 只随包带 nodejs 那一份(scripts/copy-jieba-wasm.mjs 在 pack 后拷进 lib/),
			// 省 12MB。胶水靠 `__dirname` 找 wasm,CJS 产物里正好指向 lib/。
			alwaysBundle: [/^@bilibili-notify\//, /^jieba-wasm(\/|$)/],
			// jsdom 打不进来:它运行时 `require.resolve("./xhr-sync-worker.js")` 去磁盘上
			// 找自己的兄弟文件(还会 fork 子进程),内联后一 require 插件就 MODULE_NOT_FOUND。
			// 保持 external,留在 dependencies 里让 npm 装。
			neverBundle: [/^jsdom(\/|$)/],
			onlyBundle: false,
		},
	},
});
