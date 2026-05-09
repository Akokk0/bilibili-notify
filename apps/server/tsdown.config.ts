import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm"],
	dts: false,
	clean: true,
	outDir: "lib",
	platform: "node",
	target: "node20",
	sourcemap: true,
});
