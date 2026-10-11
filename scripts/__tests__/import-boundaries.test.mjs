import { posix } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { importsOf, listSources, parseSource } from "../source-scan.mjs";

/**
 * 守卫:谁不许 import 谁(推送守卫①)。
 *
 * 一张表,每行一条边界:扫哪些目录、不许解析到哪个目标、哪些文件是例外、为什么。判据按**解析后的路径**
 * 判(相对说明符对着 importer 所在目录算出仓库相对路径,再看落没落进目标),不按字符串里有没有那个目录名:
 * 注释、字符串里的字样天生不是 import 节点(`source-scan` 走语法树);`import type`、`export … from`、
 * 动态 `import()` 都算 —— 类型 import 同样把核心和某个具体平台绑在一起。
 *
 * 不扫测试(测试要造具体平台的真壳,见 `source-scan` 默认)。
 * 判据写成纯函数 + 样例,因为判据本身也会写错:一条永远判 OK 的规则跟没有一样。
 */

/**
 * @typedef {object} Boundary
 * @property {string} id
 * @property {string[]} roots 扫哪些目录(仓库相对)
 * @property {string} target 不许解析进去的目录(仓库相对)
 * @property {string[]} skipUnder 目标自己的内部不受限(目录前缀)
 * @property {string[]} allowed 例外文件(仓库相对);每个都必须真的在 import 目标
 * @property {string} reason
 */

/** @type {Boundary[]} */
export const BOUNDARIES = [
	{
		id: "核心不许 import platforms/",
		roots: ["apps/server/src"],
		target: "apps/server/src/platforms",
		skipUnder: ["apps/server/src/platforms"],
		allowed: ["apps/server/src/compose.ts"],
		reason:
			"内置平台适配器只在组装根 compose.ts 里造;核心(推送、引擎、路由、入口)只认 PlatformAdapter 接口,不认具体平台",
	},
];

/** 说明符解析成仓库相对路径;非相对说明符(包名)返回 undefined。 */
function resolveSpecifier(file, specifier) {
	if (!specifier.startsWith(".")) return undefined;
	return posix.normalize(posix.join(posix.dirname(file), specifier));
}

const isInside = (path, dir) => path === dir || path.startsWith(`${dir}/`);

/** 去掉 `.js` / `.ts` 之类的尾巴后再比目录:`./platforms.js` 之类解析成 `…/platforms` 也算进去。 */
const stripExt = (path) => path.replace(/\.(m|c)?[jt]sx?$/, "");

/**
 * 一份源码里违反某条边界的 import。
 *
 * @returns `{ line, specifier }[]`
 */
export function violationsOf(file, source, boundary) {
	if (boundary.skipUnder.some((dir) => isInside(file, dir))) return [];
	return importsOf(source)
		.filter((ref) => {
			const resolved = resolveSpecifier(file, ref.specifier);
			return resolved !== undefined && isInside(stripExt(resolved), boundary.target);
		})
		.map((ref) => ({ line: ref.line, specifier: ref.specifier }));
}

const sample = (file, text) => violationsOf(file, parseSource(file, text), BOUNDARIES[0]);

describe("越界判据:算", () => {
	it("静态 import、import type、export from、动态 import、side-effect import 都算", () => {
		expect(
			sample(
				"apps/server/src/index.ts",
				[
					`import { a } from "./platforms/onebot.js";`,
					`import type { B } from "./platforms/qq-official.js";`,
					`export { c } from "./platforms/webhook.js";`,
					`const d = await import("./platforms/onebot.js");`,
					`import "./platforms/webhook.js";`,
				].join("\n"),
			).map((hit) => hit.line),
		).toEqual([1, 2, 3, 4, 5]);
	});

	it("按解析后的路径判:从深层目录绕回来的相对路径也算", () => {
		expect(
			sample(
				"apps/server/src/push/deep/file.ts",
				`import { a } from "../../platforms/onebot.js";\nimport { b } from "../../push/../platforms/x.js";`,
			).map((hit) => hit.line),
		).toEqual([1, 2]);
	});

	it("目录自己的入口(没有文件名)也算", () => {
		expect(sample("apps/server/src/index.ts", `import { a } from "./platforms";`)).toHaveLength(1);
	});
});

describe("越界判据:不算", () => {
	it("注释与字符串里的字样", () => {
		expect(
			sample(
				"apps/server/src/migration/zero-platforms.ts",
				[
					`// import { a } from "./platforms/onebot.js";`,
					`/** 也不 import \`platforms/\` */`,
					`const hint = 'import x from "./platforms/onebot.js"';`,
				].join("\n"),
			),
		).toEqual([]);
	});

	it("名字里带 platforms 但解析不到目标目录的", () => {
		expect(
			sample(
				"apps/server/src/index.ts",
				[
					`import { a } from "./migration/zero-platforms.js";`,
					`import { b } from "./platforms-extra/x.js";`,
					`import { c } from "@bilibili-notify/platforms/x";`,
				].join("\n"),
			),
		).toEqual([]);
	});

	it("目标目录自己的内部互相 import", () => {
		expect(
			sample("apps/server/src/platforms/onebot.ts", `import { a } from "./onebot-inbound.js";`),
		).toEqual([]);
	});
});

describe.each(BOUNDARIES)("边界:$id", (boundary) => {
	const files = listSources(boundary.roots);

	it("扫到了源码(扫空了等于没有这道守卫)", () => {
		expect(files.length).toBeGreaterThan(0);
		expect(files.some((file) => isInside(file, boundary.target))).toBe(true);
	});

	it("除例外外一处都没有", () => {
		const hits = files
			.filter((file) => !boundary.allowed.includes(file))
			.flatMap((file) =>
				violationsOf(file, parseSource(file), boundary).map(
					(hit) => `${file}:${hit.line}  ${hit.specifier}`,
				),
			);
		expect(hits, boundary.reason).toEqual([]);
	});

	it("例外名单里的文件真的在 import 目标(名单不留没用的例外)", () => {
		for (const file of boundary.allowed) {
			expect(files, `${file} 不在扫描范围里`).toContain(file);
			expect(
				violationsOf(file, parseSource(file), boundary),
				`${file} 没有在 import 目标`,
			).not.toEqual([]);
		}
	});
});
