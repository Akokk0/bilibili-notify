/**
 * 单元测试 — `/api/adapters/:adapterKey/auth…` 扫码建连接的三个口。
 *
 * - 路由层:用手写的假适配器登记进**真登记表**(视图摘成员那一步不绕开),逐个码对状态码;
 *   「多带一格的假适配器」另证回包是逐格挑出来的,不是把适配器的返回值整个展开。
 * - 端到端:登记**真的** QQ 适配器,只换全局 `fetch`,证明路由真接上了真适配器、
 *   读状态不带草稿、取走之后再取是「找不到」。
 */
import type { PlatformAdapter } from "@bilibili-notify/internal";
import { fail, ok } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { fakeAdapterContext } from "../../__tests__/support/adapter-ctx.js";
import { fixedLocale } from "../../__tests__/support/fixed-locale.js";
import { encryptLikeTencent } from "../../platforms/__tests__/tencent-bind-crypto.js";
import { createQQOfficialAdapter, createQQSessionRegistry } from "../../platforms/qq-official.js";
import { createPlatformAdapterRegistry } from "../../push/registry.js";
import { createAdaptersRoute } from "../adapters.js";
import type { RouteDeps } from "../types.js";

const SECRET = "SuperSecretValue-9f3a";
const APP_ID = "102000777";

function logger() {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

async function appOf(adapters: readonly PlatformAdapter[], log = logger()) {
	const adapterRegistry = createPlatformAdapterRegistry();
	for (const adapter of adapters) await adapterRegistry.register(adapter, fakeAdapterContext().ctx);
	const deps = {
		runtime: { adapterRegistry, serviceCtx: { logger: log } },
	} as unknown as RouteDeps;
	return { app: createAdaptersRoute(deps), log };
}

/** 手写的假适配器:只有键、启停与(可选的)connectionAuth。 */
function fakeAdapter(adapterKey: string, connectionAuth?: PlatformAdapter["connectionAuth"]) {
	return {
		adapterKey,
		start: async () => {},
		stop: async () => {},
		...(connectionAuth ? { connectionAuth } : {}),
	} as unknown as PlatformAdapter;
}

const STATE = {
	status: "awaiting-scan",
	qr: { dataUrl: "data:image/png;base64,QR", expiresAt: "x" },
} as const;

function request(app: ReturnType<typeof createAdaptersRoute>, which: "begin" | "state" | "draft") {
	if (which === "begin") return app.request("/x/auth", { method: "POST" });
	if (which === "state") return app.request("/x/auth/t1");
	return app.request("/x/auth/t1/draft", { method: "POST" });
}

describe("适配器缺席 / 没有成员", () => {
	it.each(["begin", "state", "draft"] as const)(
		"键不在登记表 → %s 回 503 unavailable",
		async (which) => {
			const { app } = await appOf([]);
			const res = await request(app, which);
			expect(res.status).toBe(503);
			expect(await res.json()).toMatchObject({ code: "unavailable" });
		},
	);

	it.each(["begin", "state", "draft"] as const)(
		"适配器没有 connectionAuth → %s 回 400 unsupported",
		async (which) => {
			const { app } = await appOf([fakeAdapter("x")]);
			const res = await request(app, which);
			expect(res.status).toBe(400);
			expect(await res.json()).toMatchObject({ code: "unsupported" });
		},
	);
});

describe("适配器回的失败原样按码回", () => {
	it.each([
		["not_found", 404],
		["conflict", 409],
		["timeout", 504],
		["unavailable", 503],
	] as const)("%s → %i", async (code, status) => {
		const failing = async () => fail(code, "话");
		const { app } = await appOf([
			fakeAdapter("x", { begin: failing, state: failing, takeDraft: failing }),
		]);
		for (const which of ["begin", "state", "draft"] as const) {
			const res = await request(app, which);
			expect(res.status).toBe(status);
			expect(await res.json()).toEqual({ code, message: "话" });
		}
	});
});

describe("回包逐格挑,不展开适配器的返回值", () => {
	const auth = {
		begin: async () => ok({ taskId: "t1", state: STATE, pollIntervalSeconds: 2, extra: "LEAK" }),
		state: async () => ok({ state: STATE, settings: { appSecret: SECRET }, extra: "LEAK" }),
		takeDraft: async () => ok({ settings: { appId: APP_ID, appSecret: SECRET }, extra: "LEAK" }),
	} as unknown as NonNullable<PlatformAdapter["connectionAuth"]>;

	it("发起:只有 taskId / state / pollIntervalSeconds", async () => {
		const { app } = await appOf([fakeAdapter("x", auth)]);
		const res = await request(app, "begin");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ taskId: "t1", state: STATE, pollIntervalSeconds: 2 });
	});

	it("读状态:回包只有 state 一个键,没有草稿", async () => {
		const { app } = await appOf([fakeAdapter("x", auth)]);
		const res = await request(app, "state");
		expect(res.status).toBe(200);
		const body = (await res.json()) as object;
		expect(Object.keys(body)).toEqual(["state"]);
		expect(JSON.stringify(body)).not.toContain(SECRET);
	});

	it("取草稿:只有 settings,带 Cache-Control: no-store", async () => {
		const { app } = await appOf([fakeAdapter("x", auth)]);
		const res = await request(app, "draft");
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(await res.json()).toEqual({ settings: { appId: APP_ID, appSecret: SECRET } });
	});

	it("路径参数与请求的 signal 递给适配器", async () => {
		const state = vi.fn(async () => ok({ state: STATE }));
		const takeDraft = vi.fn(async () => ok({ settings: {} }));
		const { app } = await appOf([fakeAdapter("x", { ...auth, state, takeDraft })]);
		await app.request("/x/auth/a%20b");
		await app.request("/x/auth/a%20b/draft", { method: "POST" });
		expect(state).toHaveBeenCalledWith("a b", expect.any(AbortSignal));
		expect(takeDraft).toHaveBeenCalledWith("a b");
	});
});

describe("适配器真抛了(算 bug)", () => {
	it.each(["begin", "state", "draft"] as const)(
		"%s → 503 unavailable,记 error 日志",
		async (which) => {
			const boom = async () => {
				throw new Error("boom");
			};
			const { app, log } = await appOf([
				fakeAdapter("x", { begin: boom, state: boom, takeDraft: boom }),
			]);
			const res = await request(app, which);
			expect(res.status).toBe(503);
			expect(await res.json()).toMatchObject({ code: "unavailable" });
			expect(log.error).toHaveBeenCalled();
		},
	);
});

describe("端到端:真的 QQ 适配器,只换 fetch", () => {
	let fetchMock: ReturnType<typeof vi.fn>;
	let bindKey = "";
	let pollQueue: Array<() => Response> = [];
	/** 真的 `Response`:请求客户端要读头、读字节。 */
	function res(status: number, body: unknown): Response {
		return new Response(JSON.stringify(body), { status });
	}
	beforeEach(() => {
		bindKey = "";
		pollQueue = [];
		fetchMock = vi.fn(async (target: URL, init?: RequestInit) => {
			if (String(target).endsWith("/lite/create_bind_task")) {
				bindKey = (JSON.parse(String(init?.body)) as { key: string }).key;
				return res(200, { retcode: 0, data: { task_id: "UP-1" } });
			}
			const next = pollQueue.shift();
			return next ? next() : res(200, { retcode: 0, data: { status: 1 } });
		});
		vi.stubGlobal("fetch", fetchMock);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	async function qqApp() {
		const log = logger();
		const adapter = createQQOfficialAdapter({
			logger: log,
			serviceCtx: {
				logger: log,
				setTimeout: () => ({ dispose() {} }),
				setInterval: () => ({ dispose() {} }),
				onDispose() {},
				signal: new AbortController().signal,
				track: () => {},
			} as never,
			registry: createQQSessionRegistry(),
			locale: fixedLocale(),
		});
		const { app } = await appOf([adapter], log);
		return { app, log, adapter };
	}

	it("发起 → 未完成 → 成功(回包没有 appSecret)→ 取草稿拿到两格 → 再取找不到", async () => {
		const { app, log } = await qqApp();
		const begun = await app.request("/qq-official/auth", { method: "POST" });
		expect(begun.status).toBe(200);
		const { taskId, state, pollIntervalSeconds } = (await begun.json()) as {
			taskId: string;
			state: { status: string; qr: { dataUrl: string } };
			pollIntervalSeconds: number;
		};
		expect(state.status).toBe("awaiting-scan");
		expect(state.qr.dataUrl).toMatch(/^data:image\//);
		expect(pollIntervalSeconds).toBe(2);
		expect(JSON.stringify(state)).not.toContain(bindKey);

		const pending = await app.request(`/qq-official/auth/${taskId}`);
		expect(await pending.json()).toMatchObject({ state: { status: "awaiting-scan" } });

		pollQueue.push(() =>
			res(200, {
				retcode: 0,
				data: {
					status: 2,
					bot_appid: APP_ID,
					bot_encrypt_secret: encryptLikeTencent(SECRET, bindKey),
				},
			}),
		);
		const done = await app.request(`/qq-official/auth/${taskId}`);
		const doneBody = (await done.json()) as object;
		expect(doneBody).toMatchObject({ state: { status: "logged-in" } });
		expect(Object.keys(doneBody)).toEqual(["state"]);
		expect(JSON.stringify(doneBody)).not.toContain(SECRET);
		// 再读一次:状态仍在,仍不带草稿
		const again = await app.request(`/qq-official/auth/${taskId}`);
		expect(JSON.stringify(await again.json())).not.toContain(SECRET);

		const draft = await app.request(`/qq-official/auth/${taskId}/draft`, { method: "POST" });
		expect(draft.status).toBe(200);
		expect(await draft.json()).toEqual({ settings: { appId: APP_ID, appSecret: SECRET } });

		const second = await app.request(`/qq-official/auth/${taskId}/draft`, { method: "POST" });
		expect(second.status).toBe(404);
		expect(await second.json()).toMatchObject({ code: "not_found" });
		expect((await app.request(`/qq-official/auth/${taskId}`)).status).toBe(404);

		// 日志里没有密钥
		const logged = JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls]);
		expect(logged).not.toContain(SECRET);
	});

	it("没扫完就取草稿 → 409 conflict;上游故障 → 503", async () => {
		const { app } = await qqApp();
		const begun = (await (await app.request("/qq-official/auth", { method: "POST" })).json()) as {
			taskId: string;
		};
		const early = await app.request(`/qq-official/auth/${begun.taskId}/draft`, { method: "POST" });
		expect(early.status).toBe(409);
		pollQueue.push(() => res(500, {}));
		const failed = await app.request(`/qq-official/auth/${begun.taskId}`);
		expect(failed.status).toBe(503);
		expect(await failed.json()).toMatchObject({ code: "unavailable" });
	});
});
