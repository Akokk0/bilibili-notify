import { copyFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const DIR = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(DIR, "dist");

/**
 * 拓展包 = 清单 + 代码(ADR-0012 决策 8):`dist/` 原样就是一个能装的包目录。清单留在源码根
 * 便于人读,构建时跟着拷过去 —— 装载器在 import 任何一行之前先读它。
 */
const copyManifest = {
	name: "bn:extension-manifest",
	async closeBundle() {
		await copyFile(resolve(DIR, "extension.json"), resolve(OUT, "extension.json"));
	},
};

/**
 * 假源的自包含构建,配方同桥:装载器拿 `import()` 直接吃盘上的 `index.mjs`,旁边没有
 * node_modules,所以一切都得内联(它眼下只用 node 内置,`@bilibili-notify/extension` 只取类型)。
 */
export default defineConfig({
	pack: {
		entry: ["src/index.ts"],
		format: ["esm"],
		dts: false,
		clean: true,
		outDir: "dist",
		platform: "node",
		target: "node24",
		sourcemap: false,
		deps: {
			alwaysBundle: [/^@bilibili-notify\//],
			onlyBundle: false,
		},
		plugins: [copyManifest],
	},
});
