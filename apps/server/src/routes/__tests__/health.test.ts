import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import serverPkg from "../../../package.json" with { type: "json" };
import { findNearestPackageJson, MODULE_VERSIONS, resolveAppVersion } from "../health.js";

const serverPkgVersion = serverPkg.version;

describe("resolveAppVersion", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "bn-health-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function writePkg(name: string, content: string): string {
		const p = join(dir, name);
		writeFileSync(p, content);
		return p;
	}

	it("读取 package.json 的 version 字段(prerelease)", () => {
		const p = writePkg("package.json", JSON.stringify({ name: "x", version: "0.1.0-alpha.3" }));
		expect(resolveAppVersion(p)).toBe("0.1.0-alpha.3");
	});

	it("读取纯 semver 版本", () => {
		const p = writePkg("package.json", JSON.stringify({ version: "1.2.3" }));
		expect(resolveAppVersion(p)).toBe("1.2.3");
	});

	it("文件不存在时回退 dev", () => {
		expect(resolveAppVersion(join(dir, "missing.json"))).toBe("dev");
	});

	it("JSON 损坏时回退 dev", () => {
		const p = writePkg("package.json", "{ not valid json");
		expect(resolveAppVersion(p)).toBe("dev");
	});

	it("version 缺失或空串时回退 dev", () => {
		expect(resolveAppVersion(writePkg("a.json", JSON.stringify({ name: "x" })))).toBe("dev");
		expect(resolveAppVersion(writePkg("b.json", JSON.stringify({ version: "" })))).toBe("dev");
	});

	/**
	 * 版本号必须是**当前跑的这份载荷**的版本,不是进程恰好待在哪个目录。
	 *
	 * 在线升级后 cwd 仍是容器的 /app(镜像自带那份),而新载荷跑在
	 * /data/versions/<新版>/ 下 —— 照 cwd 读就会一直报旧版本号,用户升完看仪表盘
	 * 纹丝不动,只会以为升级压根没成。NapCat 那个恒显 0.0.0 就是这个形态。
	 */
	it("不传参时按模块自己的位置找,而不是进程的 cwd", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "9.9.9-from-cwd" }));
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);

		try {
			expect(resolveAppVersion()).not.toBe("9.9.9-from-cwd");
			// apps/server/package.json —— 源码形态下模块往上找到的就是它。
			expect(resolveAppVersion()).toBe(serverPkgVersion);
		} finally {
			cwdSpy.mockRestore();
		}
	});
});

describe("findNearestPackageJson", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "bn-nearest-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("bundle 形态:package.json 就在入口旁边", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.0.0" }));

		expect(findNearestPackageJson(pathToFileURL(join(dir, "index.mjs")).href)).toBe(
			join(dir, "package.json"),
		);
	});

	it("源码形态:从深处一层层往上,取最近的那个", () => {
		mkdirSync(join(dir, "src", "routes"), { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.0.0" }));

		expect(
			findNearestPackageJson(pathToFileURL(join(dir, "src", "routes", "health.ts")).href),
		).toBe(join(dir, "package.json"));
	});

	it("一路到根都没有 → null,不会摸到别人的 package.json", () => {
		mkdirSync(join(dir, "a", "b"), { recursive: true });

		expect(findNearestPackageJson(pathToFileURL(join(dir, "a", "b", "x.mjs")).href, 2)).toBeNull();
	});
});

/**
 * 刻画测试:MODULE_VERSIONS 与各核心包 package.json#version 逐一相等。
 * 钉的是「版本来源」这个行为不变量,与解析**机制**解耦 —— 机制从 createRequire
 * 运行时解析切到构建期静态 JSON import(单文件 bundle 后旁边没有 node_modules
 * 可解析,createRequire 全部落空 → 版本全显 0.0.0)时,本测试必须保绿。
 */
describe("MODULE_VERSIONS — 与 workspace 核心包版本一致", () => {
	const require_ = createRequire(import.meta.url);
	const ids = ["api", "storage", "subscription", "push", "dynamic", "live", "image", "ai"] as const;

	it("8 个核心包版本逐一相等,且无 0.0.0 降级", () => {
		for (const id of ids) {
			const pkg = require_(`@bilibili-notify/${id}/package.json`) as { version: string };
			expect(MODULE_VERSIONS[id], `模块 ${id}`).toBe(pkg.version);
			expect(MODULE_VERSIONS[id], `模块 ${id} 不应是降级值`).not.toBe("0.0.0");
		}
	});
});
