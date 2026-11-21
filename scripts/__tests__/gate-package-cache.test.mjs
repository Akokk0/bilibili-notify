import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vite-plus/test";
import { BaseSequencer } from "vite-plus/test/node";
import { PackageTestSequencer } from "../package-test-sequencer.mjs";

it("分片内最先调度拓展项目发行测试，其余文件保持 Vitest 的顺序", async () => {
	const root = fileURLToPath(new URL("../../", import.meta.url));
	const project = { config: { sequence: { groupOrder: 0 } } };
	const [release, ordinary, sameName] = [
		"scripts/__tests__/extension-project-release.test.mjs",
		"scripts/__tests__/app-version.test.mjs",
		"other/extension-project-release.test.mjs",
	].map((path) => ({ moduleId: join(root, path), project }));
	const files = [ordinary, release, sameName];
	const durations = new Map([
		[release, 1],
		[ordinary, 2],
		[sameName, 3],
	]);
	const cache = { getTestSpecificationResult: (spec) => ({ duration: durations.get(spec) }) };
	const sharded = new PackageTestSequencer({
		config: { root, shard: { index: 1, count: 4 } },
		cache,
	});
	expect(await sharded.sort(files)).toEqual([release, sameName, ordinary]);
	expect(await sharded.sort([ordinary, sameName])).toEqual([sameName, ordinary]);
	expect(await new PackageTestSequencer({ config: { root }, cache }).sort(files)).toEqual([
		sameName,
		ordinary,
		release,
	]);
});

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
		vi.stubEnv("BN_PACKAGE_TEST_CACHE_SCRIPT", undefined);
		const local = { config: { root, shard: { index: 1, count: 1 } } };
		expect(await new PackageTestSequencer(local).shard(files)).toEqual(
			await new BaseSequencer(local).shard(files),
		);
		expect(readFileSync(calls, "utf8")).toBe("warm\n".repeat(warmed));
	} finally {
		vi.unstubAllEnvs();
		rmSync(dir, { recursive: true, force: true });
	}
});
