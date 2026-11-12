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

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import {
	importsOf,
	listSources,
	parseSource,
	srcRootsUnder,
	ts,
} from "../../../../../scripts/source-scan.mjs";

/** 拓展拿契约的那一扇门。本体与 wire 形状都住 `@bilibili-notify/internal`。 */
const EXTENSION_PACKAGE = "@bilibili-notify/extension";
const EXTENSION_PACKAGE_DIR = "packages/extension";
const EXTENSION_SOURCE_ROOT = `${EXTENSION_PACKAGE_DIR}/src`;
const EXTENSION_ENTRY = `${EXTENSION_SOURCE_ROOT}/index.ts`;
/** 门的构建子路径(`/build`):只给拓展根上的构建配置用,本体同样住 internal、这里只转出。 */
const EXTENSION_BUILD_ENTRY = `${EXTENSION_SOURCE_ROOT}/build.ts`;
const EXTENSION_BUILD_PACKAGE = `${EXTENSION_PACKAGE}/build`;
const EXTENSION_BUILD_VALUES = new Set(["extensionPackageFiles", "manifestWithSettingsFields"]);
const INTERNAL_PACKAGE = "@bilibili-notify/internal";
const EXTENSION_VALUES = new Set(["fail", "neutralPlatformDescriptor", "ok"]);

const isExtensionPackage = (specifier: string) =>
	specifier === EXTENSION_PACKAGE || specifier.startsWith(`${EXTENSION_PACKAGE}-`);

const isExtensionSurface = (specifier: string) =>
	isExtensionPackage(specifier) || specifier.startsWith(`${EXTENSION_PACKAGE}/`);

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
	// 构建子路径带着宿主的代码(读规则、对表、清单格式):只许拓展根上的构建配置(`vite.config.ts`)用,
	// `src/` 里 import 它就是把一份宿主代码打进拓展包。
	if (specifier === EXTENSION_BUILD_PACKAGE) {
		return fromDir === ""
			? null
			: {
					specifier,
					why: `${EXTENSION_BUILD_PACKAGE} 只给拓展根上的构建配置用,打进拓展包就是一份宿主代码的拷贝`,
				};
	}
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

	it("构建子路径:拓展根上的构建配置放行,src/ 里判红", () => {
		expect(boundaryViolation(EXTENSION_BUILD_PACKAGE, "")).toBeNull();
		expect(boundaryViolation(EXTENSION_BUILD_PACKAGE, "src")?.why).toContain("构建配置");
		expect(boundaryViolation(EXTENSION_BUILD_PACKAGE, "src/devtools")).not.toBeNull();
		expect(boundaryViolation(`${EXTENSION_PACKAGE}/lib/index.mjs`, "")).not.toBeNull();
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
/* 反方向:核心不 import 拓展,也不 import 门                                 */
/* -------------------------------------------------------------------------- */

/**
 * 🔴 **另一条边:核心不 import 拓展,也不 import 门。**
 *
 * 上半场只扫了「拓展够不够得到核心」,而那条规矩是**两条边**:核心伸手进
 * `extensions/` 或依赖契约门同样致命,而且更隐蔽 ——
 *
 * - **拓展是装进来的,本体一个都不带**(ADR-0012)。核心 import 它等于把一个可选的、
 *   随时会被卸载 / 换版本的东西编进主程序:那个目录在主人机器上根本不存在。
 * - **门是给拓展的出口,不是核心的入口。** 东西都定义在 `@bilibili-notify/internal`,
 *   门只负责把它们转给拓展;核心直接够到某个拓展的内部,也等于宣布「桥的那个文件也是契约」—— 而那个拓展有自己的发版节奏。
 * - **越界照样是静默的**:仓里有源码、tsc 编得过、测试全绿,只有真机上那份没有仓库源码
 *   的载荷会炸,或者更糟:装的那一版和编进去的那一份不是同一版。
 */
export function crossesExtensionBoundary(
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
	// 拓展都是 workspace 包(`@bilibili-notify/extension-<id>`);门本身及其子路径是拓展
	// 契约的出口。核心两样都不碰。
	return isExtensionSurface(specifier);
}

describe("核心越界判据", () => {
	const root = `${sep}repo${sep}extensions`;
	const from = `${sep}repo${sep}apps${sep}server${sep}src`;

	it("放行:宿主自己那个 src/extensions/(装载器住那儿)与 internal", () => {
		expect(crossesExtensionBoundary("./extensions/loader.js", from, root)).toBe(false);
		expect(crossesExtensionBoundary("../extensions/mount.js", from, root)).toBe(false);
		expect(crossesExtensionBoundary(INTERNAL_PACKAGE, from, root)).toBe(false);
		expect(crossesExtensionBoundary(`${INTERNAL_PACKAGE}/extension`, from, root)).toBe(false);
	});

	it("判红:爬到仓根的 extensions/、依赖拓展包,或者碰契约门", () => {
		expect(crossesExtensionBoundary("../../../extensions/bridge/src/protocol.js", from, root)).toBe(
			true,
		);
		expect(crossesExtensionBoundary("@bilibili-notify/extension-bridge", from, root)).toBe(true);
		expect(crossesExtensionBoundary(EXTENSION_PACKAGE, from, root)).toBe(true);
		expect(crossesExtensionBoundary(`${EXTENSION_PACKAGE}/wire`, from, root)).toBe(true);
	});
});

/** 仓根 —— 从本文件往上五级(`apps/server/src/extensions/__tests__`)。 */
const REPO_ROOT = join(fileURLToPath(dirname(import.meta.url)), "..", "..", "..", "..", "..");

function coreImportViolations(source: ReturnType<typeof parseSource>): string[] {
	// 从核心进入仓根 extensions/ 或契约包，说明符中必然有 extension。
	// 字面量可以用转义拼出这个词，所以有反斜杠的源码也交给原有 AST 判据。
	if (!source.text.includes("extension") && !source.text.includes("\\")) return [];
	const fromDir = dirname(join(REPO_ROOT, source.path));
	const extensionsRoot = join(REPO_ROOT, "extensions");
	return importsOf(source)
		.filter((ref) => crossesExtensionBoundary(ref.specifier, fromDir, extensionsRoot))
		.map((ref) => `${source.path}:${ref.line}: ${ref.specifier}`);
}

describe("核心不碰拓展与契约门", () => {
	const roots = srcRootsUnder(["apps", "packages"], { except: [EXTENSION_SOURCE_ROOT] });
	const sources = roots.map((root) => ({ root, files: listSources([root], { tests: true }) }));

	it("扫描范围包含核心源码，并排除契约门自身", () => {
		expect(sources.some(({ files }) => files.length > 0)).toBe(true);
		expect(roots).not.toContain(EXTENSION_SOURCE_ROOT);
	});

	it("契约包和相对路径里的转义照样报出实际引用行", () => {
		const file = "apps/server/src/example.ts";
		const source = parseSource(
			file,
			String.raw`// import("@bilibili-notify/ext\u0065nsion");
import "@bilibili-notify/ext\u0065nsion/build";
export * from "../../../ext\x65nsions/bridge/src/protocol.js";`,
		);
		expect(coreImportViolations(source)).toEqual([
			`${file}:2: @bilibili-notify/extension/build`,
			`${file}:3: ../../../extensions/bridge/src/protocol.js`,
		]);
	});

	it.each(sources)("$root 里没有一条 import 够到拓展或门", ({ files }) => {
		const violations = files.flatMap((file) => coreImportViolations(parseSource(file)));
		expect(violations).toEqual([]);
	});
});

const DEPENDENCY_FIELDS = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
] as const;

/** 只扫 import 拦不住依赖还声明着;pnpm 照样会把门连进宿主。 */
function forbiddenExtensionDependencies(manifest: Record<string, unknown>): string[] {
	return DEPENDENCY_FIELDS.flatMap((field) => {
		const dependencies = manifest[field];
		if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) {
			return [];
		}
		return Object.keys(dependencies).filter(isExtensionPackage);
	});
}

function workspacePackageManifests(): string[] {
	const manifests: string[] = [];
	for (const group of ["apps", "packages"]) {
		for (const entry of readdirSync(join(REPO_ROOT, group), { withFileTypes: true })) {
			const packageDir = `${group}/${entry.name}`;
			if (!entry.isDirectory() || packageDir === EXTENSION_PACKAGE_DIR) continue;
			const manifest = `${packageDir}/package.json`;
			if (existsSync(join(REPO_ROOT, manifest))) manifests.push(manifest);
		}
	}
	return manifests.sort();
}

describe("宿主与别的包不声明拓展依赖", () => {
	it("只扫 import 拦不住依赖还声明着,pnpm 照样会把门连进来", () => {
		expect(
			forbiddenExtensionDependencies({
				dependencies: { [EXTENSION_PACKAGE]: "workspace:*" },
				devDependencies: { "@bilibili-notify/extension-bridge": "workspace:*" },
				peerDependencies: { [EXTENSION_PACKAGE]: "workspace:*" },
				optionalDependencies: { "@bilibili-notify/extension-source": "workspace:*" },
			}),
		).toEqual([
			EXTENSION_PACKAGE,
			"@bilibili-notify/extension-bridge",
			EXTENSION_PACKAGE,
			"@bilibili-notify/extension-source",
		]);
		expect(
			forbiddenExtensionDependencies({
				dependencies: { [INTERNAL_PACKAGE]: "workspace:*" },
			}),
		).toEqual([]);
	});

	it("apps/* 与 packages/* 的四类依赖里都没有门或拓展包", () => {
		const manifests = workspacePackageManifests();
		expect(manifests.length).toBeGreaterThan(0);
		expect(manifests).not.toContain(`${EXTENSION_PACKAGE_DIR}/package.json`);

		const violations = manifests.flatMap((path) => {
			const manifest = JSON.parse(readFileSync(join(REPO_ROOT, path), "utf8")) as Record<
				string,
				unknown
			>;
			return forbiddenExtensionDependencies(manifest).map((name) => `${path}: ${name}`);
		});
		expect(violations).toEqual([]);
	});
});

const isInternalSpecifier = (specifier: string) =>
	specifier === INTERNAL_PACKAGE || specifier.startsWith(`${INTERNAL_PACKAGE}/`);

const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

function sourceFilesUnder(relDir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(join(REPO_ROOT, relDir), { withFileTypes: true })) {
		const rel = `${relDir}/${entry.name}`;
		if (entry.isDirectory()) {
			if (entry.name !== "__tests__") files.push(...sourceFilesUnder(rel));
		} else if (entry.isFile() && SOURCE_FILE.test(entry.name)) {
			files.push(rel);
		}
	}
	return files.sort();
}

function extensionDoorProblems(
	source: ReturnType<typeof parseSource>,
	values: ReadonlySet<string> = EXTENSION_VALUES,
): string[] {
	const { ast } = source;
	const lineOf = (node: ts.Node) => ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
	return ast.statements.flatMap((statement) => {
		const line = lineOf(statement);
		if (
			!ts.isExportDeclaration(statement) ||
			statement.moduleSpecifier === undefined ||
			!statement.exportClause ||
			!ts.isNamedExports(statement.exportClause)
		) {
			return [`${source.path}:${line} 不是带说明符的具名 export-from`];
		}

		const specifier = ts.isStringLiteral(statement.moduleSpecifier)
			? statement.moduleSpecifier.text
			: "";
		if (!isInternalSpecifier(specifier)) {
			return [`${source.path}:${line} 说明符不指向 internal: ${specifier}`];
		}

		if (statement.isTypeOnly) return [];
		return statement.exportClause.elements.flatMap((element) => {
			if (element.isTypeOnly) return [];
			const sourceName = element.propertyName?.text ?? element.name.text;
			if (sourceName === element.name.text && values.has(sourceName)) return [];
			return [`${source.path}:${line} 值级转出只许 ${[...values].join(" / ")}`];
		});
	});
}

describe("契约门只转出", () => {
	const problems = (text: string) => extensionDoorProblems(parseSource(EXTENSION_ENTRY, text));

	it("放行:指向 internal 的类型转出与三个纯函数", () => {
		expect(
			problems(
				[
					`export type { ExtensionContext } from "${INTERNAL_PACKAGE}/extension";`,
					`export { type Result } from "${INTERNAL_PACKAGE}";`,
					`export { ok, fail } from "${INTERNAL_PACKAGE}/result";`,
					`export { neutralPlatformDescriptor } from "${INTERNAL_PACKAGE}/platform-descriptor";`,
				].join("\n"),
			),
		).toEqual([]);
	});

	it("判红:本地声明、import、export *、别的说明符与第四个值", () => {
		expect(problems("export interface X {}")).toHaveLength(1);
		expect(problems(`import { z } from "zod";`)).toHaveLength(1);
		expect(problems(`export * from "${INTERNAL_PACKAGE}";`)).toHaveLength(1);
		expect(problems(`export type { ExtensionContext } from "./extension";`)).toHaveLength(1);
		expect(problems(`export { Result } from "${INTERNAL_PACKAGE}";`)).toHaveLength(1);
	});

	it("构建子路径同一套:只转出 internal 的,值只许那两个构建用的", () => {
		const build = (text: string) =>
			extensionDoorProblems(parseSource(EXTENSION_BUILD_ENTRY, text), EXTENSION_BUILD_VALUES);
		expect(
			build(`export { extensionPackageFiles } from "${INTERNAL_PACKAGE}/extension/build";`),
		).toEqual([]);
		expect(build(`export { ok } from "${INTERNAL_PACKAGE}/result";`)).toHaveLength(1);
		expect(build("export function extensionPackageFiles() {}")).toHaveLength(1);
	});

	it("src/ 里除测试外只有 index.ts 与 build.ts,两个入口都没有越出转出规则", () => {
		expect(sourceFilesUnder(EXTENSION_SOURCE_ROOT)).toEqual([
			EXTENSION_BUILD_ENTRY,
			EXTENSION_ENTRY,
		]);
		const entry = parseSource(EXTENSION_ENTRY);
		expect(entry.ast.statements.length).toBeGreaterThan(0);
		expect(extensionDoorProblems(entry)).toEqual([]);
		const build = parseSource(EXTENSION_BUILD_ENTRY);
		expect(build.ast.statements.length).toBeGreaterThan(0);
		expect(extensionDoorProblems(build, EXTENSION_BUILD_VALUES)).toEqual([]);
	});
});
