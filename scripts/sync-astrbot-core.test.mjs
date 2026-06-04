import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const scriptPath = join(repoRoot, "scripts", "sync-astrbot-core.mjs");

async function exists(path) {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

describe("sync-astrbot-core", () => {
	it("replaces stale files and copies plugin ignores", async () => {
		const tempRoot = await mkdtemp(join(tmpdir(), "bn-sync-"));
		const target = join(tempRoot, "astrbot_plugin_bilibili_notify");
		await mkdir(target, { recursive: true });
		await writeFile(join(target, "stale.txt"), "stale\n", "utf8");
		await mkdir(join(target, "sidecar", "state"), { recursive: true });
		await writeFile(join(target, "sidecar", "state", "stale.json"), "{}\n", "utf8");

		await execFileAsync(process.execPath, [scriptPath, "--target", target], {
			cwd: repoRoot,
			env: { ...process.env },
			timeout: 30_000,
		});

		expect(await exists(join(target, "main.py"))).toBe(true);
		expect(await exists(join(target, ".gitignore"))).toBe(true);
		expect(await exists(join(target, "sidecar", ".gitignore"))).toBe(true);
		expect(await exists(join(target, "stale.txt"))).toBe(false);
		expect(await exists(join(target, "sidecar", "state", "stale.json"))).toBe(false);
	});
});
