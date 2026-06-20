import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { resolveAppVersion } from "../health.js";

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
