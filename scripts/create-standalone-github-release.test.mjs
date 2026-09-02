import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { repoRoot } from "./desktop-release-gates.mjs";

/**
 * `.github/scripts/create-standalone-github-release.sh` 被 desktop-release 与 update-payload
 * **两条** workflow 调用,谁先到谁建 —— 所以它必须幂等,连「两边同时 create、一边报已存在」
 * 也得算成功。这里用一个假 `gh`(和假 `git`)把这几种时序在本地跑一遍。
 */

const script = join(repoRoot, ".github/scripts/create-standalone-github-release.sh");
const temps = [];
afterEach(() => {
	for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

const FAKE_GH = `#!/usr/bin/env bash
echo "$*" >> "$GH_LOG"
case "$1 $2" in
	"release view")
		case "$GH_SCENARIO" in
			exists) exit 0 ;;
			created-by-us|race) [ -f "$GH_STATE/created" ] && exit 0 || exit 1 ;;
			broken) exit 1 ;;
		esac ;;
	"release create")
		case "$GH_SCENARIO" in
			created-by-us) touch "$GH_STATE/created"; exit 0 ;;
			race) touch "$GH_STATE/created"; echo "release already exists" >&2; exit 1 ;;
			broken) echo "boom" >&2; exit 1 ;;
		esac ;;
esac
exit 0
`;

const FAKE_GIT = `#!/usr/bin/env bash
case "$1" in
	fetch) exit 0 ;;
	tag) printf 'v0.9.0\\nv0.8.0\\n' ;;
esac
exit 0
`;

function run({ scenario, version = "0.9.0", prerelease = "false" }) {
	const dir = mkdtempSync(join(tmpdir(), "bn-release-"));
	temps.push(dir);
	const bin = join(dir, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "gh"), FAKE_GH);
	writeFileSync(join(bin, "git"), FAKE_GIT);
	chmodSync(join(bin, "gh"), 0o755);
	chmodSync(join(bin, "git"), 0o755);
	const log = join(dir, "gh.log");
	writeFileSync(log, "");
	const result = spawnSync("bash", [script], {
		cwd: dir,
		encoding: "utf8",
		env: {
			PATH: `${bin}:${process.env.PATH}`,
			HOME: dir,
			GH_LOG: log,
			GH_STATE: dir,
			GH_SCENARIO: scenario,
			VERSION: version,
			PRERELEASE: prerelease,
			GH_TOKEN: "x",
			REPO: "o/r",
		},
	});
	return { ...result, calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean) };
}

describe("create-standalone-github-release.sh", () => {
	it("release 不存在 → 建,预发布版本带 --prerelease --latest=false", () => {
		const r = run({ scenario: "created-by-us", version: "0.9.0-alpha.1", prerelease: "true" });
		expect(r.status, r.stderr).toBe(0);
		const create = r.calls.find((c) => c.startsWith("release create v0.9.0-alpha.1"));
		expect(create).toContain("--prerelease");
		expect(create).toContain("--latest=false");
	});

	it("正式版建出来是 --latest", () => {
		const r = run({ scenario: "created-by-us" });
		expect(r.status, r.stderr).toBe(0);
		const create = r.calls.find((c) => c.startsWith("release create v0.9.0"));
		expect(create).toContain("--latest");
		expect(create).not.toContain("--prerelease");
	});

	it("已经存在 → 一次 create 都不发,退 0", () => {
		const r = run({ scenario: "exists" });
		expect(r.status, r.stderr).toBe(0);
		expect(r.calls.some((c) => c.startsWith("release create"))).toBe(false);
	});

	// 这条是脚本改成两条 workflow 共用的理由:两边同时走到 create,输的那个不能红。
	it("create 报已存在、再 view 一次在了 → 算成功", () => {
		const r = run({ scenario: "race" });
		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toContain("created concurrently");
	});

	it("create 失败且 release 真的不在 → 红", () => {
		const r = run({ scenario: "broken" });
		expect(r.status).toBe(1);
		expect(r.stdout).toContain("::error::");
	});

	it("版本号与 PRERELEASE 标记打架 → 红,不建", () => {
		const r = run({ scenario: "created-by-us", version: "0.9.0-alpha.1", prerelease: "false" });
		expect(r.status).toBe(1);
		expect(r.calls.some((c) => c.startsWith("release create"))).toBe(false);
	});
});
