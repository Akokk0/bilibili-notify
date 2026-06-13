import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const scriptPath = join(repoRoot, "scripts", "build-astrbot-page.mjs");

describe("build-astrbot-page", () => {
	it("builds the dashboard page with crossorigin stripped for the sandboxed iframe", async () => {
		// build 到临时目录而非真实 checkin 产物路径：既避免污染工作树，又防止 emptyOutDir
		// 清空真实目录时与并行的 sync-astrbot-core 测试撞车。
		const outDir = await mkdtemp(join(tmpdir(), "bn-astrbot-page-"));
		try {
			await execFileAsync(process.execPath, [scriptPath], {
				cwd: repoRoot,
				env: { ...process.env, NODE_ENV: "production", BN_ASTRBOT_PAGE_OUT_DIR: outDir },
				timeout: 120_000,
			});

			const html = await readFile(join(outDir, "index.html"), "utf8");
			// 稳定资源名(无 content-hash):page vite.config 用 [name].js 因为产物 checked-in,
			// 见 astrbot/page/vite.config.ts。此前断言 "./assets/index-"(带 hash)在 P2 改稳定名后失效。
			expect(html).toContain("./assets/index.js");
			expect(html).toContain("Bilibili Notify · AstrBot");
			expect(html).not.toContain("crossorigin");
		} finally {
			await rm(outDir, { recursive: true, force: true });
		}
	});
});
