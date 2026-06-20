// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { parse as parseYaml } from "yaml";
import { resolveConfigPath } from "../loader";
import { persistChromePath } from "../persist";

describe("persistChromePath", () => {
	let dir: string;
	let cfg: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "bn-persist-"));
		cfg = join(dir, "bn.config.yaml");
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("writes chromePath into an existing config, preserving other fields", async () => {
		await writeFile(cfg, "dataDir: ./data\nlogLevel: info\n", "utf8");
		await persistChromePath(cfg, "/usr/bin/google-chrome");
		const parsed = parseYaml(await readFile(cfg, "utf8"));
		expect(parsed.chromePath).toBe("/usr/bin/google-chrome");
		expect(parsed.dataDir).toBe("./data");
		expect(parsed.logLevel).toBe("info");
	});

	it("preserves comments in the original config (Document API, not re-stringify)", async () => {
		await writeFile(cfg, "# 卡片渲染需要本地 Chrome\ndataDir: ./data\n", "utf8");
		await persistChromePath(cfg, "/usr/bin/google-chrome");
		const raw = await readFile(cfg, "utf8");
		expect(raw).toContain("# 卡片渲染需要本地 Chrome");
		expect(raw).toContain("chromePath: /usr/bin/google-chrome");
	});

	it("overwrites an existing chromePath", async () => {
		await writeFile(cfg, "chromePath: /old/chrome\ndataDir: ./data\n", "utf8");
		await persistChromePath(cfg, "/new/chrome");
		const parsed = parseYaml(await readFile(cfg, "utf8"));
		expect(parsed.chromePath).toBe("/new/chrome");
	});
});

describe("resolveConfigPath", () => {
	it("BN_CONFIG 绝对路径 → 原样返回", () => {
		expect(resolveConfigPath({ env: { BN_CONFIG: "/config/bn.config.yaml" }, cwd: "/app" })).toBe(
			"/config/bn.config.yaml",
		);
	});

	it("BN_CONFIG 相对路径 → 相对 cwd 解析", () => {
		expect(resolveConfigPath({ env: { BN_CONFIG: "conf/bn.yaml" }, cwd: "/app" })).toBe(
			"/app/conf/bn.yaml",
		);
	});

	it("BN_CONFIG_DISABLED=1 → null(sidecar/desktop 无配置文件)", () => {
		expect(resolveConfigPath({ env: { BN_CONFIG_DISABLED: "1" }, cwd: "/app" })).toBeNull();
	});

	it("无 BN_CONFIG(legacy) + cwd 无配置文件 → null(无写回目标,走 env/手改)", () => {
		expect(resolveConfigPath({ env: {}, cwd: "/app" })).toBeNull();
	});

	it("无 BN_CONFIG(legacy) + cwd 扫到 bn.config.yaml → 返回该文件(dev 模式也持久化)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bn-resolve-"));
		try {
			const cfg = join(dir, "bn.config.yaml");
			await writeFile(cfg, "dataDir: ./data\n", "utf8");
			expect(resolveConfigPath({ env: {}, cwd: dir })).toBe(cfg);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
