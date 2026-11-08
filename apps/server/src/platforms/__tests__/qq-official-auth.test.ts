import type { HttpClient, ServiceContext } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { integrationIo } from "../../__tests__/support/integration-io.js";
import { i18n } from "../../i18n/index.js";
import { createQQTokenRefresher, fetchAppAccessToken } from "../qq-official";

// 底下的 fetch 用 vi.stubGlobal mock,不打真实网络;请求客户端是真的(对齐 adapters.test.ts)。
let fetchMock: ReturnType<typeof vi.fn>;
let http: HttpClient;
beforeEach(() => {
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
	http = integrationIo().http;
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

/** 真的 `Response`:请求客户端要读头、读字节。 */
function jsonRes(body: unknown, init?: { status?: number }): Response {
	return new Response(JSON.stringify(body), { status: init?.status ?? 200 });
}

describe("fetchAppAccessToken", () => {
	it("POST bots.qq.com,带 appId/clientSecret,解析 access_token + expires_in", async () => {
		fetchMock.mockResolvedValueOnce(jsonRes({ access_token: "TKN", expires_in: 7200 }));
		const r = await fetchAppAccessToken(http, "app1", "secret1");
		expect(r).toEqual({ token: "TKN", expiresInSec: 7200 });
		const call = fetchMock.mock.calls[0];
		if (!call) throw new Error("expected a fetch call");
		expect(String(call[0])).toBe("https://bots.qq.com/app/getAppAccessToken");
		expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
			appId: "app1",
			clientSecret: "secret1",
		});
	});

	it("线上只带内容类型一个头:不带浏览器身份、不带 Cookie", async () => {
		fetchMock.mockResolvedValueOnce(jsonRes({ access_token: "TKN", expires_in: 7200 }));
		await fetchAppAccessToken(http, "app1", "secret1");
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(Object.fromEntries(new Headers(init.headers))).toEqual({
			"content-type": "application/json",
		});
	});

	it("HTTP 非 2xx → 抛错", async () => {
		fetchMock.mockResolvedValueOnce(jsonRes({}, { status: 401 }));
		await expect(fetchAppAccessToken(http, "a", "s")).rejects.toThrow(/HTTP 401/);
	});

	it("响应缺 access_token → 抛错", async () => {
		fetchMock.mockResolvedValueOnce(jsonRes({ expires_in: 7200 }));
		await expect(fetchAppAccessToken(http, "a", "s")).rejects.toThrow(/access_token/);
	});

	it("expires_in 缺失/非法 → 默认 7200", async () => {
		fetchMock.mockResolvedValueOnce(jsonRes({ access_token: "T" }));
		expect((await fetchAppAccessToken(http, "a", "s")).expiresInSec).toBe(7200);
	});

	it("连不上 → 抛错(话里带底层原因)", async () => {
		fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
		await expect(fetchAppAccessToken(http, "a", "s")).rejects.toThrow(/fetch failed/);
	});

	it("回应慢于客户端默认的 20 秒仍等得到(显式 300 秒的超时只为保住今天没有超时的行为)", async () => {
		vi.useFakeTimers();
		fetchMock.mockImplementation(
			(_url: URL, init: RequestInit) =>
				new Promise((resolve, reject) => {
					const timer = setTimeout(
						() => resolve(jsonRes({ access_token: "SLOW", expires_in: 7200 })),
						30_000,
					);
					(init.signal as AbortSignal).addEventListener("abort", () => {
						clearTimeout(timer);
						reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
					});
				}),
		);
		const pending = fetchAppAccessToken(http, "a", "s");
		await vi.advanceTimersByTimeAsync(30_000);
		expect(await pending).toEqual({ token: "SLOW", expiresInSec: 7200 });
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
		signal: new AbortController().signal,
		track: () => {},
	};
	return { ctx, timers, logger };
}

describe("createQQTokenRefresher", () => {
	it("localizes a held closed token manager without requesting or restarting timers", async () => {
		const { ctx, timers, logger } = makeTestCtx();
		const manager = createQQTokenRefresher({
			http,
			appId: "a",
			clientSecret: "s",
			serviceCtx: ctx,
			logger,
		});
		manager.dispose();
		const previous = i18n.state();
		try {
			for (const [locale, message] of [
				["en", "QQ token manager has been closed."],
				["ja", "QQトークン管理は終了しています。"],
				["zh-TW", "QQ 權杖管理器已關閉。"],
			] as const) {
				i18n.set({ locale, voice: "plain" });
				await expect(manager.getToken()).rejects.toThrow(message);
			}
			expect(fetchMock).not.toHaveBeenCalled();
			expect(timers).toEqual([]);
		} finally {
			i18n.set(previous);
		}
	});

	it("getToken 缓存:第二次不再请求", async () => {
		fetchMock.mockImplementation(async () => jsonRes({ access_token: "T1", expires_in: 7200 }));
		const { ctx, logger } = makeTestCtx();
		const mgr = createQQTokenRefresher({
			http,
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
		fetchMock.mockImplementation(async () => jsonRes({ access_token: "T1", expires_in: 7200 }));
		const { ctx, timers, logger } = makeTestCtx();
		const mgr = createQQTokenRefresher({
			http,
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
		const mgr = createQQTokenRefresher({
			http,
			appId: "a",
			clientSecret: "s",
			serviceCtx: ctx,
			logger,
		});
		expect(await mgr.getToken()).toBe("T1");
		timers.at(-1)?.fn(); // 触发提前刷新
		expect(await mgr.getToken()).toBe("T2");
		expect(fetchMock).toHaveBeenCalledTimes(2);
		mgr.dispose();
	});

	it("首次失败不缓存 → 下次 getToken 重试", async () => {
		fetchMock
			.mockResolvedValueOnce(jsonRes({}, { status: 500 }))
			.mockResolvedValueOnce(jsonRes({ access_token: "T1", expires_in: 7200 }));
		const { ctx, logger } = makeTestCtx();
		const mgr = createQQTokenRefresher({
			http,
			appId: "a",
			clientSecret: "s",
			serviceCtx: ctx,
			logger,
		});
		await expect(mgr.getToken()).rejects.toThrow();
		expect(await mgr.getToken()).toBe("T1");
		mgr.dispose();
	});

	it("dispose 后 getToken 拒绝,且定时器已停", async () => {
		fetchMock.mockImplementation(async () => jsonRes({ access_token: "T1", expires_in: 7200 }));
		const { ctx, timers, logger } = makeTestCtx();
		const mgr = createQQTokenRefresher({
			http,
			appId: "a",
			clientSecret: "s",
			serviceCtx: ctx,
			logger,
		});
		await mgr.getToken();
		mgr.dispose();
		expect(timers.at(-1)?.disposed).toBe(true);
		await expect(mgr.getToken()).rejects.toThrow("QQ 令牌管理器已关闭。");
	});
});
