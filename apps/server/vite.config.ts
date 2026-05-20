import { defineConfig } from "vite-plus";

export default defineConfig({
	pack: {
		entry: ["src/index.ts"],
		format: ["esm"],
		dts: false,
		clean: true,
		outDir: "lib",
		platform: "node",
		target: "node20",
		sourcemap: true,
	},
});
