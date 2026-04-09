import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm", "cjs"],
	dts: true,
	clean: true,
	outDir: "lib",
	exports: true,
	deps: { onlyBundle: false },
	tsconfig: "tsconfig.json",
	copy: [
		{ from: "src/page", to: "lib" },
		{ from: "src/img", to: "lib" },
		{ from: "src/static", to: "lib" },
	],
});
