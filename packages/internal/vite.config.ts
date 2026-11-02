import { defineConfig } from "vite-plus";

export default defineConfig({
	pack: {
		entry: [
			"src/index.ts",
			"src/ai.ts",
			"src/card-skin.ts",
			"src/extension/index.ts",
			"src/extension/build.ts",
			"src/extension/wire.ts",
			"src/features.ts",
			"src/format.ts",
			"src/history.ts",
			"src/i18n.ts",
			"src/identity.ts",
			"src/link-preview.ts",
			"src/live-monitor.ts",
			"src/patch.ts",
			"src/platform-descriptor.ts",
			"src/push-target.ts",
			"src/result.ts",
			"src/template-defaults.ts",
			"src/template-variables.ts",
			"src/texts/index.ts",
			"src/texts/builtin/index.ts",
			"src/update.ts",
		],
		// 只出 ESM:消费方(server bundle / tsx dev / web 的 `vp dev`)全是 ESM。web 在
		// `vp dev`(浏览器原生 ESM,无打包)下运行时消费零依赖领域子路径,产物若是
		// CJS 会因 Vite 不对 linked 包做具名导出分析而炸 "does not provide an export
		// named ..."。build/vitest 有 CJS 互操作,测不出来 —— 只有 dev server 现形。
		format: ["esm"],
		dts: true,
		clean: true,
		outDir: "lib",
		exports: true,
	},
});
