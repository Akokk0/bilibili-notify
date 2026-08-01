/// <reference types="node" />
/**
 * 「一个进程只建一个字体读取器」的静态护栏。
 *
 * 背景:`createFontAssetReader` 的缓存里留的是拼好的 `@font-face` —— 一款几十兆的
 * 中文字库 base64 之后还要再涨三分之一。建两个读取器就等于同一份东西在堆里存两遍,
 * 而镜像里 V8 的 old-space 上限只有 384MB。这事发生过:推送渲染器(runtime/engines)
 * 和预览路由(routes/cards)各建了一个,谁都没错,合起来就把省下来的又赔了回去。
 *
 * 类型检查拦不住它 —— 多建一个完全合法。所以在这儿扫源码:非测试代码里
 * `createFontAssetReader(` 的调用点必须只有一处(bootstrap 建、挂到 AppRuntime 上,
 * 别处一律从 runtime 上取)。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(TEST_DIR, "..", "..");

/** 递归列出 src 下所有 .ts,跳过测试目录与定义处本身。 */
function listSourceFiles(dir: string): string[] {
	const acc: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (entry === "__tests__" || entry === "node_modules") continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			acc.push(...listSourceFiles(full));
		} else if (full.endsWith(".ts") && !full.endsWith(".test.ts")) {
			acc.push(full);
		}
	}
	return acc;
}

describe("字体读取器只许建一处", () => {
	const files = listSourceFiles(SRC_DIR);

	it("扫到了源码(防目录挪走后静默零命中)", () => {
		expect(files.length).toBeGreaterThan(20);
	});

	it("非测试代码里 createFontAssetReader 的调用点只有一处", () => {
		const callSites: string[] = [];
		for (const file of files) {
			// 定义处自己不算 —— 它是 `export function createFontAssetReader(`。
			if (file.endsWith(join("runtime", "font-assets.ts"))) continue;
			const src = readFileSync(file, "utf8");
			const hits = src.match(/\bcreateFontAssetReader\s*\(/g);
			if (hits) callSites.push(`${relative(SRC_DIR, file)} ×${hits.length}`);
		}
		expect(
			callSites,
			`字体读取器该在 bootstrap 建一次、挂到 AppRuntime 上,别处从 runtime 取。\n当前调用点:\n${callSites
				.map((x) => `  ${x}`)
				.join("\n")}`,
		).toHaveLength(1);
	});
});
