// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 测试 yaml `${VAR}` 字面量插值语义,不能转为 template literal
/**
 * 单元测试 — `loadBootstrapConfig`(B 模型 + legacy 12-factor 兼容)。
 *
 * 守护契约:
 *   **A. BN_CONFIG 显式设置(B 模型,docker 部署主路径)**
 *   - 路径不存在 → first-boot seed:env + CLI 写入 yaml(含 SEED_HEADER 注释),
 *     返回与文件等价的 config
 *   - first-boot 若监听 non-loopback 又无 basicAuth(否则 index.ts 门禁 fail-closed
 *     拒启)→ 自动生成 admin + 随机密码补进 auth;loopback / BN_ALLOW_NO_AUTH=1 不生成
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
afterEach(async () => {
	for (const k of touchedEnv.splice(0)) delete process.env[k];
	await rm(cwd, { recursive: true, force: true }).catch(() => {});
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

	it("round-trip:first-boot 返回的 config 与第二次启动读回的 config 深度相等(B3)", async () => {
		const cfgPath = join(cwd, "bn.config.yaml");
		const first = loadBootstrapConfig({
			argv: [],
			env: {
				BN_CONFIG: cfgPath,
				BN_HOST: "1.2.3.4",
				BN_PORT: "9000",
				BN_DATA_DIR: "/r/data",
				BN_LOG_LEVEL: "debug",
				BN_DASHBOARD_USER: "admin",
				BN_DASHBOARD_PASS: "pw",
			},
			cwd,
			log: () => {},
		});
		// 第二次启动:env 仍在但应被忽略,file 解析回来要跟 first 完全相等
		const second = loadBootstrapConfig({
			argv: [],
			env: {
				BN_CONFIG: cfgPath,
				BN_HOST: "should-be-ignored",
				BN_PORT: "0",
			},
			cwd,
			log: () => {},
		});
		expect(second).toEqual(first);
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

	it("CLI 仍可叠加(file 存在分支也允许一次性 escape hatch)— 顶层 + nested 字段都验", async () => {
		const cfgPath = join(cwd, "bn.config.yaml");
		await writeFile(
			cfgPath,
			"server:\n  host: 127.0.0.1\n  port: 8787\ndataDir: /file/data\nlogLevel: info\nchromePath: /file/chrome\nwebDistDir: /file/web\n",
			"utf8",
		);
		const c = loadBootstrapConfig({
			argv: [
				"--port=9000",
				"--data-dir=/cli/data",
				"--log-level=debug",
				"--chrome-path=/cli/chrome",
				"--web-dist",
				"/cli/web",
			],
			env: { BN_CONFIG: cfgPath },
			cwd,
			log: () => {},
		});
		expect(c.server.host).toBe("127.0.0.1"); // file 保留 nested 未冲突字段
		expect(c.server.port).toBe(9000); // CLI 覆盖 nested
		expect(c.dataDir).toBe("/cli/data"); // CLI 覆盖顶层
		expect(c.logLevel).toBe("debug"); // CLI 覆盖顶层
		expect(c.chromePath).toBe("/cli/chrome");
		expect(c.webDistDir).toBe("/cli/web");
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

	it("schema 错(类型不对)→ 抛 Error,信息含 read mode + 字段路径 + 修复提示", async () => {
		const cfgPath = join(cwd, "bn.config.yaml");
		await writeFile(cfgPath, "logLevel: not-a-valid-level\n", "utf8");
		// 强化断言:mode (read)、字段路径 logLevel、修复 hint 三段都要在,否则未来回归
		// 把 parseOrRethrow 信息拆掉测试不会红
		const fn = () =>
			loadBootstrapConfig({ argv: [], env: { BN_CONFIG: cfgPath }, cwd, log: () => {} });
		expect(fn).toThrow(/schema error \(read\)/);
		expect(fn).toThrow(/logLevel/);
		expect(fn).toThrow(/rm.*first boot 重新 seed/);
	});

	it("BN_CONFIG=foo.json first-boot:.json 扩展名写 JSON,第二次启动不炸(A1 回归守护)", async () => {
		const cfgPath = join(cwd, "bn.config.json");
		const first = loadBootstrapConfig({
			argv: [],
			env: { BN_CONFIG: cfgPath, BN_HOST: "1.2.3.4" },
			cwd,
			log: () => {},
		});
		expect(first.server.host).toBe("1.2.3.4");
		// 第二次启动:JSON.parse 必须能读回,否则就是原 A1 bug 重现
		const second = loadBootstrapConfig({
			argv: [],
			env: { BN_CONFIG: cfgPath, BN_HOST: "should-be-ignored" },
			cwd,
			log: () => {},
		});
		expect(second.server.host).toBe("1.2.3.4");
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
// B 模型 — first-boot dashboard 凭据自动兜底
// ---------------------------------------------------------------------------

describe("loadBootstrapConfig — B 模型 first-boot 凭据自动生成", () => {
	it("non-loopback + 无 auth → 自动生成 admin + 随机密码,写进 yaml + 打日志", async () => {
		const cfgPath = join(cwd, "bn.config.yaml");
		const logged: string[] = [];
		const c = loadBootstrapConfig({
			argv: [],
			env: { BN_CONFIG: cfgPath, BN_HOST: "0.0.0.0" },
			cwd,
			log: (m) => logged.push(m),
		});
		expect(c.auth?.basicAuth?.username).toBe("admin");
		const pw = c.auth?.basicAuth?.password ?? "";
		expect(pw).toMatch(/^[A-Za-z0-9_-]+$/); // base64url,插值安全
		expect(pw.length).toBeGreaterThanOrEqual(16); // 足够熵
		// 凭据写进了 yaml(host 端可取)
		const fileObj = parseYaml(await readFile(cfgPath, "utf8")) as Record<string, unknown>;
		const fileAuth = (fileObj.auth as Record<string, unknown>).basicAuth as Record<string, unknown>;
		expect(fileAuth.username).toBe("admin");
		expect(fileAuth.password).toBe(pw);
		// 打了日志(docker logs 可见)
		expect(logged.some((m) => m.includes("自动生成") && m.includes("password:"))).toBe(true);
	});

	it("BN_ALLOW_NO_AUTH=1 → 不生成(尊重显式逃生口)", () => {
		const cfgPath = join(cwd, "bn.config.yaml");
		const c = loadBootstrapConfig({
			argv: [],
			env: { BN_CONFIG: cfgPath, BN_HOST: "0.0.0.0", BN_ALLOW_NO_AUTH: "1" },
			cwd,
			log: () => {},
		});
		expect(c.auth?.basicAuth).toBeUndefined();
	});

	it("loopback host(127.0.0.1)→ 不生成(裸跑本就合法)", () => {
		const cfgPath = join(cwd, "bn.config.yaml");
		const c = loadBootstrapConfig({
			argv: [],
			env: { BN_CONFIG: cfgPath, BN_HOST: "127.0.0.1" },
			cwd,
			log: () => {},
		});
		expect(c.auth?.basicAuth).toBeUndefined();
	});

	it("用户已给 BN_DASHBOARD_USER/PASS → 用用户的,不覆盖成随机", () => {
		const cfgPath = join(cwd, "bn.config.yaml");
		const c = loadBootstrapConfig({
			argv: [],
			env: {
				BN_CONFIG: cfgPath,
				BN_HOST: "0.0.0.0",
				BN_DASHBOARD_USER: "myuser",
				BN_DASHBOARD_PASS: "mypass",
			},
			cwd,
			log: () => {},
		});
		expect(c.auth?.basicAuth).toEqual({ username: "myuser", password: "mypass" });
	});

	it("生成的密码插值安全 + 第二次启动原样读回(不再生成、不被 ${} 替换)", async () => {
		const cfgPath = join(cwd, "bn.config.yaml");
		const first = loadBootstrapConfig({
			argv: [],
			env: { BN_CONFIG: cfgPath, BN_HOST: "0.0.0.0" },
			cwd,
			log: () => {},
		});
		const pw = first.auth?.basicAuth?.password;
		expect(pw).toBeTruthy();
		expect(pw).not.toContain("${");
		// 第二次启动:file 存在分支,既不重新生成也不被插值改写
		const second = loadBootstrapConfig({
			argv: [],
			env: { BN_CONFIG: cfgPath, BN_HOST: "0.0.0.0" },
			cwd,
			log: () => {},
		});
		expect(second.auth?.basicAuth?.password).toBe(pw);
	});

	it("两次独立 first-boot 生成不同密码(随机性 sanity)", () => {
		const a = loadBootstrapConfig({
			argv: [],
			env: { BN_CONFIG: join(cwd, "a.yaml"), BN_HOST: "0.0.0.0" },
			cwd,
			log: () => {},
		});
		const b = loadBootstrapConfig({
			argv: [],
			env: { BN_CONFIG: join(cwd, "b.yaml"), BN_HOST: "0.0.0.0" },
			cwd,
			log: () => {},
		});
		expect(a.auth?.basicAuth?.password).not.toBe(b.auth?.basicAuth?.password);
	});

	it("无 BN_HOST(走 schema 默认 0.0.0.0)→ 仍触发生成(docker 镜像 ENV 缺省路径)", () => {
		const cfgPath = join(cwd, "bn.config.yaml");
		const c = loadBootstrapConfig({
			argv: [],
			env: { BN_CONFIG: cfgPath }, // 无 BN_HOST,schema 默认 host=0.0.0.0
			cwd,
			log: () => {},
		});
		expect(c.server.host).toBe("0.0.0.0");
		expect(c.auth?.basicAuth?.username).toBe("admin");
	});

	it("半配置:只给 BN_DASHBOARD_USER 不给 PASS → 保留用户名,仅兜底生成密码", async () => {
		// readEnv 要求 USER+PASS 成对才写 auth.basicAuth,只给 USER 时整个 auth 为空 →
		// maybeSeedDashboardCredentials 兜底:username 取 BN_DASHBOARD_USER(尊重用户
		// 输入,不静默丢弃),password 仍随机生成。
		const cfgPath = join(cwd, "bn.config.yaml");
		const c = loadBootstrapConfig({
			argv: [],
			env: { BN_CONFIG: cfgPath, BN_HOST: "0.0.0.0", BN_DASHBOARD_USER: "myadmin" },
			cwd,
			log: () => {},
		});
		expect(c.auth?.basicAuth?.username).toBe("myadmin"); // 保留用户设的,而非回落 admin
		expect(c.auth?.basicAuth?.password).toMatch(/^[A-Za-z0-9_-]+$/); // 密码仍是随机生成
		const fileObj = parseYaml(await readFile(cfgPath, "utf8")) as Record<string, unknown>;
		const fileAuth = (fileObj.auth as Record<string, unknown>).basicAuth as Record<string, unknown>;
		expect(fileAuth.username).toBe("myadmin");
	});

	it("seed 出的凭据满足 BasicAuthSchema(username/password 均 min(1))", () => {
		// maybeSeedDashboardCredentials 在 parseOrRethrow 之后 mutate config.auth,
		// 注入的 basicAuth 不再过 schema 校验 —— 守护注入值本身合法。
		const c = loadBootstrapConfig({
			argv: [],
			env: { BN_CONFIG: join(cwd, "bn.config.yaml"), BN_HOST: "0.0.0.0" },
			cwd,
			log: () => {},
		});
		expect(c.auth?.basicAuth?.username.length ?? 0).toBeGreaterThan(0);
		expect(c.auth?.basicAuth?.password.length ?? 0).toBeGreaterThan(0);
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

	it("BN_CONFIG='' 空字符串走 legacy 分支(不抛、不 seed)— B1", async () => {
		const logged: string[] = [];
		const c = loadBootstrapConfig({
			argv: [],
			env: { BN_CONFIG: "", BN_HOST: "1.1.1.1" }, // 空 BN_CONFIG + 还有 BN_HOST
			cwd,
			log: (m) => logged.push(m),
		});
		// 走 legacy → env 仍生效(BN_HOST 覆盖默认)
		expect(c.server.host).toBe("1.1.1.1");
		// 不 seed
		expect(logged.some((m) => m.includes("first boot"))).toBe(false);
	});
});

describe("loadBootstrapConfig — BN_CONFIG_DISABLED", () => {
	it("禁用 bootstrap file:忽略 cwd 中的 bn.config.yaml,只合并 ENV + CLI + defaults", async () => {
		await write(
			"bn.config.yaml",
			"server:\n  host: file-host\n  port: 1111\ndataDir: /file/data\n",
		);
		const c = loadBootstrapConfig({
			argv: ["--port", "3333", "--web-dist", "/cli/web"],
			env: {
				BN_CONFIG_DISABLED: "1",
				BN_HOST: "127.0.0.1",
				BN_DATA_DIR: "/env/data",
				BN_CHROME_PATH: "/env/chrome",
			},
			cwd,
			log: () => {},
		});
		expect(c.server).toEqual({ host: "127.0.0.1", port: 3333 });
		expect(c.dataDir).toBe("/env/data");
		expect(c.chromePath).toBe("/env/chrome");
		expect(c.webDistDir).toBe("/cli/web");
	});

	it("禁用 bootstrap file:不创建配置文件", async () => {
		const cfgPath = join(cwd, "bn.config.yaml");
		loadBootstrapConfig({
			argv: ["--host", "127.0.0.1"],
			env: { BN_CONFIG_DISABLED: "1", BN_CONFIG: "" },
			cwd,
			log: () => {},
		});
		await expect(readFile(cfgPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("BN_CONFIG_DISABLED=1 与非空 BN_CONFIG 同时存在 → fail-fast", () => {
		expect(() =>
			loadBootstrapConfig({
				argv: [],
				env: { BN_CONFIG_DISABLED: "1", BN_CONFIG: join(cwd, "bn.config.yaml") },
				cwd,
				log: () => {},
			}),
		).toThrow(/BN_CONFIG_DISABLED=1/);
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
			env: {
				BN_HOST: "h",
				BN_PORT: "2200",
				BN_DATA_DIR: "d",
				BN_LOG_LEVEL: "warn",
				BN_CHROME_PATH: "/env/chrome",
				BN_WEB_DIST: "/env/web",
			},
			cwd,
		});
		expect(c.server).toEqual({ host: "h", port: 2200 });
		expect(c.dataDir).toBe("d");
		expect(c.logLevel).toBe("warn");
		expect(c.chromePath).toBe("/env/chrome");
		expect(c.webDistDir).toBe("/env/web");
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
			argv: [
				"--log-level=debug",
				"--data-dir",
				"/cli/dir",
				"--cookie-key",
				"abc",
				"--chrome-path=/cli/chrome",
				"--web-dist",
				"/cli/web",
			],
			env: {},
			cwd,
		});
		expect(c.logLevel).toBe("debug");
		expect(c.dataDir).toBe("/cli/dir");
		expect(c.cookieEncryptionKey).toBe("abc");
		expect(c.chromePath).toBe("/cli/chrome");
		expect(c.webDistDir).toBe("/cli/web");
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
