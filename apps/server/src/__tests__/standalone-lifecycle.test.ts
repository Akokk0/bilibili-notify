import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

	it("已有 bootstrap yaml 和 BN_WEB_DIST 都缺失时回退到默认 web-dist 目录", async () => {
		const port = await findFreePort();
		const configPath = join(dataDir, "bn.config.yaml");
		const defaultWebDistDir = join(dataDir, "default-web-dist");
		await mkdir(defaultWebDistDir, { recursive: true });
		await writeFile(
			join(defaultWebDistDir, "index.html"),
			"<!doctype html><title>bn default dashboard</title>",
		);
		await writeFile(
			configPath,
			`server:\n  host: 127.0.0.1\n  port: ${port}\ndataDir: ${JSON.stringify(dataDir)}\nlogLevel: silent\n`,
		);

		handle = await startStandaloneServer({
			argv: [],
			env: { BN_CONFIG: configPath },
			defaultWebDistDir,
			shutdownTimeoutMs: 1_000,
		});

		const root = await fetch(`${handle.url}/`, { headers: { connection: "close" } });
		expect(root.status).toBe(200);
		expect(root.headers.get("content-type")).toContain("text/html");
		expect(await root.text()).toContain("bn default dashboard");
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
