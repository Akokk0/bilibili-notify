import type { BilibiliAPI } from "@bilibili-notify/api";
import { ImageRenderer } from "@bilibili-notify/image";
import { describe, expect, it, vi } from "vite-plus/test";
import type { StandalonePuppeteer } from "../../runtime/puppeteer.js";
import { createCardsRoute, resolveRoomIdFromUid } from "../cards.js";
import type { RouteDeps } from "../types.js";

function makeDeps(): RouteDeps {
	return {
		runtime: {
			serviceCtx: {
				logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
			},
		},
		store: { bootstrap: { dataDir: "/tmp/bn-test-cards-route" } },
	} as unknown as RouteDeps;
}

/** 渲染 mock 路径用的假 puppeteer —— page().screenshot 直接吐一段假 PNG 字节。 */
function makeFakePuppeteer(): StandalonePuppeteer {
	const fakePage = {
		setContent: vi.fn(async () => {}),
		$: vi.fn(async () => ({
			boundingBox: async () => ({ x: 0, y: 0, width: 600, height: 400 }),
			dispose: async () => {},
		})),
		screenshot: vi.fn(async () => Buffer.from("fake-png-bytes")),
		close: vi.fn(async () => {}),
	};
	return { page: vi.fn(async () => fakePage) } as unknown as StandalonePuppeteer;
}

describe("cards route — detect-chrome", () => {
	it("GET /detect-chrome 返回探测到的 Chrome 路径", async () => {
		const app = createCardsRoute({
			deps: makeDeps(),
			puppeteer: null,
			api: null,
			detectChrome: () => "/usr/bin/google-chrome",
		});
		const res = await app.request("/detect-chrome");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ path: "/usr/bin/google-chrome" });
	});

	it("探测不到 Chrome → path: null", async () => {
		const app = createCardsRoute({
			deps: makeDeps(),
			puppeteer: null,
			api: null,
			detectChrome: () => null,
		});
		const res = await app.request("/detect-chrome");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ path: null });
	});
});

describe("cards route — enable-rendering", () => {
	function depsWithEngines(enableImageRendering: ReturnType<typeof vi.fn>): RouteDeps {
		return {
			runtime: {
				serviceCtx: {
					logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
				},
				engines: { enableImageRendering },
			},
		} as unknown as RouteDeps;
	}

	it("POST /enable-rendering: 构造 puppeteer + 热启用引擎 + 写回配置 + 通知", async () => {
		const fakePup = { dispose: vi.fn(async () => {}) } as unknown as StandalonePuppeteer;
		const createPuppeteer = vi.fn(() => fakePup);
		const enableImageRendering = vi.fn(() => true);
		const persistChromePath = vi.fn(async () => {});
		const onPuppeteerEnabled = vi.fn();
		const app = createCardsRoute({
			deps: depsWithEngines(enableImageRendering),
			puppeteer: null,
			api: null,
			createPuppeteer,
			persistChromePath,
			onPuppeteerEnabled,
		});
		const res = await app.request("/enable-rendering", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ chromePath: "/usr/bin/google-chrome" }),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ ok: true });
		expect(createPuppeteer).toHaveBeenCalledWith("/usr/bin/google-chrome");
		expect(enableImageRendering).toHaveBeenCalledWith(fakePup);
		expect(persistChromePath).toHaveBeenCalledWith("/usr/bin/google-chrome");
		expect(onPuppeteerEnabled).toHaveBeenCalledWith(fakePup);
	});

	it("已启用:enableImageRendering 返回 false → dispose 多余 adapter,不写回", async () => {
		const fakePup = { dispose: vi.fn(async () => {}) } as unknown as StandalonePuppeteer;
		const createPuppeteer = vi.fn(() => fakePup);
		const persistChromePath = vi.fn(async () => {});
		const app = createCardsRoute({
			deps: depsWithEngines(vi.fn(() => false)),
			puppeteer: null,
			api: null,
			createPuppeteer,
			persistChromePath,
		});
		const res = await app.request("/enable-rendering", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ chromePath: "/usr/bin/google-chrome" }),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ ok: true, alreadyEnabled: true });
		expect(fakePup.dispose).toHaveBeenCalled();
		expect(persistChromePath).not.toHaveBeenCalled();
	});

	it("body 缺 chromePath → 400,不构造 puppeteer", async () => {
		const createPuppeteer = vi.fn();
		const app = createCardsRoute({
			deps: depsWithEngines(vi.fn()),
			puppeteer: null,
			api: null,
			createPuppeteer,
		});
		const res = await app.request("/enable-rendering", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		expect(createPuppeteer).not.toHaveBeenCalled();
	});

	it("engines 未就绪 → 503", async () => {
		const deps = {
			runtime: {
				serviceCtx: {
					logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
				},
				engines: null,
			},
		} as unknown as RouteDeps;
		const app = createCardsRoute({ deps, puppeteer: null, api: null });
		const res = await app.request("/enable-rendering", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ chromePath: "/x" }),
		});
		expect(res.status).toBe(503);
	});
});

describe("cards route — resolveRoomIdFromUid (uid → 房间号)", () => {
	it("getUserInfo 返回 live_room.roomid → 解析成房间号字符串", async () => {
		const api = {
			getUserInfo: vi.fn(async () => ({ code: 0, data: { live_room: { roomid: 778899 } } })),
		} as unknown as BilibiliAPI;
		expect(await resolveRoomIdFromUid(api, "12345")).toBe("778899");
	});

	it("非纯数字 uid → 抛错(不打接口)", async () => {
		const getUserInfo = vi.fn();
		const api = { getUserInfo } as unknown as BilibiliAPI;
		await expect(resolveRoomIdFromUid(api, "abc")).rejects.toThrow();
		expect(getUserInfo).not.toHaveBeenCalled();
	});

	it("未开通直播间(live_room 缺失 / roomid<=0)→ 抛错", async () => {
		const api = {
			getUserInfo: vi.fn(async () => ({ code: 0, data: { live_room: { roomid: 0 } } })),
		} as unknown as BilibiliAPI;
		await expect(resolveRoomIdFromUid(api, "12345")).rejects.toThrow(/未开通直播间|无法解析/);
	});
});

describe("cards route — /preview live-by-uid fallback", () => {
	const STYLE = { cardColorStart: "#111111", cardColorEnd: "#ffffff" };

	function postPreview(app: ReturnType<typeof createCardsRoute>, body: unknown) {
		return app.request("/preview", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	it("fallback:true 且真实拉取失败 → 回退示例数据,200 ok", async () => {
		// getUserInfo 抛错(网络) → live 真实路径失败 → fallback 回退 mock 渲染。
		const api = {
			getUserInfo: vi.fn(async () => {
				throw new Error("network down");
			}),
		} as unknown as BilibiliAPI;
		const app = createCardsRoute({ deps: makeDeps(), puppeteer: makeFakePuppeteer(), api });
		const res = await postPreview(app, {
			kind: "live",
			style: STYLE,
			content: { uid: "12345" },
			fallback: true,
		});
		expect(res.status).toBe(200);
		const json = (await res.json()) as { ok: boolean; dataUrl?: string };
		expect(json.ok).toBe(true);
		expect(json.dataUrl).toMatch(/^data:image\/png;base64,/);
	});

	it("fallback 缺省(false)且真实拉取失败 → 500,把错误抛给用户", async () => {
		const api = {
			getUserInfo: vi.fn(async () => {
				throw new Error("network down");
			}),
		} as unknown as BilibiliAPI;
		const app = createCardsRoute({ deps: makeDeps(), puppeteer: makeFakePuppeteer(), api });
		const res = await postPreview(app, {
			kind: "live",
			style: STYLE,
			content: { uid: "12345" },
		});
		expect(res.status).toBe(500);
		expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
	});
});

describe("cards route — /preview sc/guard 发送者取登录账号", () => {
	const STYLE = { cardColorStart: "#111111", cardColorEnd: "#ffffff" };

	function loggedInApi(): BilibiliAPI {
		return {
			getMyselfInfo: vi.fn(async () => ({ code: 0, data: { mid: 999, uname: "登录名" } })),
			getUserCardInfo: vi.fn(async () => ({
				code: 0,
				data: { card: { name: "登录名", face: "https://i0.hdslb.com/face.png" } },
			})),
		} as unknown as BilibiliAPI;
	}

	function postPreview(app: ReturnType<typeof createCardsRoute>, body: unknown) {
		return app.request("/preview", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	it("sc:senderName=登录账号(fallback:true 的 per-UP 风格请求,与作用域无关)", async () => {
		const spy = vi
			.spyOn(ImageRenderer.prototype, "generateSCCard")
			.mockResolvedValue(Buffer.from("x"));
		const app = createCardsRoute({
			deps: makeDeps(),
			puppeteer: makeFakePuppeteer(),
			api: loggedInApi(),
		});
		const res = await postPreview(app, {
			kind: "sc",
			style: STYLE,
			content: { price: 30 },
			fallback: true,
		});
		expect(res.status).toBe(200);
		const arg = spy.mock.calls[0]?.[0] as { senderName: string };
		expect(arg.senderName).toBe("登录名");
		spy.mockRestore();
	});

	it("guard:uname=登录账号(fallback:true 的 per-UP 风格请求)", async () => {
		const spy = vi
			.spyOn(ImageRenderer.prototype, "generateGuardCard")
			.mockResolvedValue(Buffer.from("x"));
		const app = createCardsRoute({
			deps: makeDeps(),
			puppeteer: makeFakePuppeteer(),
			api: loggedInApi(),
		});
		const res = await postPreview(app, {
			kind: "guard",
			style: STYLE,
			content: { level: 3 },
			fallback: true,
		});
		expect(res.status).toBe(200);
		const arg = spy.mock.calls[0]?.[0] as { uname: string };
		expect(arg.uname).toBe("登录名");
		spy.mockRestore();
	});

	it("sc:per-UP 传 uid → 接收方按 getMasterInfo 解析真实 UP,发送者仍为登录账号", async () => {
		const api = {
			getMyselfInfo: vi.fn(async () => ({ code: 0, data: { mid: 999, uname: "登录名" } })),
			getUserCardInfo: vi.fn(async () => ({
				code: 0,
				data: { card: { name: "登录名", face: "https://i0.hdslb.com/face.png" } },
			})),
			getMasterInfo: vi.fn(async () => ({
				code: 0,
				data: { info: { uname: "真实UP", face: "https://i0.hdslb.com/up.png" } },
			})),
		} as unknown as BilibiliAPI;
		const spy = vi
			.spyOn(ImageRenderer.prototype, "generateSCCard")
			.mockResolvedValue(Buffer.from("x"));
		const app = createCardsRoute({ deps: makeDeps(), puppeteer: makeFakePuppeteer(), api });
		const res = await postPreview(app, {
			kind: "sc",
			style: STYLE,
			content: { uid: "12345", price: 30 },
			fallback: true,
		});
		expect(res.status).toBe(200);
		const arg = spy.mock.calls[0]?.[0] as { senderName: string; masterName: string };
		expect(arg.masterName).toBe("真实UP");
		expect(arg.senderName).toBe("登录名");
		spy.mockRestore();
	});

	it("sc:接收方 getMasterInfo 失败 + fallback → 回退示例 UP,200", async () => {
		const api = {
			getMyselfInfo: vi.fn(async () => ({ code: 0, data: { mid: 999, uname: "登录名" } })),
			getUserCardInfo: vi.fn(async () => ({
				code: 0,
				data: { card: { name: "登录名", face: "https://i0.hdslb.com/face.png" } },
			})),
			getMasterInfo: vi.fn(async () => {
				throw new Error("network");
			}),
		} as unknown as BilibiliAPI;
		const spy = vi
			.spyOn(ImageRenderer.prototype, "generateSCCard")
			.mockResolvedValue(Buffer.from("x"));
		const app = createCardsRoute({ deps: makeDeps(), puppeteer: makeFakePuppeteer(), api });
		const res = await postPreview(app, {
			kind: "sc",
			style: STYLE,
			content: { uid: "12345", price: 30 },
			fallback: true,
		});
		expect(res.status).toBe(200);
		const arg = spy.mock.calls[0]?.[0] as { masterName: string };
		expect(arg.masterName).toBe("示例 UP 主");
		spy.mockRestore();
	});

	it("登录解析瞬时失败 → 沿用上次成功快照,发送者不闪回示例(stale-while-error)", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		// 第一次成功解析 → 缓存;第二次 getMyselfInfo 抛错(模拟瞬时失败)。
		const getMyselfInfo = vi
			.fn()
			.mockResolvedValueOnce({ code: 0, data: { mid: 999, uname: "登录名" } })
			.mockRejectedValue(new Error("network"));
		const getUserCardInfo = vi.fn(async () => ({
			code: 0,
			data: { card: { name: "登录名", face: "https://i0.hdslb.com/face.png" } },
		}));
		const api = { getMyselfInfo, getUserCardInfo } as unknown as BilibiliAPI;
		const spy = vi
			.spyOn(ImageRenderer.prototype, "generateSCCard")
			.mockResolvedValue(Buffer.from("x"));
		const app = createCardsRoute({
			deps: makeDeps(),
			puppeteer: makeFakePuppeteer(),
			api,
		});

		await postPreview(app, { kind: "sc", style: STYLE, content: { price: 30 } });
		// 跨过 5 分钟 TTL,迫使第二次重新解析 → getMyselfInfo 抛错 → 走 stale-while-error。
		vi.setSystemTime(new Date("2026-01-01T00:06:00Z"));
		await postPreview(app, { kind: "sc", style: STYLE, content: { price: 30 } });

		const lastArg = spy.mock.calls.at(-1)?.[0] as { senderName: string };
		expect(lastArg.senderName).toBe("登录名"); // 没有闪回「示例粉丝」
		expect(getMyselfInfo).toHaveBeenCalledTimes(2); // 确实重试了第二次(并失败)
		spy.mockRestore();
		vi.useRealTimers();
	});
});
