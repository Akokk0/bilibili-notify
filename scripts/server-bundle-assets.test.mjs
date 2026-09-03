import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
	missingServerBundleFiles,
	missingServerBundleFilesIn,
	SERVER_BUNDLE_FILES,
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
