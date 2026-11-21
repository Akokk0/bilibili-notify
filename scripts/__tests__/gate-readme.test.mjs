import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vite-plus/test";

afterEach(() => vi.unstubAllGlobals());
it("只为已通过门禁的直接父提交复用根 README 单文件改动的类型检查", async () => {
	const dir = mkdtempSync(join(tmpdir(), "bn-gate-readme-"));
	const git = (...args) =>
		execFileSync(
			"git",
			[
				"-c",
				"user.name=test",
				"-c",
				"user.email=test@example.com",
				"-c",
				"commit.gpgsign=false",
				"-c",
				"core.hooksPath=/dev/null",
				...args,
			],
			{ cwd: dir, encoding: "utf8" },
		).trim();
	const commit = () => {
		git("add", "-A");
		git("commit", "-qm", "fixture");
		return git("rev-parse", "HEAD");
	};
	try {
		git("init", "-q");
		writeFileSync(join(dir, "README.md"), "before");
		writeFileSync(join(dir, "app.ts"), "export {};");
		const base = commit();
		writeFileSync(join(dir, "README.md"), "after");
		const head = commit();
		let green = true;
		const queries = [];
		vi.stubGlobal("fetch", async (url) => {
			const u = new URL(url);
			if (u.pathname.endsWith("/actions/runs")) {
				const sha = u.searchParams.get("head_sha");
				queries.push(sha);
				return Response.json({
					workflow_runs:
						sha === base && green
							? [
									{
										repository: { full_name: "owner/bn" },
										head_repository: { full_name: "owner/bn" },
										head_sha: base,
										run_attempt: 1,
										id: 17,
										path: ".github/workflows/ci.yml",
										head_branch: "dev",
										event: "push",
									},
								]
							: [],
				});
			}
			return Response.json({
				jobs: [
					{
						name: "gate / gate",
						status: "completed",
						conclusion: "success",
						steps: [{ name: "Require every test shard", conclusion: "success" }],
					},
				],
			});
		});
		const { findGateCoverage } = await import("../find-passed-gate.mjs");
		const cover = (sha, parent) =>
			findGateCoverage(
				{
					repository: "owner/bn",
					sha,
					apiUrl: "https://actions.test",
					token: "test",
					currentRunId: "19",
				},
				parent,
				dir,
			);
		expect((await cover(head, base)).typesFrom).toBe(17);
		expect(queries.splice(0)).toEqual([head, base]);
		green = false;
		expect((await cover(head, base)).typesFrom).toBeUndefined();
		green = true;
		expect((await cover(head, "0".repeat(40))).typesFrom).toBeUndefined();
		expect((await cover(head, undefined)).typesFrom).toBeUndefined();
		writeFileSync(join(dir, "app.ts"), "bad change");
		writeFileSync(join(dir, "README.md"), "also changed");
		const code = commit();
		expect((await cover(code, head)).typesFrom).toBeUndefined();
		expect((await cover(code, base)).typesFrom).toBeUndefined();
		unlinkSync(join(dir, "README.md"));
		symlinkSync("app.ts", join(dir, "README.md"));
		expect((await cover(commit(), code)).typesFrom).toBeUndefined();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
