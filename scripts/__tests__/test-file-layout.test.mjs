import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

/**
 * 守卫 7 前半:测试文件只放 `__tests__/`,全仓没有例外(`scripts/` 也一样)。
 *
 * 按 vitest 默认的认法判「是不是测试文件」(`*.test.*` / `*.spec.*`);夹具起别的名字
 * (如 `*.fixture.mjs`)就不算。扫的是 git 认得的文件,已跟踪的加上还没 add、也没被忽略的,
 * 新写的测试放错地方,不用等提交就红;只认磁盘上还在的 —— 挪走了还没暂存的旧路径不算。
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

function misplacedTests(paths) {
	return paths.filter((p) => TEST_FILE.test(p) && !p.split("/").includes("__tests__"));
}

describe("测试文件只放 __tests__/", () => {
	it("认法:测试文件放在 __tests__ 外就点名,夹具与普通文件不算", () => {
		expect(
			misplacedTests([
				"packages/a/src/x.test.ts",
				"apps/web/src/pages/Card.render.test.tsx",
				"scripts/y.test.mjs",
				"packages/a/src/z.spec.ts",
				"packages/a/src/__tests__/x.test.ts",
				"scripts/__tests__/fixtures/g/swallowed.fixture.mjs",
				"packages/a/src/test-utils.ts",
			]),
		).toEqual([
			"packages/a/src/x.test.ts",
			"apps/web/src/pages/Card.render.test.tsx",
			"scripts/y.test.mjs",
			"packages/a/src/z.spec.ts",
		]);
	});

	it("全仓的测试文件都在 __tests__/ 里", () => {
		const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
			cwd: REPO_ROOT,
			encoding: "utf8",
		})
			.split("\n")
			.filter((p) => p && existsSync(join(REPO_ROOT, p)));
		expect(misplacedTests(files)).toEqual([]);
	});
});
