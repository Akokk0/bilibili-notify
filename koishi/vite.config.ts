import { defineConfig } from "vite-plus";

export default defineConfig({
	pack: {
		entry: ["src/index.ts"],
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
