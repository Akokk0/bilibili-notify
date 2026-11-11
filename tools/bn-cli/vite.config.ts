import { defineConfig } from "vite-plus";

export default defineConfig({
	pack: {
		entry: ["src/cli.ts"],
		platform: "node",
		target: "node24",
		format: ["esm"],
		outDir: "lib",
		clean: true,
		dts: false,
		deps: { alwaysBundle: [/.*/], onlyBundle: false },
	},
});
