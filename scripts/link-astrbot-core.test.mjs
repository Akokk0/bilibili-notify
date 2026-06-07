import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const scriptPath = join(repoRoot, "scripts", "link-astrbot-core.mjs");
const pluginSource = join(repoRoot, "astrbot", "core");

async function exists(path) {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

async function writeFixtureFile(root, path, content = "fixture\n") {
	const target = join(root, path);
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, content, "utf8");
}

async function createFixtureSource(tempRoot) {
	const source = join(tempRoot, "plugin-source");
	await writeFixtureFile(source, "main.py", "PLUGIN_NAME = 'astrbot_plugin_bilibili_notify'\n");
	await writeFixtureFile(
		source,
		"pages/dashboard/index.html",
		"<!doctype html><title>Bilibili Notify · AstrBot</title>\n",
	);
	await writeFixtureFile(source, "sidecar/app/index.mjs", "console.log('sidecar')\n");
	await writeFixtureFile(source, "sidecar/.gitignore", "state\nlogs\ncache\n");
	await Promise.all(
		[
			".git/skip.txt",
			".pytest_cache/skip.txt",
			".ruff_cache/skip.txt",
			".venv/skip.txt",
			"__pycache__/skip.pyc",
			"sidecar/cache/skip.txt",
			"sidecar/logs/skip.log",
			"sidecar/state/skip.json",
		].map((path) => writeFixtureFile(source, path)),
	);
	return source;
}

describe("link-astrbot-core", () => {
	it("copies plugin files by default so AstrBot Plugin Pages can resolve inside the plugin store", async () => {
		const tempRoot = await mkdtemp(join(tmpdir(), "bn-link-"));
		const astrbotRoot = join(tempRoot, "AstrBot");
		const source = await createFixtureSource(tempRoot);
		const target = join(astrbotRoot, "data", "plugins", "astrbot_plugin_bilibili_notify");

		await execFileAsync(
			process.execPath,
			[scriptPath, "--astrbot-root", astrbotRoot, "--source", source],
			{
				cwd: repoRoot,
				env: { ...process.env },
				timeout: 30_000,
			},
		);

		const stats = await lstat(target);
		expect(stats.isDirectory()).toBe(true);
		expect(stats.isSymbolicLink()).toBe(false);
		expect(await readFile(join(target, "main.py"), "utf8")).toContain("PLUGIN_NAME");
		expect(await readFile(join(target, "pages", "dashboard", "index.html"), "utf8")).toContain(
			"Bilibili Notify · AstrBot",
		);
		expect(await readFile(join(target, "sidecar", "app", "index.mjs"), "utf8")).toContain(
			"sidecar",
		);
		for (const skippedPath of [
			".git",
			".pytest_cache",
			".ruff_cache",
			".venv",
			"__pycache__",
			"sidecar/cache",
			"sidecar/logs",
			"sidecar/state",
		]) {
			expect(await exists(join(target, skippedPath))).toBe(false);
		}
	});

	it("accepts the run-script -- delimiter before options", async () => {
		const tempRoot = await mkdtemp(join(tmpdir(), "bn-link-"));
		const astrbotRoot = join(tempRoot, "AstrBot");
		const source = await createFixtureSource(tempRoot);
		const target = join(astrbotRoot, "data", "plugins", "astrbot_plugin_bilibili_notify");
		await writeFixtureFile(target, "stale.txt", "old\n");

		await execFileAsync(
			process.execPath,
			[scriptPath, "--", "--astrbot-root", astrbotRoot, "--source", source, "--force"],
			{
				cwd: repoRoot,
				env: { ...process.env },
				timeout: 30_000,
			},
		);

		expect(await exists(join(target, "stale.txt"))).toBe(false);
		expect(await readFile(join(target, "main.py"), "utf8")).toContain("PLUGIN_NAME");
	});

	it("keeps symlink mode available when requested", async () => {
		const tempRoot = await mkdtemp(join(tmpdir(), "bn-link-"));
		const astrbotRoot = join(tempRoot, "AstrBot");
		const target = join(astrbotRoot, "data", "plugins", "astrbot_plugin_bilibili_notify");
		await mkdir(dirname(target), { recursive: true });
		await symlink(join(tempRoot, "missing-source"), target, "dir");

		await execFileAsync(
			process.execPath,
			[scriptPath, "--astrbot-root", astrbotRoot, "--force", "--symlink"],
			{
				cwd: repoRoot,
				env: { ...process.env },
				timeout: 30_000,
			},
		);

		const stats = await lstat(target);
		expect(stats.isSymbolicLink()).toBe(true);
		expect(await readlink(target)).toBe(pluginSource);
	});
});
