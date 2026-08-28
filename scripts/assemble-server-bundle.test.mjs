import { execFile, spawn } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vite-plus/test";

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const assembleScript = join(repoRoot, "scripts", "assemble-server-bundle.mjs");
const distDir = join(repoRoot, "apps", "server", "dist");
const nodeBuiltins = new Set([
	...builtinModules,
	...builtinModules.map((moduleName) => `node:${moduleName}`),
]);

// 构建 + 装配一次,三个用例共享产物(build:bundle 带 clean,重复跑互相擦除)。
beforeAll(async () => {
	await execFileAsync("vp", ["run", "-F", "@bilibili-notify/server", "build:bundle"], {
		cwd: repoRoot,
		env: { ...process.env },
		timeout: 180_000,
	});
	await execFileAsync(process.execPath, [assembleScript], {
		cwd: repoRoot,
		env: { ...process.env },
		timeout: 60_000,
	});
}, 240_000);

describe("assemble-server-bundle", () => {
	it("bundle 自包含:产物内无 bare 第三方 import(node 内建除外)", async () => {
		const bareImports = [];
		for (const fileName of await readdir(distDir)) {
			if (!fileName.endsWith(".mjs")) continue;
			const source = await readFile(join(distDir, fileName), "utf8");
			bareImports.push(
				...collectBareRuntimeImports(source).map((specifier) => `${fileName}: ${specifier}`),
			);
		}
		expect(bareImports).toEqual([]);
	});

	it("运行时资产齐全:wasm / xhr worker / 词云 static / 配置样例 / package.json", async () => {
		expect(await readFile(join(distDir, "xhr-sync-worker.js"), "utf8")).toContain("XMLHttpRequest");
		// jsdom 30 模块加载即读默认样式表,patch 的 fallback 指向 bundle 旁这份拷贝。
		expect(await readFile(join(distDir, "default-stylesheet.css"), "utf8")).toContain("display");
		expect((await readFile(join(distDir, "jieba_rs_wasm_bg.wasm"))).byteLength).toBeGreaterThan(0);
		// 词云模板运行时 readFileSync(resolve(__dirname, "static/*.js"));bundle 内联
		// @bilibili-notify/image 后 __dirname 指向 dist/,static 必须随 bundle 搬运。
		expect(await readFile(join(distDir, "static", "wordcloud2.min.js"), "utf8")).toContain(
			"WordCloud",
		);
		expect(await readFile(join(distDir, "static", "render.js"), "utf8")).toContain("词云渲染函数");
		expect(await readFile(join(distDir, "bn.config.example.yaml"), "utf8")).toContain("server");
		const pkg = JSON.parse(await readFile(join(distDir, "package.json"), "utf8"));
		expect(pkg.name).toBe("@bilibili-notify/server");
	});

	it("装到 monorepo 外也能起:boot + /api/health 200 + 模块版本非 0.0.0", async () => {
		// 故意不 realpath:macOS tmpdir 是 /var → /private/var 的 symlink,正好在真实
		// boot 里回归验证 isEntrypoint 的 realpath 对齐(runtime/entrypoint.ts)——
		// 修复前 argv[1](symlink)与 import.meta.url(realpath)不等,静默退出 0。
		const tempRoot = await mkdtemp(join(tmpdir(), "bn-server-bundle-"));
		const appDir = join(tempRoot, "app");
		await cp(distDir, appDir, { recursive: true });
		const port = 18900 + (process.pid % 500);
		const child = spawn(process.execPath, [join(appDir, "index.mjs")], {
			cwd: appDir,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				BN_DATA_DIR: join(tempRoot, "data"),
				BN_CONFIG: join(tempRoot, "bn.config.yaml"),
				BN_HOST: "127.0.0.1",
				BN_PORT: String(port),
				BN_CHROME_PATH: join(tempRoot, "no-chrome"),
				BN_WEB_DIST: join(tempRoot, "no-web-dist"),
			},
		});
		const output = [];
		child.stdout?.on("data", (chunk) => output.push(String(chunk)));
		child.stderr?.on("data", (chunk) => output.push(String(chunk)));
		try {
			const body = await waitForHealth(`http://127.0.0.1:${port}/api/health`, child, output);
			expect(body.status).toBe("ok");
			// 刻画测试的 bundle 侧闭环:静态 JSON import 内联的版本在 bundle 里也要在,
			// 不允许 createRequire 落空导致的 0.0.0 降级(health.ts 机制切换的动机)。
			expect(body.moduleVersions.api).not.toBe("0.0.0");
			expect(body.moduleVersions.live).not.toBe("0.0.0");
		} finally {
			child.kill("SIGTERM");
			await waitForExit(child);
			await rm(tempRoot, { recursive: true, force: true });
		}
	}, 30_000);
});

async function waitForHealth(url, child, output) {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new Error(`server exited early (${child.exitCode}): ${output.join("")}`);
		}
		try {
			const response = await fetch(url);
			if (response.status === 200) return await response.json();
		} catch {
			// 端口未就绪,继续轮询。
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
	}
	throw new Error(`timed out waiting for health: ${output.join("")}`);
}

async function waitForExit(child) {
	if (child.exitCode !== null) return;
	await new Promise((resolvePromise) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			resolvePromise(undefined);
		}, 5_000);
		child.on("exit", () => {
			clearTimeout(timeout);
			resolvePromise(undefined);
		});
	});
}

function collectBareRuntimeImports(source) {
	const specifiers = [];
	for (const line of source.split("\n")) {
		if (!line.startsWith("import ") && !line.startsWith("export ")) continue;
		for (const match of line.matchAll(
			/\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/g,
		)) {
			const specifier = match[1] ?? match[2];
			if (specifier && isBareRuntimeImport(specifier)) {
				specifiers.push(specifier);
			}
		}
	}
	return specifiers;
}

function isBareRuntimeImport(specifier) {
	if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("file:")) {
		return false;
	}
	return !nodeBuiltins.has(specifier);
}
