import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extensionPackageFiles } from "@bilibili-notify/extension/build";
import { defineConfig } from "vite-plus";

const DIR = dirname(fileURLToPath(import.meta.url));

/**
 * 假源的自包含构建,配方同桥:装载器拿 `import()` 直接吃盘上的 `index.mjs`,旁边没有
 * node_modules,所以一切都得内联(`@bilibili-notify/extension` 的运行时值与适配器 schema 用的 zod 都在内)。
 * 内联出来的 zod 与宿主那份不是同一个实例,同桥,宿主那头问形状、不问 `instanceof`。
 *
 * 拓展包 = 清单 + 代码 + 译文(ADR-0012 决策 8、ADR-0037 决策 14):`dist/` 原样就是能装的包目录,
 * 清单里的连接配置项由入口导出的规则导出(`extensionPackageFiles`)。
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
		plugins: [extensionPackageFiles(DIR)],
	},
});
