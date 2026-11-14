import { readFileSync } from "node:fs";
import { extensionPackageFiles } from "@bilibili-notify/extension/build";
import { defineConfig } from "vite-plus";

const notices = ["LICENSE", "NOTICE"]
	.map((name) => readFileSync(new URL(name, import.meta.url), "utf8"))
	.join("\n\n");

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
		outputOptions: { codeSplitting: false, banner: `/*!\n${notices}\n*/` },
		deps: { alwaysBundle: [/.*/], onlyBundle: false },
		plugins: [extensionPackageFiles(import.meta.dirname)],
	},
});
