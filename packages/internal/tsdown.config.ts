import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["cjs"],
	dts: true,
	clean: true,
	outDir: "lib",
	exports: true,
});
