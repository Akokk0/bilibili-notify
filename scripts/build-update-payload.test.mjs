import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { installPayload } from "../apps/server/src/update/install-payload.js";
import { buildUpdatePayload } from "./build-update-payload.mjs";
import { SERVER_BUNDLE_FILES } from "./server-bundle-assets.mjs";

/**
 * 升级载荷的**发版侧**。
 *
 * 这里的测试故意跨到客户端那半边去(`installPayload`):打包和解包是同一个契约的
 * 两头,分开各测各的等于两边各自复述自己的想法 —— 布局对不对、路径分隔符对不对、
 * 目录条目要不要写,全都只有把 zip 真的解出来才知道。而这类错的代价是**发版全绿、
 * 用户升完起不来**,一次就是一版事故。
 */
describe("buildUpdatePayload", () => {
	let root;
	let seedSeq = 0;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "bn-payload-"));
		seedSeq = 0;
	});
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	/**
	 * 摆一份最小但**合法**的构建产物:server dist(清单 SERVER_BUNDLE_FILES 里的每一个
	 * 文件都在)+ web dist。每次调用各用一套目录。
	 */
	async function seedDists(overrides = {}) {
		const at = join(root, `seed-${seedSeq++}`);
		const serverDist = join(at, "server-dist");
		const webDist = join(at, "web-dist-src");
		await mkdir(join(serverDist, "static"), { recursive: true });
		await mkdir(join(webDist, "assets"), { recursive: true });
		for (const file of SERVER_BUNDLE_FILES) {
			if (file === "index.mjs" || file === "package.json" || file === "static/render.js") continue;
			await writeFile(join(serverDist, ...file.split("/")), `// ${file}\n`);
		}
		if (overrides.serverEntry !== false)
			await writeFile(join(serverDist, "index.mjs"), "console.log('bn');\n");
		await writeFile(join(serverDist, "package.json"), JSON.stringify({ version: "0.9.0" }));
		await writeFile(join(serverDist, "static", "render.js"), "// 词云\n");
		if (overrides.webEntry !== false)
			await writeFile(join(webDist, "index.html"), "<!doctype html><title>bn</title>");
		await writeFile(join(webDist, "assets", "app.js"), "export {};\n");
		return { serverDist, webDist };
	}

	it("打出来的包,客户端解出来就是能跑的载荷目录", async () => {
		const { serverDist, webDist } = await seedDists();
		const outFile = join(root, "payload.zip");

		const built = await buildUpdatePayload({ serverDist, webDist, outFile });

		// 直接交给客户端那半边去装 —— 布局对不对由它说了算,不由我们自己复述。
		const versionsRoot = join(root, "versions");
		const installed = installPayload({
			zip: await readFile(outFile),
			expectedSha256: built.sha256,
			version: "0.9.0",
			versionsRoot,
		});
		if (!installed.ok) throw new Error(`install failed: ${installed.reason}`);

		const at = (...parts) => join(installed.path, ...parts);
		// 入口与 package.json 在**根**:resolveAppVersion 与 web-dist 都按 index.mjs 就近解析。
		expect(await readFile(at("index.mjs"), "utf8")).toContain("console.log");
		expect(JSON.parse(await readFile(at("package.json"), "utf8")).version).toBe("0.9.0");
		// 运行时资产要跟着走,否则词云 / wasm 这类 __dirname 读盘的东西当场炸。
		expect(await readFile(at("static", "render.js"), "utf8")).toContain("词云");
		// dashboard 必须落在 web-dist/ —— 服务端就是按这个同级目录找它的。
		expect(await readFile(at("web-dist", "index.html"), "utf8")).toContain("<title>bn</title>");
		expect(await readFile(at("web-dist", "assets", "app.js"), "utf8")).toContain("export");
	});

	it("报出来的 sha256 / size 就是文件本身的 —— 清单直接拿去用", async () => {
		const { serverDist, webDist } = await seedDists();
		const outFile = join(root, "payload.zip");

		const built = await buildUpdatePayload({ serverDist, webDist, outFile });

		// 清单里的这两个值一旦和文件对不上,用户下完了才会死在校验那一步,
		// 而错误信息会指向「下载损坏」,查到天亮也不会怀疑是发版侧填错了。
		const bytes = await readFile(outFile);
		const { createHash } = await import("node:crypto");
		expect(built.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
		expect(built.size).toBe(bytes.byteLength);
	});

	it("缺入口就当场失败,不打出一个装上去起不来的包", async () => {
		const outFile = join(root, "payload.zip");

		const noServer = await seedDists({ serverEntry: false });
		await expect(
			buildUpdatePayload({ serverDist: noServer.serverDist, webDist: noServer.webDist, outFile }),
		).rejects.toThrow(/index\.mjs/);

		// 不只是入口:按路径读盘的资产漏一个也是坏包,只是要等用户点到词云 / 分词才炸。
		const noWasm = await seedDists();
		await rm(join(noWasm.serverDist, "jieba_rs_wasm_bg.wasm"));
		await expect(
			buildUpdatePayload({ serverDist: noWasm.serverDist, webDist: noWasm.webDist, outFile }),
		).rejects.toThrow(/jieba_rs_wasm_bg\.wasm/);

		const noWeb = await seedDists({ webEntry: false });
		await expect(
			buildUpdatePayload({ serverDist: noWeb.serverDist, webDist: noWeb.webDist, outFile }),
		).rejects.toThrow(/index\.html/);
	});

	it("包里没有绝对路径,也没有 .. —— 别自己打一个 zip-slip 出来", async () => {
		const { serverDist, webDist } = await seedDists();
		const outFile = join(root, "payload.zip");

		const built = await buildUpdatePayload({ serverDist, webDist, outFile });

		// 客户端会整包拒绝这种条目(install-payload 的 zip-slip 门)。发版侧打出这种包
		// = 全世界都升不上去,而且门禁全绿 —— 所以两边各站一道。
		for (const name of built.entries) {
			expect(name.startsWith("/"), `${name} must be relative`).toBe(false);
			expect(name.includes(".."), `${name} must not escape`).toBe(false);
			expect(name.includes("\\"), `${name} must use posix separators`).toBe(false);
		}
		expect(built.entries).toContain("index.mjs");
		expect(built.entries).toContain("web-dist/index.html");
	});
});
