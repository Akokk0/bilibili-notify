/**
 * 🔴 **开机先 listen,再读数据**(ADR-0022 决策 2 与它下面的 🔗)。
 *
 * 1.0 第一次开机要把 0.x 的数据整代迁过来,图多、盘慢时要几分钟。迁移要是挡在 listen 前面,
 * 冻住的桌面壳 30 秒等不到健康检查就杀进程,连续 3 次就把这一版判死、退回 0.12,主人什么提示
 * 都看不到。所以开机分两段:先 listen,健康检查马上答、详情交开机进度;数据与引擎起来之前,业务接口一律
 * 503 `unavailable`。启动入口仍等全部起来才返回:数据段抛错时,冻住的 boot.mjs 要能当场退回
 * 预装的那一版,那时端口必须已经放掉。
 *
 * 「读数据」卡在哪一步由测试决定:包一层真的配置仓(不换掉它),让它的 `load` 等测试放行,或者
 * 直接抛错。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HealthResponse } from "@bilibili-notify/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { type ServerHandle, startServer } from "../index.js";

const gate = vi.hoisted(() => ({
	/** 配置仓的 `load` 等它;undefined = 不等。 */
	hold: undefined as Promise<void> | undefined,
	/** 配置仓的 `load` 直接抛它;undefined = 不抛。 */
	failure: undefined as Error | undefined,
	loadStarted: undefined as (() => void) | undefined,
}));

vi.mock("../config/store.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../config/store.js")>();
	return {
		...real,
		createConfigStore: (...args: Parameters<typeof real.createConfigStore>) => {
			const store = real.createConfigStore(...args);
			const load = store.load.bind(store);
			store.load = async () => {
				if (gate.failure) throw gate.failure;
				gate.loadStarted?.();
				await gate.hold;
				return load();
			};
			return store;
		},
	};
});

async function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.on("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			if (!address || typeof address === "string") {
				probe.close(() => reject(new Error("failed to allocate test port")));
				return;
			}
			const { port } = address;
			probe.close(() => resolve(port));
		});
	});
}

/** 端口能不能再被别人 listen —— boot.mjs 回落时要在同一进程里再起一台。 */
async function canListen(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const probe = createServer();
		probe.once("error", () => resolve(false));
		probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
	});
}

/** 反复打,直到连得上(拿到任何 HTTP 回应)或超时。 */
async function waitForResponse(
	url: string,
	init?: RequestInit,
	timeoutMs = 3_000,
): Promise<Response> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			return await fetch(url, init);
		} catch (error) {
			if (Date.now() > deadline) throw error;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
}

describe("开机先 listen 再读数据 e2e", () => {
	let dataDir: string;
	let port: number;
	let handle: ServerHandle | undefined;

	const url = (path: string) => `http://127.0.0.1:${port}${path}`;
	const argv = () => [
		"--host",
		"127.0.0.1",
		"--port",
		String(port),
		"--data-dir",
		dataDir,
		"--log-level",
		"silent",
	];

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-boot-listen-first-e2e-"));
		port = await findFreePort();
		gate.hold = undefined;
		gate.failure = undefined;
		gate.loadStarted = undefined;
	});

	afterEach(async () => {
		await handle?.close("test cleanup").catch(() => {});
		handle = undefined;
		await rm(dataDir, { recursive: true, force: true });
	});

	it("数据还没读完:短版与开机详情已经 200,启动入口还没返回", async () => {
		let release!: () => void;
		gate.hold = new Promise<void>((resolve) => {
			release = resolve;
		});
		let settled = false;
		const starting = startServer({
			argv: argv(),
			env: { BN_CONFIG_DISABLED: "1", BN_ALLOW_NO_AUTH: "1" },
		}).finally(() => {
			settled = true;
		});

		const health = await waitForResponse(url("/api/health"));
		expect(health.status).toBe(200);
		const body = (await health.json()) as HealthResponse;
		expect(body.status).toBe("ok");
		// 开机段答的是同一份短版:四格,不带各模块的状态(那住详情口,开机段还没有)。
		expect(Object.keys(body).sort()).toEqual(["startedAt", "status", "uptime", "version"]);

		try {
			const details = await fetch(url("/api/health/details"));
			expect(details.status).toBe(200);
			expect(await details.json()).toEqual({ phase: "starting", progress: null });
			expect(settled).toBe(false);
		} finally {
			release();
			handle = await starting;
		}
		const running = await fetch(url("/api/health/details"));
		expect(await running.json()).toMatchObject({ phase: "running" });
	});

	it("开机期间业务接口与拓展挂载点仍回 503 unavailable", async () => {
		let release!: () => void;
		gate.hold = new Promise<void>((resolve) => {
			release = resolve;
		});
		const starting = startServer({
			argv: argv(),
			env: { BN_CONFIG_DISABLED: "1", BN_ALLOW_NO_AUTH: "1" },
		});
		await waitForResponse(url("/api/health"));
		try {
			for (const path of ["/api/subscriptions", "/ext/bridge/anything"]) {
				const res = await fetch(url(path));
				expect(res.status, path).toBe(503);
				expect(((await res.json()) as { code: string }).code, path).toBe("unavailable");
			}
		} finally {
			release();
			handle = await starting;
		}
		const subs = await fetch(url("/api/subscriptions"));
		expect(subs.status).toBe(200);
	});

	it("迁移已经完成、配置还在加载:阶段为 starting,迁移进度已清空", async () => {
		await mkdir(join(dataDir, "state"));
		await writeFile(join(dataDir, "state", "targets.json"), "[]");
		let release!: () => void;
		gate.hold = new Promise<void>((resolve) => {
			release = resolve;
		});
		const loading = new Promise<void>((resolve) => {
			gate.loadStarted = resolve;
		});
		const starting = startServer({
			argv: argv(),
			env: { BN_CONFIG_DISABLED: "1", BN_ALLOW_NO_AUTH: "1" },
		});
		try {
			await loading;
			const details = await fetch(url("/api/health/details"));
			expect(details.status).toBe(200);
			expect(await details.json()).toEqual({ phase: "starting", progress: null });
		} finally {
			release();
			handle = await starting;
		}
	});

	it("桌面 token 只豁免短版:开机详情与运行详情都必须带令牌", async () => {
		let release!: () => void;
		gate.hold = new Promise<void>((resolve) => {
			release = resolve;
		});
		const starting = startServer({
			argv: argv(),
			env: { BN_CONFIG_DISABLED: "1", BN_DESKTOP_TOKEN: "test-desktop-token" },
		});
		try {
			expect((await waitForResponse(url("/api/health"))).status).toBe(200);
			expect((await fetch(url("/api/health/details"))).status).toBe(401);
			const details = await fetch(url("/api/health/details"), {
				headers: { "x-bn-desktop-token": "test-desktop-token" },
			});
			expect(details.status).toBe(200);
			expect(await details.json()).toEqual({ phase: "starting", progress: null });
		} finally {
			release();
			handle = await starting;
		}
		expect((await fetch(url("/api/health/details"))).status).toBe(401);
		const running = await fetch(url("/api/health/details"), {
			headers: { "x-bn-desktop-token": "test-desktop-token" },
		});
		expect(running.status).toBe(200);
		expect(await running.json()).toMatchObject({ phase: "running" });
	});

	it("配了看板账号:开机那一段的鉴权闸和完整的 app 是同一套", async () => {
		let release!: () => void;
		gate.hold = new Promise<void>((resolve) => {
			release = resolve;
		});
		const env = {
			BN_CONFIG_DISABLED: "1",
			BN_DASHBOARD_USER: "master",
			BN_DASHBOARD_PASS: "correct horse battery staple",
		};
		const starting = startServer({ argv: argv(), env });
		let cookie = "";
		try {
			// 没登录:健康检查与别的接口都挡在闸外(401),不是 200 或 503。登录入口照常开着。
			const health = await waitForResponse(url("/api/health"));
			expect(health.status).toBe(401);
			expect((await fetch(url("/api/subscriptions"))).status).toBe(401);
			expect((await fetch(url("/api/health/details"))).status).toBe(401);
			expect((await fetch(url("/api/session"))).status).toBe(200);
			const login = await fetch(url("/api/session/login"), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ username: env.BN_DASHBOARD_USER, password: env.BN_DASHBOARD_PASS }),
			});
			expect(login.status).toBe(200);
			cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
			const details = await fetch(url("/api/health/details"), { headers: { cookie } });
			expect(details.status).toBe(200);
			expect(await details.json()).toEqual({ phase: "starting", progress: null });
		} finally {
			release();
			handle = await starting;
		}
		expect((await fetch(url("/api/health"))).status).toBe(401);
		expect((await fetch(url("/api/health/details"))).status).toBe(401);
		const running = await fetch(url("/api/health/details"), { headers: { cookie } });
		expect(running.status).toBe(200);
		expect(await running.json()).toMatchObject({ phase: "running" });
	});

	it("数据段抛错:启动入口抛出去,端口已经放掉", async () => {
		gate.failure = new Error("state dir unreadable");

		await expect(
			startServer({ argv: argv(), env: { BN_CONFIG_DISABLED: "1", BN_ALLOW_NO_AUTH: "1" } }),
		).rejects.toThrow("state dir unreadable");

		expect(await canListen(port)).toBe(true);
	});
});
