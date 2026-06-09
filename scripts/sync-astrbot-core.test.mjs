import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const scriptPath = join(repoRoot, "scripts", "sync-astrbot-core.mjs");
const sourceRoot = join(repoRoot, "astrbot", "core");

async function exists(path) {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

describe("sync-astrbot-core", () => {
	it("replaces stale files, copies built pages, and skips runtime caches", async () => {
		const tempRoot = await mkdtemp(join(tmpdir(), "bn-sync-"));
		const target = join(tempRoot, "astrbot_plugin_bilibili_notify");
		const sourceCacheFiles = [
			join(sourceRoot, "sidecar", "cache", "phase9-skip.txt"),
			join(sourceRoot, "sidecar", "logs", "phase9-skip.log"),
			join(sourceRoot, "sidecar", "state", "phase9-skip.json"),
			join(sourceRoot, ".pytest_cache", "phase9-skip.txt"),
			join(sourceRoot, ".ruff_cache", "phase9-skip.txt"),
			join(sourceRoot, ".venv", "phase9-skip.txt"),
			join(sourceRoot, "__pycache__", "phase9-skip.pyc"),
		];
		const createdDirs = [];
		await mkdir(target, { recursive: true });
		// Marker so the safety guard recognises this as an existing plugin install.
		await writeFile(
			join(target, "metadata.yaml"),
			"name: astrbot_plugin_bilibili_notify\n",
			"utf8",
		);
		await writeFile(join(target, "stale.txt"), "stale\n", "utf8");
		await mkdir(join(target, "sidecar", "state"), { recursive: true });
		// Runtime state of a running instance — must survive the re-sync.
		await writeFile(join(target, "sidecar", "state", "cookies.json"), "{}\n", "utf8");
		// Stale non-runtime sidecar child — must be removed.
		await mkdir(join(target, "sidecar", "stale-dir"), { recursive: true });
		await writeFile(join(target, "sidecar", "stale-dir", "old.txt"), "old\n", "utf8");

		try {
			for (const file of sourceCacheFiles) {
				const dir = dirname(file);
				if (!(await exists(dir))) createdDirs.push(dir);
				await mkdir(dir, { recursive: true });
				await writeFile(file, "skip\n", "utf8");
			}

			await execFileAsync(process.execPath, [scriptPath, "--target", target], {
				cwd: repoRoot,
				env: { ...process.env },
				timeout: 30_000,
			});
		} finally {
			await Promise.all(sourceCacheFiles.map((file) => rm(file, { force: true })));
			await Promise.all(
				[...createdDirs].reverse().map((dir) => rm(dir, { recursive: true, force: true })),
			);
		}

		expect(await exists(join(target, "main.py"))).toBe(true);
		expect(await exists(join(target, ".gitignore"))).toBe(true);
		expect(await exists(join(target, "sidecar", ".gitignore"))).toBe(true);
		expect(await exists(join(target, "pages", "dashboard", "index.html"))).toBe(true);
		expect(await exists(join(target, "stale.txt"))).toBe(false);
		// Runtime state preserved across the re-sync.
		expect(await exists(join(target, "sidecar", "state", "cookies.json"))).toBe(true);
		// Stale non-runtime sidecar child removed.
		expect(await exists(join(target, "sidecar", "stale-dir"))).toBe(false);
		// Source side excludes these caches, so they never appear in the target.
		expect(await exists(join(target, "sidecar", "cache"))).toBe(false);
		expect(await exists(join(target, "sidecar", "logs"))).toBe(false);
		expect(await exists(join(target, ".pytest_cache"))).toBe(false);
		expect(await exists(join(target, ".ruff_cache"))).toBe(false);
		expect(await exists(join(target, ".venv"))).toBe(false);
		expect(await exists(join(target, "__pycache__"))).toBe(false);
	});

	it("refuses to delete a non-empty target that is not a bilibili-notify plugin", async () => {
		const tempRoot = await mkdtemp(join(tmpdir(), "bn-sync-"));
		const target = join(tempRoot, "not-a-plugin");
		await mkdir(target, { recursive: true });
		await writeFile(join(target, "important.txt"), "do not delete\n", "utf8");
		await mkdir(join(target, "docs"), { recursive: true });
		await writeFile(join(target, "docs", "keep.md"), "keep me\n", "utf8");

		await expect(
			execFileAsync(process.execPath, [scriptPath, "--target", target], {
				cwd: repoRoot,
				env: { ...process.env },
				timeout: 30_000,
			}),
		).rejects.toThrow(/拒绝删除|非空且不是/);

		// Nothing was touched.
		expect(await exists(join(target, "important.txt"))).toBe(true);
		expect(await exists(join(target, "docs", "keep.md"))).toBe(true);
		expect(await exists(join(target, "main.py"))).toBe(false);
	});

	it("performs a fresh install into a missing target directory", async () => {
		const tempRoot = await mkdtemp(join(tmpdir(), "bn-sync-"));
		const target = join(tempRoot, "nested", "astrbot_plugin_bilibili_notify");

		await execFileAsync(process.execPath, [scriptPath, "--target", target], {
			cwd: repoRoot,
			env: { ...process.env },
			timeout: 30_000,
		});

		expect(await exists(join(target, "main.py"))).toBe(true);
		expect(await exists(join(target, "metadata.yaml"))).toBe(true);
	});

	it("performs a fresh install into an empty target directory", async () => {
		const tempRoot = await mkdtemp(join(tmpdir(), "bn-sync-"));
		const target = join(tempRoot, "astrbot_plugin_bilibili_notify");
		await mkdir(target, { recursive: true });

		await execFileAsync(process.execPath, [scriptPath, "--target", target], {
			cwd: repoRoot,
			env: { ...process.env },
			timeout: 30_000,
		});

		expect(await exists(join(target, "main.py"))).toBe(true);
	});
});
