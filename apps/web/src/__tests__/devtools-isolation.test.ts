/**
 * devtools 不进生产 bundle —— 靠的是**结构**:`src/devtools/` 只有 App.tsx 那一处引它,而且
 * 那一处是 `import.meta.env.DEV ? lazy(() => import(…)) : null` 的死枝(编译期常量折掉之后,
 * 动态 import 随死枝一起被摇掉)。2026-09-06 建 dock 时对着 dist grep 过一遍(带对照项):
 * 零痕迹。这条守卫钉住让那次 grep 成立的两个前提,免得日后谁在别处静态 import 一下就把
 * 整套 devtools 带进正式版 —— 那不会红,只会多出一个没人要的 chunk。
 */

import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { listSources } from "./walk.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("devtools 只活在开发期", () => {
	it("src/devtools 之外,只有 App.tsx 引它,而且是动态 import", () => {
		const offenders: string[] = [];
		for (const file of listSources(SRC, {
			exts: [".ts", ".tsx"],
			skipTestDirs: true,
			skipTestFiles: true,
		})) {
			const rel = relative(SRC, file);
			if (rel.startsWith("devtools/")) continue;
			const text = readFileSync(file, "utf8");
			if (/from\s+["'][./]*\/devtools\//.test(text)) offenders.push(rel);
		}
		expect(offenders).toEqual([]);
	});

	it("App.tsx 那一处包在 import.meta.env.DEV 的三元里", () => {
		const app = readFileSync(join(SRC, "App.tsx"), "utf8");
		expect(app).toMatch(
			/import\.meta\.env\.DEV\s*\?\s*lazy\(\(\)\s*=>\s*import\("\.\/devtools\/dock"\)/,
		);
	});
});
