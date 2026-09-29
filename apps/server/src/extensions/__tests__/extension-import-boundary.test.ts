/**
 * 🔴 **BN 的东西,拓展只从一扇门拿。**
 *
 * `extensions/<id>/` 底下可以随便用第三方(`ws` / `zod` / node 内置),但我们自己的东西
 * **只准从 `@bilibili-notify/extension` 进** —— 那个包列出来的就是契约的全部。
 *
 * 为什么包边界不够、还要一条可执行的守卫:
 *
 * - **依赖别的包拦不住。** 直接依赖 `@bilibili-notify/internal` 就能伸手拿整个域模型
 *   (globals / subscriptions / patch……),那面比契约宽得多,而 pnpm 一声不吭。
 * - **相对路径更绕得过去。** `import "../../apps/server/src/runtime/message-bus.js"` 不经过
 *   任何包边界,tsc 也照编 —— 而 ⛔ 决策 15 那条(`bus` 绝不给拓展)就此作废。
 * - **越界是静默的。** 类型全绿、测试全绿、构建全绿,症状要很久以后才以别的形式冒出来。
 *
 * 判据写成纯函数 + 样例,是因为**判据本身也会写错**:一条永远判 OK 的规则跟没有一样。
 */

import { existsSync, readdirSync } from "node:fs";
import { dirname, join, posix, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { importsOf, listSources, parseSource } from "../../../../../scripts/source-scan.mjs";

/** 宿主给拓展的那一面。ctx 从这儿拿,不从核心里掏。 */
const EXTENSION_PACKAGE = "@bilibili-notify/extension";

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

	// 我们自己的包:只放行那一扇门。别的(`internal` 的整个域模型、`contract` 的 wire、
	// 宿主应用本身)都不是契约 —— 要哪一格,去那个包里**明确转出来**。
	if (specifier.startsWith("@bilibili-notify/")) {
		return specifier === EXTENSION_PACKAGE
			? null
			: { specifier, why: `BN 的东西只从 ${EXTENSION_PACKAGE} 拿` };
	}
	// 第三方与 node 内置随便 —— 它们本来就不是我们的契约。
	return null;
}

describe("拓展越界判据", () => {
	it("放行:第三方、node 内置、那扇门本身", () => {
		for (const spec of ["zod", "ws", "node:crypto", EXTENSION_PACKAGE]) {
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

	/**
	 * `internal` 那条尤其要拦:它导出的是**整个域模型**,依赖它就等于把契约面从「列出来的
	 * 那些」放宽成「internal 里有的一切」,而那不是任何人做过的决定。
	 */
	it("判红:我们自己的别的包 —— 宿主应用、面板、连 internal 也算", () => {
		expect(boundaryViolation("@bilibili-notify/internal", "src")?.why).toContain(EXTENSION_PACKAGE);
		expect(boundaryViolation("@bilibili-notify/contract", "src")).not.toBeNull();
		expect(boundaryViolation("@bilibili-notify/server", "src")).not.toBeNull();
		expect(boundaryViolation("@bilibili-notify/server/lib/index.mjs", "src")).not.toBeNull();
		expect(boundaryViolation("@bilibili-notify/web", "src")).not.toBeNull();
	});
});

/** 一段样例源码里所有 import 类引用的目标。 */
const specifiersIn = (text: string) =>
	importsOf(parseSource("sample.ts", text)).map((ref) => ref.specifier);

describe("抠 import 目标", () => {
	it("import / re-export / 动态 import / require 都认得", () => {
		expect(
			specifiersIn(
				[
					`import type { ExtensionContext } from "${EXTENSION_PACKAGE}";`,
					`import { z } from 'zod';`,
					`import "./side-effect.js";`,
					`export type { Frame } from "./protocol.js";`,
					`const mod = await import("node:crypto");`,
					`const legacy = require("./legacy.cjs");`,
				].join("\n"),
			),
		).toEqual([
			EXTENSION_PACKAGE,
			"zod",
			"./side-effect.js",
			"./protocol.js",
			"node:crypto",
			"./legacy.cjs",
		]);
	});

	it("注释、字符串与模板里的写法不算(哪怕写得像一条越界的 import)", () => {
		expect(
			specifiersIn(
				[
					`// import { x } from "@bilibili-notify/internal";`,
					`/* const m = await import("../../apps/server/src/runtime/message-bus.js"); */`,
					`const hint = 'from "@bilibili-notify/server"';`,
					'const doc = `import("@bilibili-notify/contract")`;',
				].join("\n"),
			),
		).toEqual([]);
	});
});

/**
 * 🔴 **真去扫仓里的拓展。**
 *
 * 上面那些样例证明判据本身没写错;这一条证明**没有人真的越过那条边**。两条都要:
 * 只有样例的话,判据再对也拦不住实际写下去的那一行。
 */
describe("仓里的拓展没有越界", () => {
	it("每一条 import 要么是那扇门 / 第三方,要么在自己那棵树里", () => {
		// 连测试文件一起扫:测试里越界同样是越界。
		const files = listSources(["extensions"], { tests: true });
		// 一个拓展都没扫到 = 这条守卫在空转,那比没有还糟。
		expect(files.length).toBeGreaterThan(0);

		const violations: string[] = [];
		for (const file of files) {
			// `extensions/<id>/...` —— 拓展根是前两段。
			const extensionRoot = file.split("/").slice(0, 2).join("/");
			const fromDir = posix.relative(extensionRoot, posix.dirname(file));
			for (const ref of importsOf(parseSource(file))) {
				const bad = boundaryViolation(ref.specifier, fromDir);
				if (bad) violations.push(`${file}:${ref.line}: ${ref.specifier} —— ${bad.why}`);
			}
		}
		expect(violations).toEqual([]);
	});
});

/* -------------------------------------------------------------------------- */
/* 反方向:核心不 import 拓展                                                 */
/* -------------------------------------------------------------------------- */

/**
 * 🔴 **另一条边:核心不 import 拓展。**
 *
 * 上半场只扫了「拓展够不够得到核心」,而那条规矩是**两条边**:核心伸手进
 * `extensions/` 同样致命,而且更隐蔽 ——
 *
 * - **拓展是装进来的,本体一个都不带**(ADR-0012)。核心 import 它等于把一个可选的、
 *   随时会被卸载 / 换版本的东西编进主程序:那个目录在主人机器上根本不存在。
 * - **它把契约变成双向的。** 契约只有一扇门(`@bilibili-notify/extension`),核心直接
 *   够到某个拓展的内部,等于宣布「桥的那个文件也是契约」—— 而那个拓展有自己的发版节奏。
 * - **越界照样是静默的**:仓里有源码、tsc 编得过、测试全绿,只有真机上那份没有仓库源码
 *   的载荷会炸,或者更糟:装的那一版和编进去的那一份不是同一版。
 */
export function reachesIntoExtensions(
	specifier: string,
	/** 写这行的文件所在目录,**绝对路径**。 */
	fromDir: string,
	/** 仓根那个 `extensions/`,绝对路径。 */
	extensionsRoot: string,
): boolean {
	if (specifier.startsWith(".")) {
		// 拿**解析之后的绝对路径**判,别拿字符串猜:核心自己有一个 `src/extensions/`
		// (宿主这侧的装载器),按名字猜会把它整片误伤。
		const resolved = resolve(fromDir, specifier);
		return resolved === extensionsRoot || resolved.startsWith(`${extensionsRoot}${sep}`);
	}
	// 拓展都是 workspace 包(`@bilibili-notify/extension-<id>`)。⚠️ 那扇门本身叫
	// `@bilibili-notify/extension`,不带横杠 —— 核心当然要 import 它。
	return specifier.startsWith(`${EXTENSION_PACKAGE}-`);
}

describe("核心越界判据", () => {
	const root = `${sep}repo${sep}extensions`;
	const from = `${sep}repo${sep}apps${sep}server${sep}src`;

	it("放行:宿主自己那个 src/extensions/(装载器住那儿),以及那扇门本身", () => {
		expect(reachesIntoExtensions("./extensions/loader.js", from, root)).toBe(false);
		expect(reachesIntoExtensions("../extensions/mount.js", from, root)).toBe(false);
		expect(reachesIntoExtensions(EXTENSION_PACKAGE, from, root)).toBe(false);
		expect(reachesIntoExtensions("@bilibili-notify/internal", from, root)).toBe(false);
	});

	it("判红:爬到仓根的 extensions/ 里,或者依赖某个拓展的包", () => {
		expect(reachesIntoExtensions("../../../extensions/bridge/src/protocol.js", from, root)).toBe(
			true,
		);
		expect(reachesIntoExtensions("@bilibili-notify/extension-bridge", from, root)).toBe(true);
	});
});

/** 仓根 —— 从本文件往上五级(`apps/server/src/extensions/__tests__`)。 */
const REPO_ROOT = join(fileURLToPath(dirname(import.meta.url)), "..", "..", "..", "..", "..");

/** 核心那一侧要扫的源码根:每个 app / package 自己的 `src`(`extensions/*` 不在其中),仓库相对路径。 */
function coreSourceRoots(): string[] {
	const roots: string[] = [];
	for (const group of ["apps", "packages"]) {
		for (const entry of readdirSync(join(REPO_ROOT, group), { withFileTypes: true })) {
			// 没有 src/ 的(桌面壳那种)跳过。
			if (entry.isDirectory() && existsSync(join(REPO_ROOT, group, entry.name, "src"))) {
				roots.push(`${group}/${entry.name}/src`);
			}
		}
	}
	return roots;
}

describe("核心没有伸手进拓展", () => {
	it("apps/**/src 与 packages/**/src 里没有一条 import 够到 extensions/", () => {
		const extensionsRoot = join(REPO_ROOT, "extensions");
		const roots = coreSourceRoots();
		// 一个源码根都没扫到 = 这条守卫在空转,那比没有还糟。
		expect(roots.length).toBeGreaterThan(0);

		// 连测试文件一起扫,范围同迁移之前。
		const files = listSources(roots, { tests: true });
		expect(files.length).toBeGreaterThan(0);

		const violations: string[] = [];
		for (const file of files) {
			const fromDir = dirname(join(REPO_ROOT, file));
			for (const ref of importsOf(parseSource(file))) {
				if (!reachesIntoExtensions(ref.specifier, fromDir, extensionsRoot)) continue;
				violations.push(`${file}:${ref.line}: ${ref.specifier}`);
			}
		}
		expect(violations).toEqual([]);
	});
});
