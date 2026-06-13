import { defineConfig } from "vite-plus";

export default defineConfig({
	pack: {
		entry: ["src/index.ts"],
		format: ["esm"],
		dts: false,
		clean: true,
		outDir: "dist",
		platform: "node",
		target: "node24",
		shims: true,
		deps: {
			// @bilibili-notify/* 是 workspace 包、puppeteer-core 是直接依赖 —— vp pack 默认把直接
			// dependencies 外置(只内联间接依赖),但 sidecar 是 copy-install 进 AstrBot 数据目录、
			// 旁边没有 node_modules,任何 bare 外部 import 都会在装外解析失败。故强制内联,保持
			// bundle 自包含(其传递依赖 @puppeteer/browsers · ws · debug 等是间接依赖,默认即内联)。
			alwaysBundle: [/^@bilibili-notify\//, /^puppeteer-core(\/|$)/],
			onlyBundle: false,
		},
	},
});
