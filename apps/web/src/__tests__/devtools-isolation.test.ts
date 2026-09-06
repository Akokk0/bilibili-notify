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
	/**
	 * 认的是**模块说明符**,不是 `import ... from` 这一种写法。带 `from` 的静态 import 只是
	 * 三种引法里的一种:`import "./devtools/x"`(纯副作用)会把整棵树拉进主 chunk,
	 * `await import("./devtools/x")`(不带 DEV 三元的裸动态 import)会实打实产出一个
	 * devtools chunk —— 两种都不带 `from`,只钉 `from` 的守卫对它们一声不吭。
	 */
	// 说明符不跨行:`[^"']*` 会越过换行,把两行外的一对引号当成一对,注释里提一句 devtools/ 都会误报。
	const SPECIFIER = /["'][^"'\n]*\bdevtools\/[^"'\n]*["']/;

	it("src/devtools 之外,只有 App.tsx 提到它", () => {
		const offenders: string[] = [];
		for (const file of listSources(SRC, {
			exts: [".ts", ".tsx"],
			skipTestDirs: true,
			skipTestFiles: true,
		})) {
			const rel = relative(SRC, file);
			if (rel.startsWith("devtools/") || rel === "App.tsx") continue;
			if (SPECIFIER.test(readFileSync(file, "utf8"))) offenders.push(rel);
		}
		expect(offenders).toEqual([]);
	});

	it("App.tsx 里也只有那一处 —— 多一处就可能是没包在死枝里的那种", () => {
		const app = readFileSync(join(SRC, "App.tsx"), "utf8");
		const hits = app.match(new RegExp(SPECIFIER.source, "g")) ?? [];
		expect(hits).toEqual(['"./devtools/dock"']);
	});

	it("App.tsx 那一处包在 import.meta.env.DEV 的三元里", () => {
		const app = readFileSync(join(SRC, "App.tsx"), "utf8");
		expect(app).toMatch(
			/import\.meta\.env\.DEV\s*\?\s*lazy\(\(\)\s*=>\s*import\("\.\/devtools\/dock"\)/,
		);
	});
});
