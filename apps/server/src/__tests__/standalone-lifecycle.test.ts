import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { type StandaloneServerHandle, startStandaloneServer } from "../index.js";

async function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close(() => reject(new Error("failed to allocate test port")));
				return;
			}
			const { port } = address;
			server.close(() => resolve(port));
		});
	});
}

function makeEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return { BN_CONFIG_DISABLED: "1", BN_ALLOW_NO_AUTH: "1", ...extra };
}

async function eventually(assertion: () => void): Promise<void> {
	let lastError: unknown;
	const deadline = Date.now() + 1_000;
	while (Date.now() < deadline) {
		try {
			assertion();
			return;
		} catch (err) {
			lastError = err;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	if (lastError) throw lastError;
	assertion();
}

describe("standalone server lifecycle", () => {
	let dataDir: string;
	let handle: StandaloneServerHandle | undefined;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-standalone-"));
	});

	/**
	 * 摆一份「当前跑的载荷」:`<dir>/index.mjs` 与它同级的 `web-dist/`。
	 * 真实部署里这就是 `/app/` 或升级后的 `/data/versions/<ver>/`。
	 */
	async function seedPayloadWebDist(title: string): Promise<{ bundleUrl: string; dir: string }> {
		const dir = await mkdtemp(join(dataDir, "payload-"));
		await mkdir(join(dir, "web-dist"), { recursive: true });
		await writeFile(join(dir, "web-dist", "index.html"), `<!doctype html><title>${title}</title>`);
		return { bundleUrl: pathToFileURL(join(dir, "index.mjs")).href, dir };
	}

	afterEach(async () => {
		await handle?.close("test cleanup").catch(() => {});
		handle = undefined;
		vi.restoreAllMocks();
		await rm(dataDir, { recursive: true, force: true });
	});

	it("启动 loopback server 后可访问匿名 /api/health,close 不调用 process.exit", async () => {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
			code?: string | number | null,
		) => {
			throw new Error(`unexpected process.exit(${code})`);
		}) as never);
		const port = await findFreePort();

		handle = await startStandaloneServer({
			argv: [
				"--host",
				"127.0.0.1",
				"--port",
				String(port),
				"--data-dir",
				dataDir,
				"--log-level",
				"silent",
			],
			env: makeEnv(),
			shutdownTimeoutMs: 1_000,
		});

		expect(handle.host).toBe("127.0.0.1");
		expect(handle.port).toBe(port);
		expect(handle.url).toBe(`http://127.0.0.1:${port}`);
		const res = await fetch(`${handle.url}/api/health`);
		expect(res.status).toBe(200);
		expect((await res.json()) as Record<string, unknown>).toMatchObject({ status: "ok" });

		await handle.close("test");
		await handle.close("test again");
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it("non-loopback 无 auth 且无 BN_ALLOW_NO_AUTH 时拒绝启动但不调用 process.exit", async () => {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
			code?: string | number | null,
		) => {
			throw new Error(`unexpected process.exit(${code})`);
		}) as never);
		const port = await findFreePort();

		await expect(
			startStandaloneServer({
				argv: [
					"--host",
					"0.0.0.0",
					"--port",
					String(port),
					"--data-dir",
					dataDir,
					"--log-level",
					"silent",
				],
				env: { BN_CONFIG_DISABLED: "1" },
				shutdownTimeoutMs: 1_000,
			}),
		).rejects.toThrow(/auth not configured/);
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it("已有 bootstrap yaml 缺 webDistDir 时回退到 BN_WEB_DIST 托管 Dashboard", async () => {
		const port = await findFreePort();
		const configPath = join(dataDir, "bn.config.yaml");
		const webDistDir = join(dataDir, "web-dist");
		await mkdir(webDistDir, { recursive: true });
		await writeFile(join(webDistDir, "index.html"), "<!doctype html><title>bn dashboard</title>");
		await writeFile(
			configPath,
			`server:\n  host: 127.0.0.1\n  port: ${port}\ndataDir: ${JSON.stringify(dataDir)}\nlogLevel: silent\n`,
		);

		handle = await startStandaloneServer({
			argv: [],
			env: { BN_CONFIG: configPath, BN_WEB_DIST: webDistDir },
			shutdownTimeoutMs: 1_000,
		});

		const root = await fetch(`${handle.url}/`, { headers: { connection: "close" } });
		expect(root.status).toBe(200);
		expect(root.headers.get("content-type")).toContain("text/html");
		expect(await root.text()).toContain("bn dashboard");

		const health = await fetch(`${handle.url}/api/health`, { headers: { connection: "close" } });
		expect(health.status).toBe(200);
		expect((await health.json()) as Record<string, unknown>).toMatchObject({ status: "ok" });
	});

	it("已有 bootstrap yaml 和 BN_WEB_DIST 都缺失时回退到载荷旁边那份 web-dist", async () => {
		const port = await findFreePort();
		const configPath = join(dataDir, "bn.config.yaml");
		const payload = await seedPayloadWebDist("bn payload dashboard");
		await writeFile(
			configPath,
			`server:\n  host: 127.0.0.1\n  port: ${port}\ndataDir: ${JSON.stringify(dataDir)}\nlogLevel: silent\n`,
		);

		handle = await startStandaloneServer({
			argv: [],
			env: { BN_CONFIG: configPath },
			bundleUrl: payload.bundleUrl,
			shutdownTimeoutMs: 1_000,
		});

		const root = await fetch(`${handle.url}/`, { headers: { connection: "close" } });
		expect(root.status).toBe(200);
		expect(root.headers.get("content-type")).toContain("text/html");
		expect(await root.text()).toContain("bn payload dashboard");
	});

	/**
	 * 在线升级之后,`/app/web-dist` 里躺的是**镜像自带的那份旧前端**,而新服务端
	 * 在 `/data/versions/<新版>/` 下跑。yaml 里那句 `webDistDir: /app/web-dist`
	 * 不是用户填的(界面上没这个字段),是首启动 seed 进去的 —— 照字面听它,升级后
	 * 就是「新服务端配旧前端」,而且**不报错**,直到某个改过的接口对不上才炸。
	 * AstrBot 的 core/dashboard 错配就是这个形态。
	 */
	it("yaml 里留着首启动 seed 的 /app/web-dist 时,dashboard 仍跟着当前载荷走", async () => {
		const port = await findFreePort();
		const configPath = join(dataDir, "bn.config.yaml");
		const payload = await seedPayloadWebDist("bn payload dashboard");
		await writeFile(
			configPath,
			`server:\n  host: 127.0.0.1\n  port: ${port}\ndataDir: ${JSON.stringify(dataDir)}\nlogLevel: silent\nwebDistDir: /app/web-dist\n`,
		);

		handle = await startStandaloneServer({
			argv: [],
			env: { BN_CONFIG: configPath },
			bundleUrl: payload.bundleUrl,
			shutdownTimeoutMs: 1_000,
		});

		const root = await fetch(`${handle.url}/`, { headers: { connection: "close" } });
		expect(root.status).toBe(200);
		expect(await root.text()).toContain("bn payload dashboard");
	});

	it("用户自己在 yaml 里指定了别的目录 → 照听,不替他跟着载荷走", async () => {
		const port = await findFreePort();
		const configPath = join(dataDir, "bn.config.yaml");
		// 载荷旁边那份也在,用来证明「照听」不是碰巧撞上了兜底。
		const payload = await seedPayloadWebDist("bn payload dashboard");
		const ownDir = join(dataDir, "my-dashboard");
		await mkdir(ownDir, { recursive: true });
		await writeFile(join(ownDir, "index.html"), "<!doctype html><title>bn own dashboard</title>");
		await writeFile(
			configPath,
			`server:\n  host: 127.0.0.1\n  port: ${port}\ndataDir: ${JSON.stringify(dataDir)}\nlogLevel: silent\nwebDistDir: ${JSON.stringify(ownDir)}\n`,
		);

		handle = await startStandaloneServer({
			argv: [],
			env: { BN_CONFIG: configPath },
			bundleUrl: payload.bundleUrl,
			shutdownTimeoutMs: 1_000,
		});

		const root = await fetch(`${handle.url}/`, { headers: { connection: "close" } });
		expect(root.status).toBe(200);
		expect(await root.text()).toContain("bn own dashboard");
	});

	it("installProcessHandlers:SIGTERM 触发 graceful close 后 exit(0),显式 close 会移除 handler", async () => {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		const port = await findFreePort();

		handle = await startStandaloneServer({
			argv: [
				"--host",
				"127.0.0.1",
				"--port",
				String(port),
				"--data-dir",
				dataDir,
				"--log-level",
				"silent",
			],
			env: makeEnv(),
			installProcessHandlers: true,
			shutdownTimeoutMs: 1_000,
		});

		process.emit("SIGTERM");
		await eventually(() => expect(exitSpy).toHaveBeenCalledWith(0));
		await handle.close("already closed");
		exitSpy.mockClear();
		process.emit("SIGTERM");
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it("installProcessHandlers:unhandledRejection 走同一关闭路径并 exit(1)", async () => {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		const port = await findFreePort();

		handle = await startStandaloneServer({
			argv: [
				"--host",
				"127.0.0.1",
				"--port",
				String(port),
				"--data-dir",
				dataDir,
				"--log-level",
				"silent",
			],
			env: makeEnv(),
			installProcessHandlers: true,
			shutdownTimeoutMs: 1_000,
		});

		process.emit("unhandledRejection", new Error("boom"), Promise.resolve());
		await eventually(() => expect(exitSpy).toHaveBeenCalledWith(1));
	});
});
