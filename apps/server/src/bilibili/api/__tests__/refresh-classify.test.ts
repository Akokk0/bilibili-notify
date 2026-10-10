/**
 * 回归守护 — P1 / ②3+②4:刷新失败码判别式 + loadCookies 损坏 JSON 容错。
 *
 * 不变量 1(②4 判别式):`-352/-403` = 风控/限流 = **非会话终态**(必须
 * "risk-control",绝不 "terminal" —— 否则瞬时风控被误升级为被动登出);
 * `-101` 及其它非 0 = "terminal";`0` = "ok"。这条决定 ②3 的终态清理只在
 * 真终态触发(dispose timer + 清 loginInfoLoaded + auth-lost)。
 *
 * 不变量 2:loadCookies 拿到损坏 cookiesJson 不得 reject 裸 SyntaxError 把
 * 整条启动链带崩;记 error 后按未登录继续。
 *
 * 复发点:有人把 -352 改回 terminal、或把 JSON.parse 的 try/catch 去掉。
 */

import type { Logger, ServiceContext } from "@bilibili-notify/internal";
import type { CookieData } from "@bilibili-notify/storage";
import { describe, expect, it, vi } from "vite-plus/test";
import { classifyRefreshCode } from "../api";
import { makeApi } from "./support/make-api";

describe("classifyRefreshCode — ②4 判别式", () => {
	it("0 → ok", () => {
		expect(classifyRefreshCode(0)).toBe("ok");
	});
	it("-352 / -403 → risk-control(风控,非终态)", () => {
		expect(classifyRefreshCode(-352)).toBe("risk-control");
		expect(classifyRefreshCode(-403)).toBe("risk-control");
	});
	it("-101 及其它非0 → terminal(会话不可恢复)", () => {
		expect(classifyRefreshCode(-101)).toBe("terminal");
		expect(classifyRefreshCode(-111)).toBe("terminal");
		expect(classifyRefreshCode(86038)).toBe("terminal");
	});
});

function makeCtx(): { ctx: ServiceContext; logger: Logger; tracked: Promise<unknown>[] } {
	const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
	/** 交进 `track` 的后台活(切片 ③)。 */
	const tracked: Promise<unknown>[] = [];
	const ctx: ServiceContext = {
		logger,
		setInterval: () => ({ dispose: vi.fn() }),
		setTimeout: () => ({ dispose: vi.fn() }),
		onDispose: () => undefined,
		signal: new AbortController().signal,
		track: (task) => {
			tracked.push(task);
		},
	};
	return { ctx, logger, tracked };
}

describe("loadCookies — 损坏 JSON 不崩启动链 (P1)", () => {
	it("非法 JSON → 不抛、记 error、保持未登录", async () => {
		const { ctx, logger } = makeCtx();
		const api = makeApi({ serviceCtx: ctx }).api;
		await expect(
			api.loadCookies({ cookiesJson: "{not-json" } as unknown as CookieData),
		).resolves.toBeUndefined();
		expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("解析失败"));
		expect(api.isLoginInfoLoaded()).toBe(false);
	});

	it("合法 JSON 但非数组 → 同样安全降级", async () => {
		const { ctx, logger } = makeCtx();
		const api = makeApi({ serviceCtx: ctx }).api;
		await expect(
			api.loadCookies({ cookiesJson: '{"a":1}' } as unknown as CookieData),
		).resolves.toBeUndefined();
		expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("解析失败"));
		expect(api.isLoginInfoLoaded()).toBe(false);
	});
});

describe("stop — 作废在途的 cookie 刷新", () => {
	it("stop 之后,在途那轮等到回应也不再往下刷(关停返回后不许再回写 cookie)", async () => {
		const { ctx } = makeCtx();
		const api = makeApi({ serviceCtx: ctx }).api;
		let answer!: (info: unknown) => void;
		vi.spyOn(
			api as unknown as { fetchCookieInfo: () => Promise<unknown> },
			"fetchCookieInfo",
		).mockReturnValue(new Promise((resolve) => (answer = resolve)));
		const importKey = vi.spyOn(globalThis.crypto.subtle, "importKey");

		const running = api.checkIfTokenNeedRefresh("refresh-token", "csrf");
		api.stop();
		answer({ code: 0, data: { refresh: true, timestamp: Date.now() } });
		await running;

		// 刷新链的下一步就是拿公钥算 correspond path;走到这里说明这轮没被作废。
		expect(importKey).not.toHaveBeenCalled();
		importKey.mockRestore();
	});
});

/**
 * ⑭a 起 cookie 罐只有一个、换号时原地换(`load()` / `clear()`),客户端也一直是同一个。刷新链里每跨一次 await 都要
 * 比对 gen —— 漏一处,换号之后这条旧链还会接着发请求:带的是新号的 cookie,回来的 `Set-Cookie` 会被当成新会话的收进罐子
 * (请求是换号之后才发的,罐子的换号计数对得上,`HttpClient` 的在途守卫挡不住)。从前每次换号都重建罐子与客户端,旧链手里
 * 握着旧罐子,这个缺口不咬人。
 */
describe("刷新链跨 await 之后都比对 gen —— 换号以后旧链不再发请求", () => {
	type Client = {
		get: (url: string) => Promise<unknown>;
		postForm: (url: string, body: Record<string, string>) => Promise<unknown>;
	};
	function startChain() {
		const { ctx } = makeCtx();
		const api = makeApi({ serviceCtx: ctx }).api;
		vi.spyOn(
			api as unknown as { fetchCookieInfo: () => Promise<unknown> },
			"fetchCookieInfo",
		).mockResolvedValue({ code: 0, data: { refresh: true, timestamp: Date.now() } });
		const client = (api as unknown as { client: Client }).client;
		return { api, client };
	}

	it("加密那几步期间会话被清掉 → 不再去取 correspond 页", async () => {
		const { api, client } = startChain();
		const realEncrypt = globalThis.crypto.subtle.encrypt.bind(globalThis.crypto.subtle);
		const encrypt = vi
			.spyOn(globalThis.crypto.subtle, "encrypt")
			.mockImplementation(async (...args: Parameters<typeof realEncrypt>) => {
				await api.clearCookies();
				return realEncrypt(...args);
			});
		const get = vi.spyOn(client, "get").mockResolvedValue('<div id="1-name">rc</div>');
		const postForm = vi.spyOn(client, "postForm").mockResolvedValue({ code: 0, data: {} });

		await api.checkIfTokenNeedRefresh("refresh-token", "csrf").catch(() => {});

		expect(encrypt).toHaveBeenCalled();
		expect(get).not.toHaveBeenCalled();
		expect(postForm).not.toHaveBeenCalled();
		encrypt.mockRestore();
	});

	it("取 correspond 页期间会话被清掉 → 不再发刷新请求", async () => {
		const { api, client } = startChain();
		const get = vi.spyOn(client, "get").mockImplementation(async () => {
			await api.clearCookies();
			return '<div id="1-name">rc</div>';
		});
		const postForm = vi.spyOn(client, "postForm").mockResolvedValue({ code: 0, data: {} });

		await api.checkIfTokenNeedRefresh("refresh-token", "csrf").catch(() => {});

		expect(get).toHaveBeenCalledTimes(1);
		expect(postForm).not.toHaveBeenCalled();
	});
});

/**
 * 关停(切片 ③)。加载 cookie 与每小时的定时器都会发起一轮刷新检查 —— 刷新链最后一步把新 cookie 落到
 * secrets/cookies.json(`onCookiesRefreshed`)。发出去不管的话,关停对它一无所知,cookie 写道关门时
 * 它可能还没落完;登记进 `ctx.track()`,关停才等得到它。
 */
describe("triggerRefreshCheck — 登记进 track", () => {
	const COOKIES = JSON.stringify([
		{ key: "SESSDATA", value: "s", domain: ".bilibili.com", path: "/", secure: true },
		{ key: "bili_jct", value: "csrf", domain: ".bilibili.com", path: "/", secure: true },
	]);

	it("加载 cookie 发起的那轮刷新登记进 track:刷新链走完它才落定", async () => {
		const { ctx, tracked } = makeCtx();
		const api = makeApi({ serviceCtx: ctx }).api;
		let finish!: () => void;
		const running = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const check = vi.spyOn(api, "checkIfTokenNeedRefresh").mockReturnValue(running);

		await api.loadCookies({ cookiesJson: COOKIES, refreshToken: "rt" } as unknown as CookieData);

		expect(check).toHaveBeenCalledTimes(1);
		expect(tracked).toHaveLength(1);
		let settled = false;
		void tracked[0]?.then(() => {
			settled = true;
		});
		await new Promise((r) => setTimeout(r, 20));
		expect(settled).toBe(false);

		finish();
		await tracked[0];
		expect(settled).toBe(true);
	});

	it("刷新检查抛错:登记进去的这件事不拒,记一条 warn,并放开「已在刷新」的闸", async () => {
		const { ctx, logger, tracked } = makeCtx();
		const api = makeApi({ serviceCtx: ctx }).api;
		vi.spyOn(api, "checkIfTokenNeedRefresh").mockRejectedValue(new Error("network down"));

		await api.loadCookies({ cookiesJson: COOKIES, refreshToken: "rt" } as unknown as CookieData);

		await expect(tracked[0]).resolves.toBeUndefined();
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("network down"));
		// 闸放开了:再来一次(重新加载 cookie)照样发起新的一轮。
		await api.loadCookies({ cookiesJson: COOKIES, refreshToken: "rt" } as unknown as CookieData);
		expect(tracked).toHaveLength(2);
	});
});
