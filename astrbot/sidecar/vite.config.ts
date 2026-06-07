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
			alwaysBundle: [/^@bilibili-notify\//],
			onlyBundle: false,
		},
	},
});
