// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 测试 yaml `${VAR}` 字面量插值语义,不能转为 template literal
/**
 * 单元测试 — `loadBootstrapConfig`(B 模型 + legacy 12-factor 兼容)。
 *
 * 守护契约:
 *   **A. BN_CONFIG 显式设置(B 模型,docker 部署主路径)**
 *   - 路径不存在 → first-boot seed:env + CLI 写入 yaml(含 SEED_HEADER 注释),
 *     返回与文件等价的 config
 *   - 路径是目录(EISDIR)→ 抛 Error,信息提及 bind-mount + docs 引用
 *   - 路径是文件 → 读 file,**完全忽略 env**(包括镜像内置 BN_HOST=0.0.0.0
 *     这种 implicit override),仅 CLI 仍可叠加覆盖
 *   - file 内 schema 错 → 抛 Error,信息含字段路径 + 修复提示
 *   - 空文件 → schema 默认值(等同 `{}`)
 *   - dataDir 在 B 模型下也走 file 真相(BN_CONFIG 已显式指定 yaml 路径,与 dataDir
 *     解耦,无鸡生蛋)
 *
 *   **B. BN_CONFIG 未设置(legacy 12-factor,dev / vp test 路径)**
 *   - 三层 deepMerge:file(若 cwd 扫到)< ENV < CLI
 *   - 候选扫描顺序 yaml > yml > json
 *   - 默认值兜底
 *
 *   **C. 通用**
 *   - `${VAR}` 插值用 process.env(非传入 env);未定义变量原样保留
 *   - BN_DASHBOARD_USER/PASS 必须成对才写 basicAuth
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
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

// ---------------------------------------------------------------------------
// B 模型 — BN_CONFIG 显式设置
// ---------------------------------------------------------------------------

describe("loadBootstrapConfig — B 模型 first-boot seed", () => {
	it("路径不存在:env + CLI seed 进 file,返回 config 与 file 一致", async () => {
		const cfgPath = join(cwd, "bn.config.yaml");
		const logged: string[] = [];
		const c = loadBootstrapConfig({
			argv: ["--port=9999"],
			env: { BN_CONFIG: cfgPath, BN_HOST: "1.1.1.1", BN_DATA_DIR: "/seed/data" },
			cwd,
			log: (m) => logged.push(m),
		});
		expect(c.server).toEqual({ host: "1.1.1.1", port: 9999 });
		expect(c.dataDir).toBe("/seed/data");
		// 文件已经写入
		const fileRaw = await readFile(cfgPath, "utf8");
		expect(fileRaw).toContain("auto-generated on first boot");
		const fileObj = parseYaml(fileRaw) as Record<string, unknown>;
		expect((fileObj.server as Record<string, unknown>).host).toBe("1.1.1.1");
		expect((fileObj.server as Record<string, unknown>).port).toBe(9999);
		expect(fileObj.dataDir).toBe("/seed/data");
		expect(logged.some((m) => m.includes("first boot"))).toBe(true);
	});

	it("seed 也填入 schema defaults(用户能看到完整可配字段)", async () => {
		const cfgPath = join(cwd, "bn.config.yaml");
		const c = loadBootstrapConfig({
			argv: [],
			env: { BN_CONFIG: cfgPath },
			cwd,
			log: () => {},
		});
		expect(c.server).toEqual({ host: "0.0.0.0", port: 8787 }); // schema default
		const fileObj = parseYaml(await readFile(cfgPath, "utf8")) as Record<string, unknown>;
		expect(fileObj.server).toEqual({ host: "0.0.0.0", port: 8787 });
		expect(fileObj.dataDir).toBe("./data");
		expect(fileObj.logLevel).toBe("info");
	});
});

describe("loadBootstrapConfig — B 模型:file 存在,env 被忽略", () => {
	it("第二次启动 env 不再覆盖 file(B 模型核心,修 docker BN_HOST=0.0.0.0 隐式覆盖坑)", async () => {
		const cfgPath = join(cwd, "bn.config.yaml");
		// 模拟"用户编辑过 file 把 host 改成 127.0.0.1"
		await writeFile(
			cfgPath,
			"server:\n  host: 127.0.0.1\n  port: 8787\ndataDir: ./data\nlogLevel: info\n",
			"utf8",
		);
		const c = loadBootstrapConfig({
			argv: [],
			env: { BN_CONFIG: cfgPath, BN_HOST: "0.0.0.0" }, // 模拟 docker image 内置 ENV
			cwd,
			log: () => {},
		});
		expect(c.server.host).toBe("127.0.0.1"); // file 胜 env
	});

	it("file 存在时不重写,seed 函数不再被调用", async () => {
		const cfgPath = join(cwd, "bn.config.yaml");
		await writeFile(cfgPath, "logLevel: warn\n", "utf8");
		const logged: string[] = [];
		loadBootstrapConfig({
			argv: [],
			env: { BN_CONFIG: cfgPath },
			cwd,
			log: (m) => logged.push(m),
		});
		expect(logged.some((m) => m.includes("first boot"))).toBe(false);
	});

	it("CLI 仍可叠加(file 存在分支也允许一次性 escape hatch)", async () => {
		const cfgPath = join(cwd, "bn.config.yaml");
		await writeFile(cfgPath, "server:\n  host: 127.0.0.1\n  port: 8787\n", "utf8");
		const c = loadBootstrapConfig({
			argv: ["--port=9000"],
			env: { BN_CONFIG: cfgPath },
			cwd,
			log: () => {},
		});
		expect(c.server.host).toBe("127.0.0.1"); // file
		expect(c.server.port).toBe(9000); // CLI
	});
});

describe("loadBootstrapConfig — B 模型异常处理(Q5)", () => {
	it("路径是目录(EISDIR)→ 抛 Error,信息含 bind-mount 提示", async () => {
		const dirPath = join(cwd, "bn.config.yaml");
		await mkdir(dirPath);
		expect(() =>
			loadBootstrapConfig({ argv: [], env: { BN_CONFIG: dirPath }, cwd, log: () => {} }),
		).toThrow(/is a directory/);
	});

	it("空文件 → schema 默认值(合法 yaml 等同 `{}`)", async () => {
		const cfgPath = join(cwd, "bn.config.yaml");
		await writeFile(cfgPath, "", "utf8");
		const c = loadBootstrapConfig({
			argv: [],
			env: { BN_CONFIG: cfgPath },
			cwd,
			log: () => {},
		});
		expect(c.server).toEqual({ host: "0.0.0.0", port: 8787 });
		expect(c.logLevel).toBe("info");
	});

	it("schema 错(类型不对)→ 抛 Error,信息含字段路径 + 修复提示", async () => {
		const cfgPath = join(cwd, "bn.config.yaml");
		await writeFile(cfgPath, "logLevel: not-a-valid-level\n", "utf8");
		expect(() =>
			loadBootstrapConfig({ argv: [], env: { BN_CONFIG: cfgPath }, cwd, log: () => {} }),
		).toThrow(/schema error/);
	});

	afterEach(async () => {
		// 上面创建的目录/文件统一在 mkdtemp 里,beforeEach 重新建 → afterEach 全清
		await rm(cwd, { recursive: true, force: true }).catch(() => {});
	});
});

describe("loadBootstrapConfig — B 模型 dataDir 也走 file 真相", () => {
	it("file 里 dataDir 胜 env(BN_CONFIG 解耦了鸡生蛋)", async () => {
		const cfgPath = join(cwd, "bn.config.yaml");
		await writeFile(cfgPath, "dataDir: /from/file\n", "utf8");
		const c = loadBootstrapConfig({
			argv: [],
			env: { BN_CONFIG: cfgPath, BN_DATA_DIR: "/from/env" },
			cwd,
			log: () => {},
		});
		expect(c.dataDir).toBe("/from/file");
	});

	it("first-boot 时 dataDir 也跟其他字段一起 seed", async () => {
		const cfgPath = join(cwd, "bn.config.yaml");
		loadBootstrapConfig({
			argv: [],
			env: { BN_CONFIG: cfgPath, BN_DATA_DIR: "/seed/data" },
			cwd,
			log: () => {},
		});
		const fileObj = parseYaml(await readFile(cfgPath, "utf8")) as Record<string, unknown>;
		expect(fileObj.dataDir).toBe("/seed/data");
	});
});

// ---------------------------------------------------------------------------
// Legacy 12-factor — BN_CONFIG 未设(dev / test)
// ---------------------------------------------------------------------------

describe("loadBootstrapConfig — legacy:默认值", () => {
	it("无 file/env/cli → schema 默认", () => {
		const c = loadBootstrapConfig({ argv: [], env: {}, cwd });
		expect(c.server).toEqual({ host: "0.0.0.0", port: 8787 });
		expect(c.dataDir).toBe("./data");
		expect(c.logLevel).toBe("info");
	});
});

describe("loadBootstrapConfig — legacy:file 层", () => {
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

describe("loadBootstrapConfig — legacy:三层优先级 file < ENV < CLI", () => {
	it("CLI 胜 ENV 胜 file,deepMerge 保留同级未冲突字段", async () => {
		await write("bn.config.yaml", "server:\n  host: file-host\n  port: 1111\ndataDir: file-dir\n");
		const c = loadBootstrapConfig({
			argv: ["--host", "cli-host"],
			env: { BN_HOST: "env-host", BN_DATA_DIR: "env-dir" },
			cwd,
		});
		expect(c.server.host).toBe("cli-host");
		expect(c.server.port).toBe(1111);
		expect(c.dataDir).toBe("env-dir");
	});
});

describe("loadBootstrapConfig — legacy:ENV 层", () => {
	it("BN_* 映射到嵌套路径", () => {
		const c = loadBootstrapConfig({
			argv: [],
			env: { BN_HOST: "h", BN_PORT: "2200", BN_DATA_DIR: "d", BN_LOG_LEVEL: "warn" },
			cwd,
		});
		expect(c.server).toEqual({ host: "h", port: 2200 });
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

describe("loadBootstrapConfig — legacy:CLI 层", () => {
	it("--k=v / --k v / 裸 --flag(→true)", () => {
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

// ---------------------------------------------------------------------------
// 通用 — interpolation
// ---------------------------------------------------------------------------

describe("loadBootstrapConfig — ${VAR} 插值", () => {
	it("使用 process.env 替换,未定义变量原样保留", async () => {
		setProcEnv("BN_TEST_DIR", "/from/procenv");
		await write(
			"bn.config.yaml",
			"dataDir: ${BN_TEST_DIR}\ncookieEncryptionKey: ${BN_UNDEFINED_VAR}\n",
		);
		const c = loadBootstrapConfig({ argv: [], env: {}, cwd });
		expect(c.dataDir).toBe("/from/procenv");
		expect(c.cookieEncryptionKey).toBe("${BN_UNDEFINED_VAR}");
	});
});
