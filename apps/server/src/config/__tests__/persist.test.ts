// @vitest-environment node
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { parse as parseYaml } from "yaml";
import { resolveConfigPath, resolveCredentialsTarget } from "../loader";
import { persistChromeSource, persistDashboardCredentials } from "../persist";

describe("persistChromeSource", () => {
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
		await persistChromeSource(cfg, { chromePath: "/usr/bin/google-chrome" });
		const parsed = parseYaml(await readFile(cfg, "utf8"));
		expect(parsed.chromePath).toBe("/usr/bin/google-chrome");
		expect(parsed.dataDir).toBe("./data");
		expect(parsed.logLevel).toBe("info");
	});

	it("writes chromeEndpoint and clears an existing chromePath (source is the full new state)", async () => {
		// chromePath / chromeEndpoint 互斥:boot-time 选择逻辑固定 chromeEndpoint 优先,
		// 若切到 chromeEndpoint 后留着旧 chromePath,重启会读到两者都在、行为却仍正确
		// (endpoint 赢)—— 但反过来切回 chromePath 时若不清 chromeEndpoint,重启就会
		// 悄悄退回旧的远程端点,与用户刚做的切换相反。source 代表切换后的完整新状态,
		// 未传的字段一律清空,两个方向都不留歧义。
		await writeFile(cfg, "chromePath: /usr/bin/chromium\ndataDir: ./data\n", "utf8");
		await persistChromeSource(cfg, { chromeEndpoint: "ws://browser:3000" });
		const parsed = parseYaml(await readFile(cfg, "utf8"));
		expect(parsed.chromeEndpoint).toBe("ws://browser:3000");
		expect(parsed.chromePath).toBeUndefined();
	});

	it("writes chromePath and clears an existing chromeEndpoint", async () => {
		await writeFile(cfg, "chromeEndpoint: ws://old-browser:3000\ndataDir: ./data\n", "utf8");
		await persistChromeSource(cfg, { chromePath: "/usr/bin/chromium" });
		const parsed = parseYaml(await readFile(cfg, "utf8"));
		expect(parsed.chromePath).toBe("/usr/bin/chromium");
		expect(parsed.chromeEndpoint).toBeUndefined();
	});

	it("preserves comments in the original config (Document API, not re-stringify)", async () => {
		await writeFile(cfg, "# 卡片渲染需要本地 Chrome\ndataDir: ./data\n", "utf8");
		await persistChromeSource(cfg, { chromePath: "/usr/bin/google-chrome" });
		const raw = await readFile(cfg, "utf8");
		expect(raw).toContain("# 卡片渲染需要本地 Chrome");
		expect(raw).toContain("chromePath: /usr/bin/google-chrome");
	});

	// 钉的是写盘那一步:文件里可能有 dashboard 凭据,写回后权限必须收成 0o600(哪怕原来是 0o644),
	// 而且写完目录里只剩配置文件本身。权限位在 Windows 上没有意义。
	it.skipIf(process.platform === "win32")(
		"写回后权限收成 0o600,目录里没有遗留的临时文件",
		async () => {
			await writeFile(cfg, "dataDir: ./data\n", "utf8");
			await chmod(cfg, 0o644);
			await persistChromeSource(cfg, { chromePath: "/usr/bin/google-chrome" });
			expect((await stat(cfg)).mode & 0o777).toBe(0o600);
			expect(await readdir(dir)).toEqual(["bn.config.yaml"]);
		},
	);

	it("overwrites an existing chromePath", async () => {
		await writeFile(cfg, "chromePath: /old/chrome\ndataDir: ./data\n", "utf8");
		await persistChromeSource(cfg, { chromePath: "/new/chrome" });
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

describe("persistDashboardCredentials", () => {
	let dir: string;
	let cfg: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "bn-persist-creds-"));
		cfg = join(dir, "bn.config.yaml");
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("写进 auth.basicAuth,别的格与注释都留着;文件 0600", async () => {
		await writeFile(
			cfg,
			"# 面板登录\nauth:\n  basicAuth:\n    username: admin # 首启动种的\n    password: old\ndataDir: ./data\n",
			"utf8",
		);
		await persistDashboardCredentials(cfg, { username: "owner", password: "n3w-secret" });
		const text = await readFile(cfg, "utf8");
		const parsed = parseYaml(text);
		expect(parsed.auth.basicAuth).toEqual({ username: "owner", password: "n3w-secret" });
		expect(parsed.dataDir).toBe("./data");
		expect(text).toContain("# 面板登录");
		expect((await stat(cfg)).mode & 0o777).toBe(0o600);
	});

	it("文件里还没有 auth 那一节 → 补上", async () => {
		await writeFile(cfg, "dataDir: ./data\n", "utf8");
		await persistDashboardCredentials(cfg, { username: "owner", password: "n3w-secret" });
		expect(parseYaml(await readFile(cfg, "utf8")).auth.basicAuth).toEqual({
			username: "owner",
			password: "n3w-secret",
		});
	});

	it.each(["credentials-first", "chrome-first"] as const)(
		"并发保存凭据和浏览器来源，两项都保留（%s）",
		async (order) => {
			await writeFile(
				cfg,
				"# 保留部署说明\nauth:\n  basicAuth:\n    username: admin\n    password: old\nchromeEndpoint: ws://old-browser:3000\ndataDir: ./data\n",
			);
			const credentials = () =>
				persistDashboardCredentials(cfg, { username: "owner", password: "n3w-secret" });
			const chrome = () => persistChromeSource(cfg, { chromePath: "/new/chrome" });
			const writes = order === "credentials-first" ? [credentials, chrome] : [chrome, credentials];
			await Promise.all(writes.map((write) => write()));

			const text = await readFile(cfg, "utf8");
			expect(parseYaml(text)).toEqual({
				auth: { basicAuth: { username: "owner", password: "n3w-secret" } },
				chromePath: "/new/chrome",
				dataDir: "./data",
			});
			expect(text).toContain("# 保留部署说明");
		},
	);

	it("凭据写入失败如实返回，不阻断同文件排队的浏览器保存", async () => {
		await writeFile(cfg, "auth: invalid\ndataDir: ./data\n");
		const results = await Promise.allSettled([
			persistDashboardCredentials(cfg, { username: "owner", password: "n3w-secret" }),
			persistChromeSource(cfg, { chromePath: "/new/chrome" }),
		]);
		expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
		expect(parseYaml(await readFile(cfg, "utf8"))).toEqual({
			auth: "invalid",
			dataDir: "./data",
			chromePath: "/new/chrome",
		});
	});
});

describe("resolveCredentialsTarget(面板改账号密码写到哪)", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "bn-creds-target-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("设了 BN_CONFIG → 写那份文件(环境变量只在首次开机种一次,之后以文件为准)", () => {
		const target = resolveCredentialsTarget({
			env: { BN_CONFIG: "/config/bn.config.yaml", BN_DASHBOARD_USER: "a", BN_DASHBOARD_PASS: "b" },
			cwd: "/app",
		});
		expect(target).toEqual({ ok: true, path: "/config/bn.config.yaml" });
	});

	it("旧式部署(没设 BN_CONFIG)有配置文件、环境变量没设凭据 → 写那份文件", async () => {
		const cfg = join(dir, "bn.config.yaml");
		await writeFile(cfg, "dataDir: ./data\n", "utf8");
		expect(resolveCredentialsTarget({ env: {}, cwd: dir })).toEqual({ ok: true, path: cfg });
	});

	it("旧式部署在环境变量里设了凭据 → 拒绝:每次开机环境变量都会盖掉文件里的", async () => {
		await writeFile(join(dir, "bn.config.yaml"), "dataDir: ./data\n", "utf8");
		for (const env of [{ BN_DASHBOARD_USER: "a" }, { BN_DASHBOARD_PASS: "b" }]) {
			const target = resolveCredentialsTarget({ env, cwd: dir });
			expect(target).toMatchObject({ ok: false, code: "not_configured" });
			expect(!target.ok && target.message).toContain("BN_DASHBOARD_USER");
		}
	});

	it("旧式部署根本没有配置文件 → 拒绝并说明", () => {
		const target = resolveCredentialsTarget({ env: {}, cwd: dir });
		expect(target).toMatchObject({ ok: false, code: "not_configured" });
	});

	it("桌面版(BN_CONFIG_DISABLED)→ 不归这里管", () => {
		expect(
			resolveCredentialsTarget({ env: { BN_CONFIG_DISABLED: "1" }, cwd: "/app" }),
		).toMatchObject({
			ok: false,
			code: "unsupported",
		});
	});
});
