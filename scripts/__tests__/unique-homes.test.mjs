import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { findNodes, listSources, parseSource, ts } from "../source-scan.mjs";

/**
 * 守卫 4:名字唯一的家(docs/1.0/architecture.md「守卫」第 4 行)。
 *
 * 同一件事抄成好几份,几份之间迟早长出分歧 —— 「N 分钟前」四份里一份不带空格,带正负号的
 * 增量负号两种、零三种写法,都是这么来的。点名表里的名字全仓只许在它的家里定义一次;家以外
 * 出现同名定义就红,**不导出的局部函数也算**(首页那份本地 `formatCount` 就没导出)。
 *
 * - 范围:`apps/<应用>/src`、`packages/<包>/src`,不含测试;不扫 `extensions/`(拓展只能从
 *   `@bilibili-notify/extension` 拿东西,自带的同名小函数不算抄本)。
 * - 定义:函数声明、变量声明、类声明、方法(类的与对象字面量的)。调用、import、类型都不算。
 * - 点名表随各项补(1.0 第 2 期 ⑪ 开张,头一批是数字与时间的排版);家里没有定义也红,免得
 *   表跟着代码过期。
 * - 守卫 4 抓不到异名抄本(⑪ 收掉的 `numberToStr`、`relativeTime` 就是这类),那些靠收的那一片
 *   按清单清。
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** 点名表:名字 → 唯一的家(仓库相对路径)。 */
export const HOMES = {
	formatCount: "packages/internal/src/format.ts",
	formatAgo: "packages/internal/src/format.ts",
	formatDuration: "packages/internal/src/format.ts",
	formatClock: "packages/internal/src/format.ts",
	formatAxisTick: "apps/web/src/pages/stats/chart-utils.ts",
};

/** 一个节点若是一处定义,回它定义的名字。 */
function definedName(node) {
	if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name !== undefined) {
		return node.name.text;
	}
	if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
	if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
	return undefined;
}

/**
 * 一份源码里点名表上那些名字的定义。
 *
 * @returns `{ name, line }[]`,按出现顺序
 */
export function namedDefinitions(source, names) {
	const wanted = new Set(names);
	return findNodes(source, (node) => wanted.has(definedName(node) ?? "")).map(({ node, line }) => ({
		name: definedName(node),
		line,
	}));
}

const NAMES = ["formatCount", "formatAgo"];

/** 把一段样例当成一份 `.ts` 源码,返回命中的 `名字:行号`。 */
const hitsIn = (text) =>
	namedDefinitions(parseSource("sample.ts", text), NAMES).map((h) => `${h.name}:${h.line}`);

describe("定义的判据:算", () => {
	it("函数声明,导不导出都算", () => {
		expect(hitsIn(`export function formatCount(n) {}`)).toEqual(["formatCount:1"]);
		expect(hitsIn(`function formatAgo(t) {}`)).toEqual(["formatAgo:1"]);
	});

	it("变量里装的箭头函数,以及类与对象字面量里的方法", () => {
		expect(hitsIn(`const formatCount = (n) => String(n);`)).toEqual(["formatCount:1"]);
		expect(hitsIn(`class F {\n\tformatAgo(t) {}\n}`)).toEqual(["formatAgo:2"]);
		expect(hitsIn(`const fmt = {\n\tformatCount(n) { return ""; },\n};`)).toEqual([
			"formatCount:2",
		]);
	});
});

describe("定义的判据:不算", () => {
	it("调用、import、类型、属性名、表外的名字", () => {
		expect(
			hitsIn(
				[
					`import { formatCount } from "@bilibili-notify/internal/format";`,
					`const text = formatCount(12345);`,
					`type T = typeof formatAgo;`,
					`const opts = { formatCount: formatCount };`,
					`function formatWan(n) {}`,
				].join("\n"),
			),
		).toEqual([]);
	});
});

function scopeRoots() {
	const roots = [];
	for (const group of ["apps", "packages"]) {
		for (const entry of readdirSync(join(REPO_ROOT, group), { withFileTypes: true })) {
			if (entry.isDirectory() && existsSync(join(REPO_ROOT, group, entry.name, "src"))) {
				roots.push(`${group}/${entry.name}/src`);
			}
		}
	}
	return roots.sort();
}

/** 真去扫仓库:名字 → 定义它的 `文件:行号`。 */
function scanRepo() {
	const found = {};
	for (const file of listSources(scopeRoots())) {
		for (const { name, line } of namedDefinitions(parseSource(file), Object.keys(HOMES))) {
			found[name] ??= [];
			found[name].push(`${file}:${line}`);
		}
	}
	return found;
}

describe("点名表上的名字都只在家里定义", () => {
	const found = scanRepo();

	it("家以外没有同名定义", () => {
		const strays = Object.entries(found).flatMap(([name, places]) =>
			places.filter((place) => !place.startsWith(`${HOMES[name]}:`)).map((p) => `${name} @ ${p}`),
		);
		expect(strays).toEqual([]);
	});

	it("每个名字在家里都真有定义 —— 表不跟着代码过期", () => {
		const homeless = Object.entries(HOMES)
			.filter(([name, home]) => !(found[name] ?? []).some((place) => place.startsWith(`${home}:`)))
			.map(([name, home]) => `${name} → ${home}`);
		expect(homeless).toEqual([]);
	});
});
