import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
	missingServerBundleFiles,
	missingServerBundleFilesIn,
	SERVER_BUNDLE_FILES,
	serverBundleChunksIn,
} from "./server-bundle-assets.mjs";

/**
 * 见 server-bundle-assets.mjs 顶部:bundle 里运行时按路径读盘的资产少一个不会在
 * 构建期报错。这份清单是装配、升级载荷、桌面资源三处共用的把关依据。
 */
describe("missingServerBundleFiles", () => {
	it("清单里的都在 → 不缺", () => {
		expect(missingServerBundleFiles(SERVER_BUNDLE_FILES)).toEqual([]);
	});

	it("多出来的文件不算数,少的逐个点名", () => {
		const present = SERVER_BUNDLE_FILES.filter(
			(f) => f !== "jieba_rs_wasm_bg.wasm" && f !== "static/render.js",
		);
		expect(missingServerBundleFiles([...present, "extra.txt"])).toEqual([
			"static/render.js",
			"jieba_rs_wasm_bg.wasm",
		]);
	});

	// 入口与选版器是「装上去起不起得来」的分界线,必须在清单里。
	it("入口、boot 与 package.json 在清单里", () => {
		expect(SERVER_BUNDLE_FILES).toContain("index.mjs");
		expect(SERVER_BUNDLE_FILES).toContain("boot.mjs");
		expect(SERVER_BUNDLE_FILES).toContain("package.json");
	});
});

describe("missingServerBundleFilesIn", () => {
	let dir;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "bn-bundle-assets-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("按目录实际内容判断,子目录里的也算", async () => {
		for (const file of SERVER_BUNDLE_FILES) {
			if (file === "xhr-sync-worker.js") continue;
			const abs = join(dir, ...file.split("/"));
			await mkdir(join(abs, ".."), { recursive: true });
			await writeFile(abs, "x");
		}
		expect(await missingServerBundleFilesIn(dir)).toEqual(["xhr-sync-worker.js"]);
	});
});

/**
 * dist 不是一个文件:boot.mjs / index.mjs 静态 import 了若干带 hash 的分块,分块之间还互相
 * import。分块不进手写清单(hash 每次构建都变),但少一块是「装上去第一行就 ERR_MODULE_NOT_FOUND」——
 * 必需集从两个入口的 import 图现算。
 */
describe("serverBundleChunksIn", () => {
	let dir;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "bn-bundle-chunks-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	const write = async (name, content) => {
		await mkdir(join(dir, name, ".."), { recursive: true });
		await writeFile(join(dir, name), content);
	};

	it("沿两个入口的静态 / 动态 import 走完整张图,资产、node: 内置与内联源码里的 .js 串都不算", async () => {
		await write(
			"boot.mjs",
			'import { a } from "./versions-root-Ab12.mjs";\nimport { readFileSync } from "node:fs";\n',
		);
		await write(
			"index.mjs",
			[
				'import "./versions-root-Ab12.mjs";',
				'import { x } from "./main-Cd34.mjs";',
				'const lazy = () => import("./openai-Ef56.mjs");',
				// 内联进来的第三方源码留下的字符串:dist 里没有这个文件,也不该被当成分块。
				"const inlined = \"() => import('./client.js')\";",
				// puppeteer 懒加载 bidi 的写法:括号里夹着块注释、还跨行。
				"const bidi = () => import(",
				"\t/* webpackIgnore: true */",
				'\t"./bidi-Ij90.mjs"',
				");",
			].join("\n"),
		);
		await write("bidi-Ij90.mjs", "export const z = 4;\n");
		await write("versions-root-Ab12.mjs", "export const a = 1;\n");
		await write("main-Cd34.mjs", 'export * from "./dist-Gh78.mjs";\nexport const x = 2;\n');
		await write("dist-Gh78.mjs", "export const y = 3;\n");
		await write("openai-Ef56.mjs", 'import { y } from "./dist-Gh78.mjs";\nexport default y;\n');
		await write("static/render.js", "// 按路径读盘的资产,不是 import 图的一部分\n");
		expect(await serverBundleChunksIn(dir)).toEqual({
			chunks: [
				"bidi-Ij90.mjs",
				"dist-Gh78.mjs",
				"main-Cd34.mjs",
				"openai-Ef56.mjs",
				"versions-root-Ab12.mjs",
			],
			missing: [],
		});
	});

	it("图里点到的分块不在盘上 → 点名缺失,不吞", async () => {
		await write("boot.mjs", 'import { a } from "./versions-root-Ab12.mjs";\n');
		await write("index.mjs", 'import { x } from "./main-Cd34.mjs";\n');
		await write("versions-root-Ab12.mjs", "export const a = 1;\n");
		expect(await serverBundleChunksIn(dir)).toEqual({
			chunks: ["main-Cd34.mjs", "versions-root-Ab12.mjs"],
			missing: ["main-Cd34.mjs"],
		});
	});

	it("入口本身不在 → 交给手写清单去报,这里不炸", async () => {
		await write("index.mjs", "export {};\n");
		expect(await serverBundleChunksIn(dir)).toEqual({ chunks: [], missing: [] });
	});

	// 三个消费者都只调 missingServerBundleFilesIn:分块缺失得从同一个口子报出来。
	it("missingServerBundleFilesIn 把缺的分块一并点名", async () => {
		for (const file of SERVER_BUNDLE_FILES) {
			const content = file === "index.mjs" ? 'import { x } from "./main-Cd34.mjs";\n' : "x";
			await write(file, content);
		}
		expect(await missingServerBundleFilesIn(dir)).toEqual(["main-Cd34.mjs"]);
	});
});
