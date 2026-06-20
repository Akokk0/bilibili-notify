import type { ServiceContext } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createQQTokenManager, fetchAppAccessToken } from "../qq-official";

// fetch 用 vi.stubGlobal mock,不打真实网络(对齐 adapters.test.ts)。
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
	vi.unstubAllGlobals();
});

function jsonRes(body: unknown, init?: { ok?: boolean; status?: number }): Response {
	return {
		ok: init?.ok ?? true,
		status: init?.status ?? 200,
		json: async () => body,
	} as Response;
}

describe("fetchAppAccessToken", () => {
	it("POST bots.qq.com,带 appId/clientSecret,解析 access_token + expires_in", async () => {
		fetchMock.mockResolvedValueOnce(jsonRes({ access_token: "TKN", expires_in: 7200 }));
		const r = await fetchAppAccessToken("app1", "secret1");
		expect(r).toEqual({ token: "TKN", expiresInSec: 7200 });
		const call = fetchMock.mock.calls[0];
		expect(call?.[0]).toBe("https://bots.qq.com/app/getAppAccessToken");
		expect(JSON.parse((call?.[1] as RequestInit).body as string)).toEqual({
			appId: "app1",
			clientSecret: "secret1",
		});
	});

	it("HTTP 非 2xx → 抛错", async () => {
		fetchMock.mockResolvedValueOnce(jsonRes({}, { ok: false, status: 401 }));
		await expect(fetchAppAccessToken("a", "s")).rejects.toThrow(/HTTP 401/);
	});

	it("响应缺 access_token → 抛错", async () => {
		fetchMock.mockResolvedValueOnce(jsonRes({ expires_in: 7200 }));
		await expect(fetchAppAccessToken("a", "s")).rejects.toThrow(/access_token/);
	});

	it("expires_in 缺失/非法 → 默认 7200", async () => {
		fetchMock.mockResolvedValueOnce(jsonRes({ access_token: "T" }));
		expect((await fetchAppAccessToken("a", "s")).expiresInSec).toBe(7200);
	});
});

/** 可控 ServiceContext —— 捕获 setTimeout 的 fn/ms,手动触发,断言 dispose。 */
interface CapturedTimer {
	fn: () => void;
	ms: number;
	disposed: boolean;
}
function makeTestCtx() {
	const timers: CapturedTimer[] = [];
	const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
	const ctx: ServiceContext = {
		logger,
		setTimeout(fn, ms) {
			const t: CapturedTimer = { fn, ms, disposed: false };
			timers.push(t);
			return {
				dispose() {
					t.disposed = true;
				},
			};
		},
		setInterval() {
			return { dispose() {} };
		},
		onDispose() {},
	};
	return { ctx, timers, logger };
}

describe("createQQTokenManager", () => {
	it("getToken 缓存:第二次不再请求", async () => {
		fetchMock.mockResolvedValue(jsonRes({ access_token: "T1", expires_in: 7200 }));
		const { ctx, logger } = makeTestCtx();
		const mgr = createQQTokenManager({
			appId: "a",
			clientSecret: "s",
			serviceCtx: ctx,
			logger,
		});
		expect(await mgr.getToken()).toBe("T1");
		expect(await mgr.getToken()).toBe("T1");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		mgr.dispose();
	});

	it("按 expires_in - buffer 排提前刷新定时器", async () => {
		fetchMock.mockResolvedValue(jsonRes({ access_token: "T1", expires_in: 7200 }));
		const { ctx, timers, logger } = makeTestCtx();
		const mgr = createQQTokenManager({
			appId: "a",
			clientSecret: "s",
			serviceCtx: ctx,
			logger,
			refreshBufferSec: 40,
		});
		await mgr.getToken();
		expect(timers.at(-1)?.ms).toBe((7200 - 40) * 1000);
		mgr.dispose();
	});

	it("刷新定时器触发 → 重新获取并更新缓存 token", async () => {
		fetchMock
			.mockResolvedValueOnce(jsonRes({ access_token: "T1", expires_in: 7200 }))
			.mockResolvedValueOnce(jsonRes({ access_token: "T2", expires_in: 7200 }));
		const { ctx, timers, logger } = makeTestCtx();
		const mgr = createQQTokenManager({ appId: "a", clientSecret: "s", serviceCtx: ctx, logger });
		expect(await mgr.getToken()).toBe("T1");
		timers.at(-1)?.fn(); // 触发提前刷新
		expect(await mgr.getToken()).toBe("T2");
		expect(fetchMock).toHaveBeenCalledTimes(2);
		mgr.dispose();
	});

	it("首次失败不缓存 → 下次 getToken 重试", async () => {
		fetchMock
			.mockResolvedValueOnce(jsonRes({}, { ok: false, status: 500 }))
			.mockResolvedValueOnce(jsonRes({ access_token: "T1", expires_in: 7200 }));
		const { ctx, logger } = makeTestCtx();
		const mgr = createQQTokenManager({ appId: "a", clientSecret: "s", serviceCtx: ctx, logger });
		await expect(mgr.getToken()).rejects.toThrow();
		expect(await mgr.getToken()).toBe("T1");
		mgr.dispose();
	});

	it("dispose 后 getToken 拒绝,且定时器已停", async () => {
		fetchMock.mockResolvedValue(jsonRes({ access_token: "T1", expires_in: 7200 }));
		const { ctx, timers, logger } = makeTestCtx();
		const mgr = createQQTokenManager({ appId: "a", clientSecret: "s", serviceCtx: ctx, logger });
		await mgr.getToken();
		mgr.dispose();
		expect(timers.at(-1)?.disposed).toBe(true);
		await expect(mgr.getToken()).rejects.toThrow(/disposed/);
	});
});
