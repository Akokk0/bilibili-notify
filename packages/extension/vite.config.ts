import { defineConfig } from "vite-plus";

export default defineConfig({
	pack: {
		entry: ["src/index.ts", "src/wire.ts"],
		// 只出 ESM,与 internal 同一个理由(消费方全是 ESM)。
		format: ["esm"],
		dts: true,
		clean: true,
		outDir: "lib",
		exports: true,
	},
});
