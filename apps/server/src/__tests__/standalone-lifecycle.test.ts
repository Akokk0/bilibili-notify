import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { WebSocket } from "ws";
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

	/**
	 * 拓展装载在 `index.ts` 里接线,除了这里**没有别的地方证明它真的接上了** ——
	 * 扫目录、开关、ctx、挂载点各自的单元测试都是在自己搭的零件上跑的。
	 * 漏一步的症状是「装了拓展但面板上什么都没有」,而进程照常启动、日志一个字都不说。
	 */
	it("装在 <dataDir>/extensions/ 里的拓展:关着不 import,开了就真的跑起来", async () => {
		const extDir = join(dataDir, "extensions", "demo");
		await mkdir(extDir, { recursive: true });
		await writeFile(
			join(extDir, "extension.json"),
			JSON.stringify({
				id: "demo",
				name: "示例拓展",
				description: "接线用",
				version: "1.0.0",
				apiVersion: 1,
				provides: ["push"],
			}),
		);
		await writeFile(
			join(extDir, "index.mjs"),
			`export function activate(ctx) { ctx.mount(async () => new Response("pong")); }`,
		);

		const boot = async () => {
			const port = await findFreePort();
			return startStandaloneServer({
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
		};

		// 头一趟:开关是关的(缺失 = 关着)——**一行代码都不该被 import**,但列得出来。
		handle = await boot();
		expect((await fetch(`${handle.url}/ext/demo/ping`)).status).toBe(404);
		const listed = (await (await fetch(`${handle.url}/api/ext`)).json()) as {
			extensions: Array<{ id: string; state: string; name: string }>;
		};
		// ⚠️ 源码运行时**仓里那个真桥也在名单里**(源码根,决策 35),所以这里挑自己种的
		// 那条看,不断整张表 —— 断整张表的话谁往仓里加个拓展这条就红,而它并没有坏。
		expect(listed.extensions).toContainEqual(
			expect.objectContaining({ id: "demo", state: "disabled", name: "示例拓展" }),
		);
		await handle.close("test");

		// 把开关拨开,重启 —— 换代码要重启,换开关本来不用,但这里连开机接线一起验。
		const globalsPath = join(dataDir, "state", "globals.json");
		const globals = JSON.parse(await readFile(globalsPath, "utf8")) as Record<string, unknown>;
		globals.extensions = { demo: { enabled: true } };
		await writeFile(globalsPath, JSON.stringify(globals));

		handle = await boot();
		expect(await (await fetch(`${handle.url}/ext/demo/ping`)).text()).toBe("pong");
		const running = (await (await fetch(`${handle.url}/api/ext`)).json()) as {
			extensions: Array<{ id: string; state: string }>;
		};
		expect(running.extensions).toContainEqual(
			expect.objectContaining({ id: "demo", state: "running", enabled: true }),
		);
	});

	/**
	 * 🔴 **桥现在是个拓展了,这条守卫跟着变成「整条拓展流水线通不通」。**
	 *
	 * 从前它证明的是 `index.ts` 有没有把桥那三样(端点 / 取图口 / 矩阵)接上;现在核心里
	 * 一根桥的线都没有了,要证明的是:扫多根扫到了仓里那份源码 → 开关开着 → 真 import 了
	 * `src/index.ts` → `activate` 跑通 → `ctx.mount` 与 `ctx.onUpgrade` 都真的接进了 HTTP
	 * server。**任何一环断掉,症状都是「插件连不上 / 图 404」,而进程照常启动、日志一个字
	 * 都不说。**
	 *
	 * 拿真桥而不是再种一个假拓展:假的证明不了那条 upgrade 分发真的把 socket 交到了拓展
	 * 手里(它得有个 WS 服务器才接得住)。
	 */
	it("桥拓展开着:`/ext/bridge` 的无 token upgrade 回 401,取图口回 404", async () => {
		const boot = async () => {
			const port = await findFreePort();
			const started = await startStandaloneServer({
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
			return { started, port };
		};

		// 头一趟只为把 globals 落到盘上 —— 开关缺失 = 关着(决策 34:开箱即有 ≠ 默认开着)。
		handle = (await boot()).started;
		await handle.close("test");
		const globalsPath = join(dataDir, "state", "globals.json");
		const globals = JSON.parse(await readFile(globalsPath, "utf8")) as Record<string, unknown>;
		globals.extensions = { bridge: { enabled: true } };
		await writeFile(globalsPath, JSON.stringify(globals));

		const second = await boot();
		handle = second.started;

		// `activate` 真的跑完了 —— 它最后一件事是 `ctx.publishStatus`,而这条口只有跑完
		// 才答得出来。⚠️ 光断取图口那个 404 是不够的:拓展**根本没装载**时,请求会落到
		// 挂载表自己那句「没这个拓展」,body 一模一样(实测过,那条断言两种情况都绿)。
		const status = await fetch(`${handle.url}/api/ext/bridge/status`);
		expect(status.status).toBe(200);
		expect(await status.json()).toEqual({ sessions: [] });

		// 取图口在 `/api/*` 之外,所以这一发不带任何凭据也该走到拓展的 handler。
		const blob = await fetch(`${handle.url}/ext/bridge/blob/0123456789abcdef0123456789abcdef`);
		expect(blob.status).toBe(404);
		// 断 body 不只断状态码:挂载点**没接上**的话请求落到 Hono 的默认 404,那也是 404 ——
		// 只看状态码的话这条守卫永远不会红(实测过)。
		expect(await blob.text()).toBe('{"ok":false,"err":"not found"}');

		// upgrade 交到桥手里了 —— 交到了才会有人应答,没交的话这条连接会一直吊着。
		const upgradeStatus = await new Promise<number>((resolve, reject) => {
			const socket = new WebSocket(`ws://127.0.0.1:${second.port}/ext/bridge`);
			const timer = setTimeout(
				() => reject(new Error("没人应答 upgrade:/ext/bridge 没接到桥手里")),
				2_000,
			);
			socket.on("unexpected-response", (_req, res) => {
				clearTimeout(timer);
				socket.terminate();
				resolve(res.statusCode ?? 0);
			});
			socket.on("open", () => {
				clearTimeout(timer);
				socket.terminate();
				resolve(101);
			});
			socket.on("error", () => {});
		});
		expect(upgradeStatus).toBe(401);
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
