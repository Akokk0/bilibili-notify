import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vite-plus/test";

const scripts = fileURLToPath(new URL("../../.github/scripts/shared/", import.meta.url));
const env = { ...process.env, VERSION: "", GITHUB_REF_NAME: "", GITHUB_OUTPUT: "" };

it("手动给的版本优先，空的 VERSION 从 tag 读，两种输出位置都保留来源", () => {
	const script = join(scripts, "read-app-version.sh");
	const tagged = { ...env, GITHUB_REF_NAME: "v1.2.3-alpha.4" };
	const manual = execFileSync("bash", [script], {
		env: { ...tagged, VERSION: "v2.0.0" },
		encoding: "utf8",
	});
	expect(manual).toBe("value=2.0.0\nprerelease=false\nsource=VERSION\n");

	const dir = mkdtempSync(join(tmpdir(), "bn-app-version-"));
	try {
		const output = join(dir, "output");
		writeFileSync(output, "previous=value\n");
		expect(
			execFileSync("bash", [script], { env: { ...tagged, GITHUB_OUTPUT: output } }).length,
		).toBe(0);
		expect(readFileSync(output, "utf8")).toBe(
			"previous=value\nvalue=1.2.3-alpha.4\nprerelease=true\nsource=GITHUB_REF_NAME\n",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it.each(["read-app-version.sh", "sync-app-version.sh"])("%s 对缺失和无效的版本给出诊断", (name) => {
	for (const [version, ref, message] of [
		["", "dev", "app version is required"],
		["1.2.3+build", "v1.2.3", "not valid / Docker-tag-compatible SemVer"],
	]) {
		const result = spawnSync("bash", [join(scripts, name)], {
			cwd: tmpdir(),
			env: { ...env, VERSION: version, GITHUB_REF_NAME: ref },
			encoding: "utf8",
		});
		expect(result.status).toBe(1);
		expect(result.stdout).toContain(message);
	}
});
