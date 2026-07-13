import { defineConfig } from "vite-plus";

export default defineConfig({
	pack: {
		entry: ["src/index.ts"],
		// cjs 给 koishi 内联;esm 给独立端(server bundle / tsx dev)与 astrbot sidecar,
		// ESM 消费端不再吃 CJS 互操作(与 ai/dynamic/live/image/internal 对齐)。
		format: ["esm", "cjs"],
		dts: true,
		clean: true,
		outDir: "lib",
		exports: true,
	},
});
