import { execFile, spawn } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vite-plus/test";

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const scriptPath = join(repoRoot, "scripts", "build-astrbot-sidecar.mjs");
const sourcePath = join(repoRoot, "astrbot", "sidecar", "dist", "index.mjs");
const targetDir = join(repoRoot, "astrbot", "core", "sidecar", "app");
const targetPath = join(targetDir, "index.mjs");
const nodeBuiltins = new Set([
	...builtinModules,
	...builtinModules.map((moduleName) => `node:${moduleName}`),
]);

describe("build-astrbot-sidecar", () => {
	it("copies the built sidecar bundle into the plugin mirror", async () => {
		await execFileAsync(process.execPath, [scriptPath], {
			cwd: repoRoot,
			env: { ...process.env },
			timeout: 120_000,
		});

		expect(await readFile(targetPath, "utf8")).toBe(await readFile(sourcePath, "utf8"));
	});

	it("keeps the copied bundle self-contained for installs outside the monorepo", async () => {
		await execFileAsync(process.execPath, [scriptPath], {
			cwd: repoRoot,
			env: { ...process.env },
			timeout: 120_000,
		});

		const bareImports = [];
		for (const fileName of await readdir(targetDir)) {
			if (!fileName.endsWith(".mjs")) continue;
			const source = await readFile(join(targetDir, fileName), "utf8");
			bareImports.push(
				...collectBareRuntimeImports(source).map((specifier) => `${fileName}: ${specifier}`),
			);
		}

		expect(bareImports).toEqual([]);
		expect(await readFile(join(targetDir, "xhr-sync-worker.js"), "utf8")).toContain(
			"XMLHttpRequest",
		);
		expect((await readFile(join(targetDir, "jieba_rs_wasm_bg.wasm"))).byteLength).toBeGreaterThan(
			0,
		);
		// 词云模板在运行时 readFileSync(resolve(__dirname, "static/*.js"))。bundle 内联了
		// @bilibili-notify/image 后 __dirname 指向 app/,这两个静态脚本必须随 bundle 一起搬运。
		expect(await readFile(join(targetDir, "static", "wordcloud2.min.js"), "utf8")).toContain(
			"WordCloud",
		);
		expect(await readFile(join(targetDir, "static", "render.js"), "utf8")).toContain(
			"词云渲染函数",
		);
	});

	it("starts from a copied bundle outside the monorepo", async () => {
		await execFileAsync(process.execPath, [scriptPath], {
			cwd: repoRoot,
			env: { ...process.env },
			timeout: 120_000,
		});

		const tempRoot = await mkdtemp(join(tmpdir(), "bn-sidecar-build-"));
		const appDir = join(tempRoot, "app");
		const readyFile = join(tempRoot, "ready.json");
		const dataDir = join(tempRoot, "data");
		await cp(targetDir, appDir, { recursive: true });
		const child = spawn(
			process.execPath,
			[
				join(appDir, "index.mjs"),
				"--port",
				"0",
				"--ready-file",
				readyFile,
				"--data-dir",
				dataDir,
				"--log-level",
				"error",
				"--version",
				"test-build",
			],
			{ cwd: tempRoot, stdio: ["ignore", "pipe", "pipe"] },
		);
		const output = [];
		child.stdout?.on("data", (chunk) => output.push(String(chunk)));
		child.stderr?.on("data", (chunk) => output.push(String(chunk)));
		try {
			const snapshot = await waitForReadySnapshot(readyFile, child, output);
			const healthResponse = await fetch(`${snapshot.url}/api/health`);
			expect(healthResponse.status).toBe(200);
			expect(await healthResponse.json()).toMatchObject({
				status: "ready",
				version: "test-build",
			});
		} finally {
			child.kill("SIGTERM");
			await waitForExit(child);
			await rm(tempRoot, { recursive: true, force: true });
		}
	}, 30_000);
});

async function waitForReadySnapshot(readyFile, child, output) {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new Error(`sidecar exited early (${child.exitCode}): ${output.join("")}`);
		}
		try {
			return JSON.parse(await readFile(readyFile, "utf8"));
		} catch (error) {
			if (!isMissingFile(error)) throw error;
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
	}
	throw new Error(`timed out waiting for ready file: ${output.join("")}`);
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

function isMissingFile(error) {
	return error && typeof error === "object" && "code" in error && error.code === "ENOENT";
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
