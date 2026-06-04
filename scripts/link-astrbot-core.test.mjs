import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readlink, symlink } from "node:fs/promises";
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

describe("link-astrbot-core", () => {
	it("replaces a broken symlink when forced", async () => {
		const tempRoot = await mkdtemp(join(tmpdir(), "bn-link-"));
		const astrbotRoot = join(tempRoot, "AstrBot");
		const target = join(astrbotRoot, "data", "plugins", "astrbot_plugin_bilibili_notify");
		await mkdir(dirname(target), { recursive: true });
		await symlink(join(tempRoot, "missing-source"), target, "dir");

		await execFileAsync(process.execPath, [scriptPath, "--astrbot-root", astrbotRoot, "--force"], {
			cwd: repoRoot,
			env: { ...process.env },
			timeout: 30_000,
		});

		const stats = await lstat(target);
		expect(stats.isSymbolicLink()).toBe(true);
		expect(await readlink(target)).toBe(pluginSource);
	});
});
