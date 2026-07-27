import { defineConfig } from "vite-plus";

export default defineConfig({
	pack: {
		entry: ["src/index.ts", "src/constants.ts", "src/patch.ts", "src/template-defaults.ts"],
		// esm+cjs 双发不是锦上添花:web/astrbot 页在 `vp dev`(浏览器原生 ESM,无打包)
		// 下运行时消费 /constants 子路径,CJS-only 会因 Vite 不对 linked 包做具名导出
		// 分析而炸 "does not provide an export named ..."。build/vitest 有 CJS 互操作,
		// 测不出来 —— 只有 dev server 现形。
		format: ["esm", "cjs"],
		dts: true,
		clean: true,
		outDir: "lib",
		exports: true,
	},
});
