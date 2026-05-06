import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BiliLoginStatus, type LoginSnapshot } from "@bilibili-notify/api";
import type { MessageBus } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { AuthSystem } from "../auth/index.js";
import type { BootstrapConfig } from "../config/schema.js";
import { createAppRuntime } from "../runtime/bootstrap.js";

// ---------------------------------------------------------------------------
// Fake AuthSystem: stand-in for the real wired stack. Driven by tests via the
// `_setSnapshot` test-only escape hatch that lives on the fake itself.
// ---------------------------------------------------------------------------

interface FakeAuthSystem extends AuthSystem {
	_setSnapshot: (s: LoginSnapshot) => void;
	_emitAuthLost: () => void;
	beginLogin: ReturnType<typeof vi.fn>;
	refreshCookies: ReturnType<typeof vi.fn>;
	resetCookies: ReturnType<typeof vi.fn>;
	logout: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
}

function makeFakeAuthSystem(opts: { bus?: MessageBus } = {}): FakeAuthSystem {
	let snapshot: LoginSnapshot = {
		status: BiliLoginStatus.NOT_LOGIN,
		msg: "未登录",
	};
	const fake = {
		// real interface fields the routes do not touch — leave undefined-typed
		api: undefined as unknown as AuthSystem["api"],
		storage: undefined as unknown as AuthSystem["storage"],
		flow: undefined as unknown as AuthSystem["flow"],
		beginLogin: vi.fn(async () => {
			snapshot = { status: BiliLoginStatus.LOGIN_QR, msg: "", data: "data:image/png;base64,XYZ" };
		}),
		refreshCookies: vi.fn(async () => {}),
		resetCookies: vi.fn(async () => {
			snapshot = { status: BiliLoginStatus.NOT_LOGIN, msg: "密钥已重置" };
			opts.bus?.emit("auth-lost");
		}),
		logout: vi.fn(async () => {
			snapshot = { status: BiliLoginStatus.NOT_LOGIN, msg: "未登录" };
		}),
		status: () => snapshot,
		dispose: vi.fn(() => {}),
		_setSnapshot: (s: LoginSnapshot) => {
			snapshot = s;
		},
		_emitAuthLost: () => opts.bus?.emit("auth-lost"),
	};
	return fake as unknown as FakeAuthSystem;
}

function makeBootstrap(dataDir: string): BootstrapConfig {
	return {
		server: { host: "127.0.0.1", port: 8787 },
		dataDir,
		logLevel: "silent",
	};
}

async function readJson(res: Response): Promise<unknown> {
	return JSON.parse(await res.text());
}

// ---------------------------------------------------------------------------

describe("auth routes", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-auth-routes-"));
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	async function buildApp(authSystem: AuthSystem): Promise<{
		app: ReturnType<typeof createApp>;
		runtime: ReturnType<typeof createAppRuntime>;
	}> {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		const app = createApp(runtime, { authSystem });
		return { app, runtime };
	}

	it("GET /api/auth/status returns the current snapshot", async () => {
		const fake = makeFakeAuthSystem();
		fake._setSnapshot({
			status: BiliLoginStatus.LOGGED_IN,
			msg: "已登录",
			data: { card: { mid: "42", name: "tester" } },
		});
		const { app, runtime } = await buildApp(fake);

		const res = await app.request("/api/auth/status");
		expect(res.status).toBe(200);
		const body = (await readJson(res)) as LoginSnapshot;
		expect(body.status).toBe(BiliLoginStatus.LOGGED_IN);
		expect(body.msg).toBe("已登录");

		await runtime.dispose();
	});

	it("POST /api/auth/qr calls flow.beginLogin once and returns ok", async () => {
		const fake = makeFakeAuthSystem();
		const { app, runtime } = await buildApp(fake);

		const res = await app.request("/api/auth/qr", { method: "POST" });
		expect(res.status).toBe(200);
		expect(await readJson(res)).toEqual({ ok: true });
		expect(fake.beginLogin).toHaveBeenCalledTimes(1);

		await runtime.dispose();
	});

	it("POST /api/auth/qr while in LOGIN_QR state returns 409", async () => {
		const fake = makeFakeAuthSystem();
		fake._setSnapshot({
			status: BiliLoginStatus.LOGIN_QR,
			msg: "",
			data: "data:image/png;base64,XYZ",
		});
		const { app, runtime } = await buildApp(fake);

		const res = await app.request("/api/auth/qr", { method: "POST" });
		expect(res.status).toBe(409);
		const body = (await readJson(res)) as { error: string };
		expect(body.error).toBe("qr_already_active");
		expect(fake.beginLogin).not.toHaveBeenCalled();

		await runtime.dispose();
	});

	it("POST /api/auth/qr while in LOGGING_QR state returns 409", async () => {
		const fake = makeFakeAuthSystem();
		fake._setSnapshot({ status: BiliLoginStatus.LOGGING_QR, msg: "请扫码" });
		const { app, runtime } = await buildApp(fake);

		const res = await app.request("/api/auth/qr", { method: "POST" });
		expect(res.status).toBe(409);
		expect(fake.beginLogin).not.toHaveBeenCalled();

		await runtime.dispose();
	});

	it("POST /api/auth/cookies/reset clears storage AND emits auth-lost on the bus", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		const events: string[] = [];
		runtime.bus.on("auth-lost", () => {
			events.push("auth-lost");
		});
		const fake = makeFakeAuthSystem({ bus: runtime.bus });
		const app = createApp(runtime, { authSystem: fake });

		const res = await app.request("/api/auth/cookies/reset", { method: "POST" });
		expect(res.status).toBe(200);
		expect(await readJson(res)).toEqual({ ok: true });
		expect(fake.resetCookies).toHaveBeenCalledTimes(1);
		expect(events).toEqual(["auth-lost"]);

		await runtime.dispose();
	});

	it("POST /api/auth/cookies/refresh succeeds and forwards to authSystem", async () => {
		const fake = makeFakeAuthSystem();
		const { app, runtime } = await buildApp(fake);

		const res = await app.request("/api/auth/cookies/refresh", { method: "POST" });
		expect(res.status).toBe(200);
		expect(fake.refreshCookies).toHaveBeenCalledTimes(1);

		await runtime.dispose();
	});

	it("POST /api/auth/logout returns 200 and the status transitions to NOT_LOGIN", async () => {
		const fake = makeFakeAuthSystem();
		fake._setSnapshot({ status: BiliLoginStatus.LOGGED_IN, msg: "已登录" });
		const { app, runtime } = await buildApp(fake);

		const before = await app.request("/api/auth/status");
		expect(((await readJson(before)) as LoginSnapshot).status).toBe(BiliLoginStatus.LOGGED_IN);

		const logoutRes = await app.request("/api/auth/logout", { method: "POST" });
		expect(logoutRes.status).toBe(200);
		expect(fake.logout).toHaveBeenCalledTimes(1);

		const after = await app.request("/api/auth/status");
		expect(((await readJson(after)) as LoginSnapshot).status).toBe(BiliLoginStatus.NOT_LOGIN);

		await runtime.dispose();
	});

	it("returns 500 with a safe message when beginLogin throws (no stack in body)", async () => {
		const fake = makeFakeAuthSystem();
		fake.beginLogin.mockImplementationOnce(async () => {
			throw new Error("internal-explosion: secret-token-leak");
		});
		const { app, runtime } = await buildApp(fake);

		const res = await app.request("/api/auth/qr", { method: "POST" });
		expect(res.status).toBe(500);
		const body = (await readJson(res)) as { error: string; message: string };
		expect(body.error).toBe("auth_failed");
		expect(body.message).toBe("failed to start QR login");
		// The thrown message must not appear in the response body.
		expect(JSON.stringify(body)).not.toContain("internal-explosion");
		expect(JSON.stringify(body)).not.toContain("secret-token-leak");

		await runtime.dispose();
	});

	it("returns 500 with a safe message when refreshCookies throws", async () => {
		const fake = makeFakeAuthSystem();
		fake.refreshCookies.mockImplementationOnce(async () => {
			throw new Error("network down");
		});
		const { app, runtime } = await buildApp(fake);

		const res = await app.request("/api/auth/cookies/refresh", { method: "POST" });
		expect(res.status).toBe(500);
		const body = (await readJson(res)) as { error: string; message: string };
		expect(body.error).toBe("auth_failed");
		expect(body.message).toBe("failed to refresh cookies");

		await runtime.dispose();
	});
});
