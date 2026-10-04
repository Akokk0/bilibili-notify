/**
 * 图库只有一扇门(ADR-0022 决策 9 下 10-04「⑳ 开片」的 🔗)。
 *
 * 「写图库就得登记成引用方」是靠结构保证的:存图的口不挂在图库上,登记了才拿得到。能绕开它的只剩
 * 两条路,这里各钉一条 ——
 *
 * 1. 另建一座图库:`createImageStore` 只许运行时装配那一处调。第二座图库有自己的登记表,它的引用方
 *    运行时那座一家都不认识,清扫会把它们的图当垃圾。
 * 2. 绕过图库直接往 `images/` 里写:`dataPath(…, "images")` 只许名单上的文件用。
 *
 * 判据写成纯函数 + 样例,因为判据本身也会写错:一条永远判 OK 的规则跟没有一样。
 */

import { describe, expect, it } from "vite-plus/test";
import {
	findNodes,
	listSources,
	parseSource,
	type Source,
	ts,
} from "../../../../../scripts/source-scan.mjs";

const IMAGE_STORE_MODULE = "apps/server/src/images/image-store.ts";

/** 可以建图库的地方。 */
const STORE_BUILDERS: Record<string, string> = {
	"apps/server/src/runtime/bootstrap.ts": "运行时装配:全进程一座",
};

/** 可以拿到 `images/` 这个目录的地方。每个都得真的用到,不然这张名单就在烂。 */
const IMAGES_DIR_USERS: Record<string, string> = {
	"apps/server/src/runtime/bootstrap.ts": "把目录交给图库",
	"apps/server/src/migration/zero-generation.ts":
		"迁移开新代时直接往新代的 images/ 落文件(0.x 的聊天附件 ⑳b、拓展订阅头像 ⑳c、历史图与重推原件自存的图 ⑳d):新代的图库此刻没在跑,不联网、不走 ImageWriter;文件名只认 imageRefOf 一份规矩",
};

/** 一份源码里调 `createImageStore(...)` 的行。 */
export function imageStoreBuilds(source: Source): number[] {
	return findNodes(
		source,
		(node) =>
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === "createImageStore",
	).map((hit) => hit.line);
}

/** 一份源码里 `dataPath(根, "images", …)` 的行。 */
export function imagesDirLookups(source: Source): number[] {
	return findNodes(source, (node) => {
		if (!ts.isCallExpression(node)) return false;
		if (!ts.isIdentifier(node.expression) || node.expression.text !== "dataPath") return false;
		const key = node.arguments[1];
		return key !== undefined && ts.isStringLiteralLike(key) && key.text === "images";
	}).map((hit) => hit.line);
}

const sample = (text: string) => parseSource("sample.ts", text);

describe("判据", () => {
	it("认得出建图库的调用,不把导入、类型、注释当成调用", () => {
		expect(imageStoreBuilds(sample(`const s = createImageStore({ dir });`))).toEqual([1]);
		expect(
			imageStoreBuilds(
				sample(
					`import { createImageStore, type ImageStore } from "./image-store.js";\n// createImageStore({ dir })\nlet s: ImageStore;`,
				),
			),
		).toEqual([]);
	});

	it("认得出拿 images 目录的调用,别的键不算", () => {
		expect(imagesDirLookups(sample(`dataPath(dataRoot, "images")`))).toEqual([1]);
		expect(imagesDirLookups(sample(`dataPath(root, "images", name)`))).toEqual([1]);
		expect(imagesDirLookups(sample(`dataPath(dataRoot, "history", "images")`))).toEqual([]);
		expect(imagesDirLookups(sample(`hostPath(hostRoot, "images")`))).toEqual([]);
	});
});

describe("图库只有一扇门", () => {
	const sources = listSources(["apps/server/src"]).filter((path) => path !== IMAGE_STORE_MODULE);

	it("建图库的只有运行时装配那一处", () => {
		const offenders = sources
			.filter((path) => !(path in STORE_BUILDERS))
			.flatMap((path) => imageStoreBuilds(parseSource(path)).map((line) => `${path}:${line}`));
		expect(offenders, "用 runtime.imageStore,别另建一座").toEqual([]);
	});

	it("拿 images 目录的只有名单上的文件", () => {
		const offenders = sources
			.filter((path) => !(path in IMAGES_DIR_USERS))
			.flatMap((path) => imagesDirLookups(parseSource(path)).map((line) => `${path}:${line}`));
		expect(offenders, "存图走 runtime.imageStore.register(...) 回来的口").toEqual([]);
	});

	it("两张名单上的每个文件都真的用到", () => {
		for (const path of Object.keys(STORE_BUILDERS)) {
			expect(imageStoreBuilds(parseSource(path)), path).not.toEqual([]);
		}
		for (const path of Object.keys(IMAGES_DIR_USERS)) {
			expect(imagesDirLookups(parseSource(path)), path).not.toEqual([]);
		}
	});
});
