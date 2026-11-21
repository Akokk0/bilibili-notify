import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vite-plus/test";

it("全量门禁按已验证的基线和工作区选择桌面检查，迁移计时一直跳过", () => {
	const script = fileURLToPath(new URL("../../.claude/gate.sh", import.meta.url));
	const dir = mkdtempSync(join(tmpdir(), "bn-local-full-gate-"));
	const log = join(dir, "calls");
	const git = (...args) =>
		execFileSync(
			"git",
			[
				"-c",
				"user.name=test",
				"-c",
				"user.email=test@example.com",
				"-c",
				"core.hooksPath=/dev/null",
				"-c",
				"commit.gpgsign=false",
				...args,
			],
			{ cwd: dir, encoding: "utf8" },
		).trim();
	const commit = () => {
		git("add", "README.md", "apps");
		git("commit", "-qm", "fixture");
		return git("rev-parse", "HEAD");
	};
	const run = (args, fail = false) => {
		writeFileSync(log, "");
		const r = spawnSync("bash", [script, "--full", ...args], {
			cwd: dir,
			encoding: "utf8",
			env: {
				...process.env,
				PATH: dir + delimiter + process.env.PATH,
				CALLS: log,
				FAIL: fail ? "1" : "",
				BN_MIGRATION_TIMING: "1",
				BN_DESKTOP_LIFECYCLE: "1",
				GATE_SLICE_TESTS: join(dir, "unused-slice"),
			},
		});
		expect(r.status, r.stdout + r.stderr).toBe(fail ? 1 : 0);
		return readFileSync(log, "utf8").trim().split("\n");
	};
	try {
		git("init", "-q");
		mkdirSync(join(dir, "apps/desktop"), { recursive: true });
		writeFileSync(join(dir, "README.md"), "base");
		writeFileSync(join(dir, "apps/desktop/launcher.rs"), "base");
		const base = commit();
		writeFileSync(
			join(dir, "vp"),
			'#!/usr/bin/env bash\necho "$*|migration=$BN_MIGRATION_TIMING|desktop=$BN_DESKTOP_LIFECYCLE" >> "$CALLS"\n[[ "$*" != "run test" || -z "$FAIL" ]]\n',
		);
		chmodSync(join(dir, "vp"), 0o755);
		writeFileSync(join(dir, "README.md"), "web only");
		commit();
		const web = run(["--base", base]);
		expect(web).toContain("run test|migration=|desktop=");
		expect(web).toContain("run test:panel-locale|migration=|desktop=");
		expect(web.join("\n")).not.toContain("run check:desktop");
		expect(run([])).toEqual(web);
		writeFileSync(join(dir, "apps/desktop/new.rs"), "untracked");
		expect(run([]).some((line) => line.startsWith("run check:desktop|"))).toBe(true);
		commit();
		writeFileSync(join(dir, "README.md"), "later web change");
		commit();
		const native = run([], true);
		expect(native).toContain(
			`run test|migration=|desktop=${process.platform === "darwin" ? "1" : ""}`,
		);
		expect(run([]).some((line) => line.startsWith("run check:desktop|"))).toBe(true);
		expect(run([])).toEqual(web);
		expect(
			run(["--base", "unavailable"]).some((line) => line.startsWith("run check:desktop|")),
		).toBe(true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 20_000);
