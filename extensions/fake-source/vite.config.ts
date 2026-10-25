import { copyFile, cp, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const DIR = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(DIR, "dist");

/**
 * 拓展包 = 清单 + 代码 + 译文(ADR-0012 决策 8、ADR-0037 决策 14):`dist/` 原样就是一个能装的包目录。
 * 清单与 `locales/` 留在源码根便于人读,构建时跟着拷过去 —— 装载器在 import 任何一行之前先读清单,
 * 读目录时读译文。`locales/` 有才拷。
 */
const copyPackageFiles = {
	name: "bn:extension-package-files",
	async closeBundle() {
		await copyFile(resolve(DIR, "extension.json"), resolve(OUT, "extension.json"));
		const locales = resolve(DIR, "locales");
		if ((await stat(locales).catch(() => undefined))?.isDirectory()) {
			await cp(locales, resolve(OUT, "locales"), { recursive: true });
		}
	},
};

/**
 * 假源的自包含构建,配方同桥:装载器拿 `import()` 直接吃盘上的 `index.mjs`,旁边没有
 * node_modules,所以一切都得内联(`@bilibili-notify/extension` 的运行时值与适配器 schema 用的 zod 都在内)。
 * 内联出来的 zod 与宿主那份不是同一个实例,同桥,宿主那头问形状、不问 `instanceof`。
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
			alwaysBundle: [/^@bilibili-notify\//, /^zod(\/|$)/],
			onlyBundle: false,
		},
		plugins: [copyPackageFiles],
	},
});
