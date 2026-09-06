/**
 * devtools 不进构建产物 —— 靠的是**结构**:`src/devtools/` 只有 `src/index.ts` 那一处引它,
 * 而 `apps/server/vite.config.ts` 在任何构建里把这个入口换成 `devtools/stub.ts`,整棵树随之
 * 从产物里消失。这条守卫钉住让那次替换成立的前提:多一个引用点,就多一条绕过桩的路
 * (桩只换从目录外指进去的那些 import,但它换的是「入口」这个概念 —— 引用点分散了,
 * 桩就得一个个追)。构建后另有 scripts/check-no-devtools.mjs 对着产物 grep,两层兜底。
 *
 * 认的是**模块说明符**,不是 `import ... from` 这一种写法:副作用 import 与裸动态 import
 * 都不带 `from`,只钉 `from` 的守卫对它们一声不吭。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
// 说明符不跨行:`[^"']*` 会越过换行,把两行外的一对引号当成一对,注释里提一句 devtools/ 都会误报。
const SPECIFIER = /["'][^"'\n]*\bdevtools\/[^"'\n]*["']/;

function* sources(dir: string): Generator<string> {
	for (const name of readdirSync(dir)) {
		if (name === "__tests__" || name === "node_modules") continue;
		const full = join(dir, name);
		if (statSync(full).isDirectory()) yield* sources(full);
		else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) yield full;
	}
}

describe("devtools 只活在源码里", () => {
	it("src/devtools 之外,只有 src/index.ts 提到它", () => {
		const offenders: string[] = [];
		for (const file of sources(SRC)) {
			const rel = relative(SRC, file);
			if (rel.startsWith("devtools/") || rel === "index.ts") continue;
			if (SPECIFIER.test(readFileSync(file, "utf8"))) offenders.push(rel);
		}
		expect(offenders).toEqual([]);
	});

	it("src/index.ts 里也只有那一处 —— 多一处就是桩追不上的那种", () => {
		const text = readFileSync(join(SRC, "index.ts"), "utf8");
		const hits = text.match(new RegExp(SPECIFIER.source, "g")) ?? [];
		expect(hits).toEqual(['"./devtools/index.js"']);
	});

	it("构建时顶替入口的桩确实在,签名与真的那份同名", () => {
		const stub = readFileSync(join(SRC, "devtools", "stub.ts"), "utf8");
		expect(stub).toMatch(/export function createDevtools\(/);
		// 桩只许 import type —— 带运行时的 import 会把真模块又牵回产物里。
		expect(stub).not.toMatch(/^import (?!type )/m);
	});
});
