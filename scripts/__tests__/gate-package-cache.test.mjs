import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vite-plus/test";
import { BaseSequencer } from "vite-plus/test/node";

it("只为实际分到仓外离线安装用例的分片预热一次，其余文件仍按原分片运行", async () => {
	const root = fileURLToPath(new URL("../../", import.meta.url));
	const files = [
		"extension-project-release",
		"extension-sdk-package",
		"issue-needs-info",
		"app-version",
		"test-tmpdir",
		"verify-ui-dev",
	].map((name) => ({ moduleId: join(root, "scripts/__tests__", `${name}.test.mjs`) }));
	const dir = mkdtempSync(join(tmpdir(), "bn-gate-prewarm-"));
	try {
		const script = join(dir, "warm.sh");
		const calls = join(dir, "calls");
		writeFileSync(script, 'echo warm >> "$CACHE_TEST_CALLS"\n');
		writeFileSync(calls, "");
		vi.stubEnv("BN_PACKAGE_TEST_CACHE_SCRIPT", script);
		vi.stubEnv("CACHE_TEST_CALLS", calls);
		const { PackageTestSequencer } = await import("../package-test-sequencer.mjs");
		let warmed = 0;
		for (let index = 1; index <= 4; index++) {
			const ctx = { config: { root, shard: { index, count: 4 } } };
			const original = await new BaseSequencer(ctx).shard(files);
			expect(await new PackageTestSequencer(ctx).shard(files)).toEqual(original);
			if (original.some((spec) => files.slice(0, 2).includes(spec))) warmed++;
			expect(readFileSync(calls, "utf8")).toBe("warm\n".repeat(warmed));
		}
		expect(warmed).toBeGreaterThan(0);
		expect(warmed).toBeLessThan(4);
	} finally {
		vi.unstubAllEnvs();
		rmSync(dir, { recursive: true, force: true });
	}
});
