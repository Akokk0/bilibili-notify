import { extensionPackageFiles } from "@bilibili-notify/extension/build";
import { defineConfig } from "vite-plus";

export default defineConfig({
	pack: {
		entry: ["src/index.ts"],
		platform: "node",
		target: "node24",
		format: ["esm"],
		outDir: "dist",
		clean: true,
		dts: false,
		sourcemap: false,
		deps: { alwaysBundle: [/.*/], onlyBundle: false },
		plugins: [extensionPackageFiles(import.meta.dirname)],
	},
});
