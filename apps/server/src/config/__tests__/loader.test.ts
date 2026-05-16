/**
 * 单元测试 — `loadBootstrapConfig`(启动配置 defaults < file < ENV < CLI 合并)。
 *
 * 守护契约:
 *   - 空输入 → BootstrapConfigSchema 默认值
 *   - 优先级:file < ENV < CLI(逐层覆盖,deepMerge 保留同级未冲突字段)
 *   - 候选文件扫描顺序 yaml > yml > json;.json 走 JSON 解析,其余 YAML
 *   - BN_CONFIG 显式路径:存在则读;**缺失则硬失败**(不静默回退)
 *   - CLI:--k=v / --k v / 裸 --flag→"true";仅 CLI_KEY_MAP 内的键生效
 *   - `${VAR}` 插值使用 **process.env**(非传入 env);未定义变量原样保留
 *   - ENV:BN_DASHBOARD_USER/PASS 必须成对才写 basicAuth
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadBootstrapConfig } from "../loader.js";

let cwd: string;
const touchedEnv: string[] = [];

function setProcEnv(k: string, v: string) {
	touchedEnv.push(k);
	process.env[k] = v;
}

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "bn-cfg-"));
});
afterEach(() => {
	for (const k of touchedEnv.splice(0)) delete process.env[k];
});

const write = (name: string, body: string) => writeFile(join(cwd, name), body, "utf8");

describe("loadBootstrapConfig — 默认值", () => {
	it("无 file/env/cli → schema 默认", () => {
		const c = loadBootstrapConfig({ argv: [], env: {}, cwd });
		expect(c.server).toEqual({ host: "0.0.0.0", port: 8787 });
		expect(c.dataDir).toBe("./data");
		expect(c.logLevel).toBe("info");
	});
});

describe("loadBootstrapConfig — file 层", () => {
	it("读取 bn.config.yaml", async () => {
		await write("bn.config.yaml", "server:\n  host: 1.2.3.4\n  port: 9000\ndataDir: /srv/bn\n");
		const c = loadBootstrapConfig({ argv: [], env: {}, cwd });
		expect(c.server).toEqual({ host: "1.2.3.4", port: 9000 });
		expect(c.dataDir).toBe("/srv/bn");
	});

	it("读取 bn.config.json", async () => {
		await write("bn.config.json", JSON.stringify({ dataDir: "/json/dir", logLevel: "debug" }));
		const c = loadBootstrapConfig({ argv: [], env: {}, cwd });
		expect(c.dataDir).toBe("/json/dir");
		expect(c.logLevel).toBe("debug");
	});

	it("候选扫描顺序 yaml > yml > json(yaml 先命中即停)", async () => {
		await write("bn.config.yaml", "dataDir: from-yaml\n");
		await write("bn.config.yml", "dataDir: from-yml\n");
		await write("bn.config.json", JSON.stringify({ dataDir: "from-json" }));
		expect(loadBootstrapConfig({ argv: [], env: {}, cwd }).dataDir).toBe("from-yaml");
	});
});

describe("loadBootstrapConfig — 优先级 file < ENV < CLI", () => {
	it("三层叠加:CLI 胜 ENV 胜 file,deepMerge 保留同级未冲突字段", async () => {
		await write("bn.config.yaml", "server:\n  host: file-host\n  port: 1111\ndataDir: file-dir\n");
		const c = loadBootstrapConfig({
			argv: ["--host", "cli-host"],
			env: { BN_HOST: "env-host", BN_DATA_DIR: "env-dir" },
			cwd,
		});
		expect(c.server.host).toBe("cli-host"); // CLI 覆盖 ENV 覆盖 file
		expect(c.server.port).toBe(1111); // file 唯一来源,deepMerge 保留
		expect(c.dataDir).toBe("env-dir"); // ENV 覆盖 file(CLI 未给 data-dir)
	});
});

describe("loadBootstrapConfig — ENV 层", () => {
	it("BN_* 映射到嵌套路径", () => {
		const c = loadBootstrapConfig({
			argv: [],
			env: { BN_HOST: "h", BN_PORT: "2200", BN_DATA_DIR: "d", BN_LOG_LEVEL: "warn" },
			cwd,
		});
		expect(c.server).toEqual({ host: "h", port: 2200 }); // port 经 z.coerce 转 number
		expect(c.dataDir).toBe("d");
		expect(c.logLevel).toBe("warn");
	});

	it("BN_DASHBOARD_USER/PASS 必须成对才写 basicAuth", () => {
		const onlyUser = loadBootstrapConfig({ argv: [], env: { BN_DASHBOARD_USER: "admin" }, cwd });
		expect(onlyUser.auth?.basicAuth).toBeUndefined();
		const both = loadBootstrapConfig({
			argv: [],
			env: { BN_DASHBOARD_USER: "admin", BN_DASHBOARD_PASS: "pw" },
			cwd,
		});
		expect(both.auth?.basicAuth).toEqual({ username: "admin", password: "pw" });
	});
});

describe("loadBootstrapConfig — CLI 层", () => {
	it("--k=v / --k v / 裸 --flag(→true)", async () => {
		// log-level 用 --k=v;data-dir 用 --k v;cookie-key 走映射。
		const c = loadBootstrapConfig({
			argv: ["--log-level=debug", "--data-dir", "/cli/dir", "--cookie-key", "abc"],
			env: {},
			cwd,
		});
		expect(c.logLevel).toBe("debug");
		expect(c.dataDir).toBe("/cli/dir");
		expect(c.cookieEncryptionKey).toBe("abc");
	});

	it("仅 CLI_KEY_MAP 内的键生效,未知 --flag 被忽略", () => {
		const c = loadBootstrapConfig({ argv: ["--unknown", "x", "--host", "ok"], env: {}, cwd });
		expect(c.server.host).toBe("ok");
		expect(c).not.toHaveProperty("unknown");
	});
});

describe("loadBootstrapConfig — BN_CONFIG 显式路径", () => {
	it("显式 .json 路径走 JSON 解析", async () => {
		await write("custom.json", JSON.stringify({ dataDir: "explicit-json" }));
		const c = loadBootstrapConfig({ argv: [], env: { BN_CONFIG: join(cwd, "custom.json") }, cwd });
		expect(c.dataDir).toBe("explicit-json");
	});

	it("显式路径指向缺失文件:硬失败(不静默回退默认)", async () => {
		await write("bn.config.yaml", "dataDir: should-not-be-used\n");
		expect(() =>
			loadBootstrapConfig({ argv: [], env: { BN_CONFIG: join(cwd, "nope.yaml") }, cwd }),
		).toThrow();
	});
});

describe("loadBootstrapConfig — ${VAR} 插值", () => {
	it("使用 process.env 替换,未定义变量原样保留", async () => {
		setProcEnv("BN_TEST_DIR", "/from/procenv");
		await write("bn.config.yaml", "dataDir: ${BN_TEST_DIR}\ncookieEncryptionKey: ${BN_UNDEFINED_VAR}\n");
		// 注意:传入 env 不含 BN_TEST_DIR —— 插值仍命中,证明用的是 process.env。
		const c = loadBootstrapConfig({ argv: [], env: {}, cwd });
		expect(c.dataDir).toBe("/from/procenv");
		expect(c.cookieEncryptionKey).toBe("${BN_UNDEFINED_VAR}");
	});
});
