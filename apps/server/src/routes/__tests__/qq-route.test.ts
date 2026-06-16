/**
 * 单元测试 — /api/qq 路由。
 * - GET /sessions/:adapterId → 读共享发现表(网关捞到的群/C2C openid),供面板选择器。
 * - GET /guilds/:adapterId   → REST 枚举频道子频道(频道 scope 选择器)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQQSessionRegistry } from "../../platforms/qq-official.js";
import { createQQRoute } from "../qq.js";
import type { RouteDeps } from "../types.js";

let fetchMock: ReturnType<typeof vi.fn>;
function res(status: number, body: unknown): Response {
	return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
beforeEach(() => {
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
	vi.unstubAllGlobals();
});

function makeDeps(opts?: {
	registry?: ReturnType<typeof createQQSessionRegistry>;
	adapters?: unknown[];
}): RouteDeps {
	const adapters = opts?.adapters ?? [
		{
			id: "a1",
			platform: "qq-official",
			enabled: true,
			config: { appId: "APPID", appSecret: "SECRET", sandbox: false, botType: "public" },
		},
	];
	return {
		qqSessionRegistry: opts?.registry ?? null,
		store: { getAdapters: () => adapters },
		runtime: {
			serviceCtx: { logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } },
		},
	} as unknown as RouteDeps;
}

describe("GET /api/qq/sessions/:adapterId", () => {
	it("返回该 adapter 发现表(最近优先)", async () => {
		const registry = createQQSessionRegistry();
		registry.record("a1", { scope: "group", openid: "G1", displayHint: "群甲" }, 1000);
		registry.record("a1", { scope: "private", openid: "U1" }, 2000);
		const app = createQQRoute(makeDeps({ registry }));
		const r = await app.request("/sessions/a1");
		expect(r.status).toBe(200);
		const body = (await r.json()) as Array<Record<string, unknown>>;
		expect(body.map((e) => e.openid)).toEqual(["U1", "G1"]);
	});

	it("registry 缺省 → 空数组(不崩)", async () => {
		const app = createQQRoute(makeDeps());
		const r = await app.request("/sessions/a1");
		expect(r.status).toBe(200);
		expect(await r.json()).toEqual([]);
	});
});

describe("GET /api/qq/guilds/:adapterId", () => {
	it("枚举频道子频道(文字)", async () => {
		fetchMock.mockImplementation(async (url: string) => {
			if (url.includes("getAppAccessToken"))
				return res(200, { access_token: "TKN", expires_in: 7200 });
			if (url.endsWith("/users/@me/guilds")) return res(200, [{ id: "G1", name: "频道甲" }]);
			if (url.endsWith("/guilds/G1/channels"))
				return res(200, [{ id: "C1", name: "公告", type: 0 }]);
			return res(404, {});
		});
		const app = createQQRoute(makeDeps());
		const r = await app.request("/guilds/a1");
		expect(r.status).toBe(200);
		const body = (await r.json()) as Array<Record<string, unknown>>;
		expect(body).toHaveLength(1);
		expect(body[0]?.guildId).toBe("G1");
	});

	it("adapter 不存在 → 404", async () => {
		const app = createQQRoute(makeDeps());
		const r = await app.request("/guilds/nope");
		expect(r.status).toBe(404);
	});

	it("非 qq-official adapter → 404", async () => {
		const app = createQQRoute(
			makeDeps({ adapters: [{ id: "a1", platform: "onebot", enabled: true, config: {} }] }),
		);
		const r = await app.request("/guilds/a1");
		expect(r.status).toBe(404);
	});

	it("枚举抛错 → 502", async () => {
		fetchMock.mockImplementation(async (url: string) => {
			if (url.includes("getAppAccessToken"))
				return res(200, { access_token: "T", expires_in: 7200 });
			return res(401, {});
		});
		const app = createQQRoute(makeDeps());
		const r = await app.request("/guilds/a1");
		expect(r.status).toBe(502);
	});
});
