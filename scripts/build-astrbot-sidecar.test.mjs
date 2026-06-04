import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const scriptPath = join(repoRoot, "scripts", "build-astrbot-sidecar.mjs");
const sourcePath = join(repoRoot, "astrbot", "sidecar", "dist", "index.mjs");
const targetPath = join(repoRoot, "astrbot", "core", "sidecar", "app", "index.mjs");

describe("build-astrbot-sidecar", () => {
	it("copies the built sidecar bundle into the plugin mirror", async () => {
		await execFileAsync(process.execPath, [scriptPath], {
			cwd: repoRoot,
			env: { ...process.env },
			timeout: 120_000,
		});

		expect(await readFile(targetPath, "utf8")).toBe(await readFile(sourcePath, "utf8"));
	});
});
