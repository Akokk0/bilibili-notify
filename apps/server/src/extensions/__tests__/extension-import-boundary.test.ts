/**
 * 🔴 **拓展只认包,不认宿主应用长什么样。**
 *
 * `extensions/<id>/` 底下的代码可以依赖共享包(`@bilibili-notify/extension` /
 * `internal` / …)与第三方,但**不许伸手进 `apps/`** —— 那里是产品形态,不是契约。
 *
 * 为什么包边界不够、还要一条可执行的守卫:
 *
 * - **相对路径绕得过去。** `import "../../apps/server/src/runtime/message-bus.js"` 不经过
 *   任何包边界,pnpm 拦不住,tsc 也照编 —— 而 ⛔ 决策 15 那条(`bus` 绝不给拓展)就此作废。
 * - **越界是静默的。** 类型全绿、测试全绿、构建全绿,症状要很久以后才以别的形式冒出来。
 *
 * 判据写成纯函数 + 样例,是因为**判据本身也会写错**:一条永远判 OK 的规则跟没有一样。
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

/** 宿主给拓展的那一面。ctx 从这儿拿,不从核心里掏。 */
const EXTENSION_PACKAGE = "@bilibili-notify/extension";

/**
 * 从一份源码里抠出所有 import / re-export 的目标。
 *
 * 正则够用:这是一道**结构守卫**,不是编译器 —— 它要判的是「有没有人写了一条够到核心的
 * 路径」,而那种写法一律长成 `from "…"` 或 `import("…")`。真有人用拼字符串绕过去,那不是
 * 手滑,是刻意。
 */
export function importSpecifiersIn(source: string): string[] {
	const found: string[] = [];
	for (const match of source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
		const spec = match[1];
		if (spec) found.push(spec);
	}
	return found;
}

export interface BoundaryViolation {
	specifier: string;
	why: string;
}

/**
 * 一条 import 越界了吗。
 *
 * @param specifier import 的目标
 * @param fromDir   写这行的文件所在目录,**相对拓展自己的根**(`""` = 拓展根)
 */
export function boundaryViolation(specifier: string, fromDir: string): BoundaryViolation | null {
	if (specifier.startsWith(".")) {
		// 相对路径:只要还在自己这棵树里就随便。逃出去的那一刻就是越界 —— 够到的是
		// `apps/server/src/…` 还是隔壁拓展并不重要,两条边都不该有。
		const segments = [...fromDir.split("/").filter(Boolean), ...specifier.split("/")];
		let depth = 0;
		for (const segment of segments) {
			if (segment === "." || segment === "") continue;
			if (segment === "..") {
				depth -= 1;
				if (depth < 0) {
					return { specifier, why: "相对路径爬出了这个拓展自己的目录" };
				}
				continue;
			}
			depth += 1;
		}
		return null;
	}

	// ⛔ 产品形态不是契约:宿主应用 / 面板 / 桌面壳都不该出现在拓展的依赖里 ——
	// 插件依赖宿主应用那条边是反的。
	for (const app of ["server", "web", "desktop"]) {
		const name = `@bilibili-notify/${app}`;
		if (specifier === name || specifier.startsWith(`${name}/`)) {
			return { specifier, why: `不许依赖宿主应用;ctx 那一面在 ${EXTENSION_PACKAGE}` };
		}
	}
	// 共享包与第三方随便 —— 它们本来就是给所有人用的。
	return null;
}

describe("拓展越界判据", () => {
	it("放行:共享包、第三方、node 内置、那扇门本身", () => {
		for (const spec of [
			"@bilibili-notify/internal",
			"@bilibili-notify/contract",
			"zod",
			"ws",
			"node:crypto",
			EXTENSION_PACKAGE,
		]) {
			expect(boundaryViolation(spec, "src")).toBeNull();
		}
	});

	it("放行:拓展自己树里的相对路径,爬回自己根目录也算", () => {
		expect(boundaryViolation("./protocol.js", "src")).toBeNull();
		expect(boundaryViolation("../extension.json", "src")).toBeNull();
		expect(boundaryViolation("../src/protocol.js", "src/proto")).toBeNull();
	});

	it("判红:爬出自己那棵树 —— 够到的是核心还是隔壁拓展都一样", () => {
		expect(boundaryViolation("../../apps/server/src/runtime/message-bus.js", "src")).toEqual({
			specifier: "../../apps/server/src/runtime/message-bus.js",
			why: expect.stringContaining("爬出"),
		});
		// 拓展根上写 `../` 就已经出去了。
		expect(boundaryViolation("../other-ext/index.js", "")).not.toBeNull();
	});

	it("判红:依赖宿主应用 —— 整包、子路径、面板都算", () => {
		expect(boundaryViolation("@bilibili-notify/server", "src")?.why).toContain("宿主应用");
		expect(boundaryViolation("@bilibili-notify/server/lib/index.mjs", "src")).not.toBeNull();
		expect(boundaryViolation("@bilibili-notify/web", "src")).not.toBeNull();
	});
});

describe("抠 import 目标", () => {
	it("import / re-export / 动态 import 都认得", () => {
		expect(
			importSpecifiersIn(
				[
					`import type { ExtensionContext } from "${EXTENSION_PACKAGE}";`,
					`import { z } from 'zod';`,
					`export type { Frame } from "./protocol.js";`,
					`const mod = await import("node:crypto");`,
				].join("\n"),
			),
		).toEqual([EXTENSION_PACKAGE, "zod", "./protocol.js", "node:crypto"]);
	});
});

/** 仓根的 `extensions/` —— 从本文件往上四级(`apps/server/src/extensions/__tests__`)。 */
const EXTENSIONS_ROOT = join(
	fileURLToPath(dirname(import.meta.url)),
	"..",
	"..",
	"..",
	"..",
	"..",
	"extensions",
);

async function tsFilesIn(dir: string): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await tsFilesIn(full)));
		else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(full);
	}
	return out;
}

/**
 * 🔴 **真去扫仓里的拓展。**
 *
 * 上面那些样例证明判据本身没写错;这一条证明**没有人真的越过那条边**。两条都要:
 * 只有样例的话,判据再对也拦不住实际写下去的那一行。
 */
describe("仓里的拓展没有越界", () => {
	it("每一条 import 要么是共享包 / 第三方,要么在自己那棵树里 —— 没有一条够到 apps/", async () => {
		const files = await tsFilesIn(EXTENSIONS_ROOT);
		// 一个拓展都没扫到 = 这条守卫在空转,那比没有还糟。
		expect(files.length).toBeGreaterThan(0);

		const violations: string[] = [];
		for (const file of files) {
			// `extensions/<id>/...` —— 拓展根是第一段。
			const parts = relative(EXTENSIONS_ROOT, file).split(sep);
			const extensionRoot = join(EXTENSIONS_ROOT, parts[0] ?? "");
			const fromDir = relative(extensionRoot, dirname(file)).split(sep).join("/");
			for (const specifier of importSpecifiersIn(await readFile(file, "utf8"))) {
				const bad = boundaryViolation(specifier, fromDir);
				if (bad) violations.push(`${relative(EXTENSIONS_ROOT, file)}: ${specifier} —— ${bad.why}`);
			}
		}
		expect(violations).toEqual([]);
	});
});
