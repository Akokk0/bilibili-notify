import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { MODULE_VERSIONS, resolveAppVersion } from "../health.js";

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
