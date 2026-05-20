import { defineConfig } from "vite-plus";

export default defineConfig({
	pack: {
		entry: ["src/index.ts"],
		format: ["esm", "cjs"],
		dts: true,
		clean: true,
		outDir: "lib",
		exports: true,
		deps: { onlyBundle: false },
		copy: [{ from: "src/static", to: "lib" }],
	},
});
