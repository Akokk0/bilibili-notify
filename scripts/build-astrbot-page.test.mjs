import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const scriptPath = join(repoRoot, "scripts", "build-astrbot-page.mjs");
const targetPath = join(repoRoot, "astrbot", "core", "pages", "dashboard", "index.html");

describe("build-astrbot-page", () => {
	it("builds the dashboard page into the AstrBot plugin page directory", async () => {
		await execFileAsync(process.execPath, [scriptPath], {
			cwd: repoRoot,
			env: { ...process.env, NODE_ENV: "production" },
			timeout: 120_000,
		});

		const html = await readFile(targetPath, "utf8");
		expect(html).toContain("./assets/index-");
		expect(html).toContain("Bilibili Notify · AstrBot");
	});
});
