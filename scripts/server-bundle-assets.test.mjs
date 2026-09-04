import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
	BUNDLE_MANIFEST_FILE,
	missingServerBundleFiles,
	missingServerBundleFilesIn,
	SERVER_BUNDLE_FILES,
	writeServerBundleManifest,
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

	const seed = async (name, content = "x") => {
		const abs = join(dir, ...name.split("/"));
		await mkdir(join(abs, ".."), { recursive: true });
		await writeFile(abs, content);
	};
	const seedManifestFiles = async () => {
		for (const file of SERVER_BUNDLE_FILES) {
			if (file !== BUNDLE_MANIFEST_FILE) await seed(file);
		}
	};

	it("按目录实际内容判断,子目录里的也算", async () => {
		await seedManifestFiles();
		await writeServerBundleManifest(dir);
		await rm(join(dir, "xhr-sync-worker.js"));
		expect(await missingServerBundleFilesIn(dir)).toEqual(["xhr-sync-worker.js"]);
	});

	// dist 不是一个文件:入口之外还有带 hash 的分块,名字每次构建都变。装配那一刻把盘上的
	// 一切记进 bundle-manifest.json,下游只核对「记下的都还在」—— 搬丢一块在这里红。
	it("装配后记下的分块搬丢了 → 点名;手写清单里的不重复报", async () => {
		await seedManifestFiles();
		await seed("main-Cd34.mjs");
		await seed("versions-root-Ab12.mjs");
		expect(await writeServerBundleManifest(dir)).toEqual(
			[
				...SERVER_BUNDLE_FILES.filter((f) => f !== BUNDLE_MANIFEST_FILE),
				"main-Cd34.mjs",
				"versions-root-Ab12.mjs",
			].sort(),
		);
		await rm(join(dir, "main-Cd34.mjs"));
		await rm(join(dir, "jieba_rs_wasm_bg.wasm"));
		expect(await missingServerBundleFilesIn(dir)).toEqual([
			"jieba_rs_wasm_bg.wasm",
			"main-Cd34.mjs",
		]);
	});

	it("清单本身不在 → 只报它,不去猜别的", async () => {
		await seedManifestFiles();
		expect(await missingServerBundleFilesIn(dir)).toEqual([BUNDLE_MANIFEST_FILE]);
	});

	it("清单不记自己,只记文件(posix 分隔、排好序)", async () => {
		await seed("boot.mjs");
		await seed("static/render.js");
		await seed("a-chunk.mjs");
		const files = await writeServerBundleManifest(dir);
		expect(files).toEqual(["a-chunk.mjs", "boot.mjs", "static/render.js"]);
		expect(JSON.parse(await readFile(join(dir, BUNDLE_MANIFEST_FILE), "utf8"))).toEqual({ files });
	});
});
