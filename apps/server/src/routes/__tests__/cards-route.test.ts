import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BilibiliAPI } from "@bilibili-notify/api";
import { ImageRenderer } from "@bilibili-notify/image";
import { describe, expect, it, vi } from "vite-plus/test";
import { listCardBg, saveCardBg } from "../../runtime/card-assets.js";
import type { StandalonePuppeteer } from "../../runtime/puppeteer.js";
import { createCardsRoute, resolveRoomIdFromUid, testPushCaption } from "../cards.js";
import type { RouteDeps } from "../types.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function depsWithDataDir(dataDir: string): RouteDeps {
	return {
		runtime: {
			serviceCtx: {
				logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
			},
		},
		store: { bootstrap: { dataDir } },
	} as unknown as RouteDeps;
}

function makeDeps(): RouteDeps {
	return {
		runtime: {
			serviceCtx: {
				logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
			},
		},
		// 这些用例只打 /detect-chrome 与 /preview(无背景图),dataDir 从不真正落 fs。
		// 用 OS 临时目录下的不存在子目录(跨平台:不硬编码 POSIX /tmp,无真实路径/密钥)。
		store: { bootstrap: { dataDir: join(tmpdir(), "bn-test-cards-route-no-such-dir") } },
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

describe("cards route — 图廊列表 GET /assets", () => {
	it("返回图廊里所有已传背景图 id", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bn-gallery-"));
		try {
			const id1 = await saveCardBg(dir, PNG, "image/png");
			const id2 = await saveCardBg(dir, PNG, "image/webp");
			const app = createCardsRoute({ deps: depsWithDataDir(dir), puppeteer: null, api: null });
			const res = await app.request("/assets");
			expect(res.status).toBe(200);
			const json = (await res.json()) as { ok: boolean; ids: string[] };
			expect(json.ok).toBe(true);
			expect(new Set(json.ids)).toEqual(new Set([id1, id2]));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("cards route — 图廊删除 DELETE /asset/:id", () => {
	function depsWithStore(opts: {
		dataDir: string;
		globalBg?: string[];
		/** 全局某 per-kind 样式(sc)的背景列表 —— 验证删除引用检查覆盖 cardStyleByKind。 */
		globalKindBg?: string[];
		/** 全局直播封面列表(liveCoverImages)—— 验证删除引用检查覆盖封面引用。 */
		globalCover?: string[];
		subs?: Array<{ uid: string; bg?: string[]; kindBg?: string[]; cover?: string[] }>;
	}): RouteDeps {
		return {
			runtime: {
				serviceCtx: {
					logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
				},
			},
			store: {
				bootstrap: { dataDir: opts.dataDir },
				getGlobals: () => ({
					defaults: {
						cardStyle: {
							backgroundImages: opts.globalBg ?? [],
							liveCoverImages: opts.globalCover ?? [],
						},
						cardStyleByKind: opts.globalKindBg
							? { sc: { backgroundImages: opts.globalKindBg } }
							: {},
					},
				}),
				getSubscriptions: () =>
					(opts.subs ?? []).map((s) => ({
						uid: s.uid,
						overrides: {
							cardStyle:
								s.bg || s.cover ? { backgroundImages: s.bg, liveCoverImages: s.cover } : undefined,
							cardStyleByKind: s.kindBg ? { guard: { backgroundImages: s.kindBg } } : undefined,
						},
					})),
			},
		} as unknown as RouteDeps;
	}

	it("删除未被引用的背景图 → 200,文件移除", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bn-del-route-"));
		try {
			const id = await saveCardBg(dir, PNG, "image/png");
			const app = createCardsRoute({
				deps: depsWithStore({ dataDir: dir }),
				puppeteer: null,
				api: null,
			});
			const res = await app.request(`/asset/${id}`, { method: "DELETE" });
			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({ ok: true });
			expect(await listCardBg(dir)).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("删除仅被全局 liveCoverImages(直播封面)引用的图 → 409 拦截", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bn-del-cover-"));
		try {
			const id = await saveCardBg(dir, PNG, "image/png");
			const app = createCardsRoute({
				deps: depsWithStore({ dataDir: dir, globalCover: [id] }),
				puppeteer: null,
				api: null,
			});
			const res = await app.request(`/asset/${id}`, { method: "DELETE" });
			expect(res.status).toBe(409);
			expect(await listCardBg(dir)).toEqual([id]); // 仍在盘上
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("删除被某 UP liveCoverImages 引用的图 → 409,referencedBy 指出该 UP", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bn-del-cover-up-"));
		try {
			const id = await saveCardBg(dir, PNG, "image/png");
			const app = createCardsRoute({
				deps: depsWithStore({ dataDir: dir, subs: [{ uid: "30303", cover: [id] }] }),
				puppeteer: null,
				api: null,
			});
			const res = await app.request(`/asset/${id}`, { method: "DELETE" });
			expect(res.status).toBe(409);
			const json = (await res.json()) as { referencedBy?: string[] };
			expect(json.referencedBy?.some((s) => s.includes("30303"))).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("删除被全局引用的背景图 → 409 拦截,文件保留", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bn-del-ref-"));
		try {
			const id = await saveCardBg(dir, PNG, "image/png");
			const app = createCardsRoute({
				deps: depsWithStore({ dataDir: dir, globalBg: [id] }),
				puppeteer: null,
				api: null,
			});
			const res = await app.request(`/asset/${id}`, { method: "DELETE" });
			expect(res.status).toBe(409);
			expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: false });
			expect(await listCardBg(dir)).toEqual([id]); // 仍在盘上
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("删除被某 UP 覆盖引用的背景图 → 409,referencedBy 指出该 UP", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bn-del-ref-up-"));
		try {
			const id = await saveCardBg(dir, PNG, "image/png");
			const app = createCardsRoute({
				deps: depsWithStore({ dataDir: dir, subs: [{ uid: "10086", bg: [id] }] }),
				puppeteer: null,
				api: null,
			});
			const res = await app.request(`/asset/${id}`, { method: "DELETE" });
			expect(res.status).toBe(409);
			const json = (await res.json()) as { ok: boolean; referencedBy?: string[] };
			expect(json.referencedBy?.some((s) => s.includes("10086"))).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("删除仅被全局 per-kind 样式引用的背景图 → 409(覆盖 cardStyleByKind)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bn-del-kind-"));
		try {
			const id = await saveCardBg(dir, PNG, "image/png");
			const app = createCardsRoute({
				deps: depsWithStore({ dataDir: dir, globalKindBg: [id] }),
				puppeteer: null,
				api: null,
			});
			const res = await app.request(`/asset/${id}`, { method: "DELETE" });
			expect(res.status).toBe(409);
			expect(await listCardBg(dir)).toEqual([id]); // 仍在盘上
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("删除仅被某 UP 的 per-kind 样式引用的背景图 → 409,referencedBy 指出该 UP", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bn-del-kind-up-"));
		try {
			const id = await saveCardBg(dir, PNG, "image/png");
			const app = createCardsRoute({
				deps: depsWithStore({ dataDir: dir, subs: [{ uid: "20020", kindBg: [id] }] }),
				puppeteer: null,
				api: null,
			});
			const res = await app.request(`/asset/${id}`, { method: "DELETE" });
			expect(res.status).toBe(409);
			const json = (await res.json()) as { referencedBy?: string[] };
			expect(json.referencedBy?.some((s) => s.includes("20020"))).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("删除非法 id → 400", async () => {
		const app = createCardsRoute({
			deps: depsWithStore({ dataDir: join(tmpdir(), "bn-x-no-such-dir") }),
			puppeteer: null,
			api: null,
		});
		const res = await app.request("/asset/..%2f..%2fsecrets.json", { method: "DELETE" });
		expect(res.status).toBe(400);
	});
});

describe("cards route — testPushCaption(测试推送图说)", () => {
	it("每种卡片类型 → 带「测试推送」前缀 + 该类型中文标签的文案", () => {
		expect(testPushCaption("live")).toContain("开播");
		expect(testPushCaption("dyn")).toContain("动态");
		expect(testPushCaption("sc")).toContain("醒目留言");
		expect(testPushCaption("guard")).toContain("上舰");
		for (const k of ["live", "dyn", "sc", "guard"] as const) {
			// 非空且带前缀 —— 顶替 QQ 富媒体空 content 的占位空格,接收方一眼知是测试。
			expect(testPushCaption(k)).toContain("测试推送");
			expect(testPushCaption(k).trim().length).toBeGreaterThan(0);
		}
	});
});

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
	function depsWithEngines(
		enableImageRendering: ReturnType<typeof vi.fn>,
		swapImageRendering: ReturnType<typeof vi.fn> = vi.fn(),
	): RouteDeps {
		return {
			runtime: {
				serviceCtx: {
					logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
				},
				engines: { enableImageRendering, swapImageRendering },
			},
		} as unknown as RouteDeps;
	}

	it("POST /enable-rendering: 构造 puppeteer + 热启用引擎 + 写回配置 + 通知", async () => {
		const fakePup = { dispose: vi.fn(async () => {}) } as unknown as StandalonePuppeteer;
		const createPuppeteer = vi.fn(() => fakePup);
		const enableImageRendering = vi.fn(() => true);
		const persistChromeSource = vi.fn(async () => {});
		const onPuppeteerEnabled = vi.fn();
		const app = createCardsRoute({
			deps: depsWithEngines(enableImageRendering),
			puppeteer: null,
			api: null,
			createPuppeteer,
			persistChromeSource,
			onPuppeteerEnabled,
		});
		const res = await app.request("/enable-rendering", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ chromePath: "/usr/bin/google-chrome" }),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ ok: true });
		expect(createPuppeteer).toHaveBeenCalledWith({ chromePath: "/usr/bin/google-chrome" });
		expect(enableImageRendering).toHaveBeenCalledWith(fakePup);
		expect(persistChromeSource).toHaveBeenCalledWith({ chromePath: "/usr/bin/google-chrome" });
		expect(onPuppeteerEnabled).toHaveBeenCalledWith(fakePup);
	});

	it("POST /enable-rendering with chromeEndpoint: 先探测连通,再热启用 + 写回", async () => {
		const probePage = { close: vi.fn(async () => {}) };
		const fakePup = {
			page: vi.fn(async () => probePage),
			dispose: vi.fn(async () => {}),
		} as unknown as StandalonePuppeteer;
		const createPuppeteer = vi.fn(() => fakePup);
		const enableImageRendering = vi.fn(() => true);
		const persistChromeSource = vi.fn(async () => {});
		const onPuppeteerEnabled = vi.fn();
		const app = createCardsRoute({
			deps: depsWithEngines(enableImageRendering),
			puppeteer: null,
			api: null,
			createPuppeteer,
			persistChromeSource,
			onPuppeteerEnabled,
		});
		const res = await app.request("/enable-rendering", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ chromeEndpoint: "ws://browser:3000" }),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ ok: true, chromeEndpoint: "ws://browser:3000" });
		expect(createPuppeteer).toHaveBeenCalledWith({ chromeEndpoint: "ws://browser:3000" });
		// 远程端点没有 detect-chrome 那样的预验,必须真开一页确认连得上才算启用成功。
		expect(fakePup.page).toHaveBeenCalledTimes(1);
		expect(probePage.close).toHaveBeenCalledTimes(1);
		expect(enableImageRendering).toHaveBeenCalledWith(fakePup);
		expect(persistChromeSource).toHaveBeenCalledWith({ chromeEndpoint: "ws://browser:3000" });
		expect(onPuppeteerEnabled).toHaveBeenCalledWith(fakePup);
	});

	it("chromeEndpoint 探测失败 → 502,dispose,不启用不写回", async () => {
		const fakePup = {
			page: vi.fn(async () => {
				throw new Error("connect ECONNREFUSED browser:3000");
			}),
			dispose: vi.fn(async () => {}),
		} as unknown as StandalonePuppeteer;
		const createPuppeteer = vi.fn(() => fakePup);
		const enableImageRendering = vi.fn(() => true);
		const persistChromeSource = vi.fn(async () => {});
		const app = createCardsRoute({
			deps: depsWithEngines(enableImageRendering),
			puppeteer: null,
			api: null,
			createPuppeteer,
			persistChromeSource,
		});
		const res = await app.request("/enable-rendering", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ chromeEndpoint: "ws://browser:3000" }),
		});
		expect(res.status).toBe(502);
		const body = (await res.json()) as { ok: boolean; err?: string };
		expect(body.ok).toBe(false);
		expect(body.err).toMatch(/ECONNREFUSED/);
		expect(enableImageRendering).not.toHaveBeenCalled();
		expect(persistChromeSource).not.toHaveBeenCalled();
		expect(fakePup.dispose).toHaveBeenCalled();
	});

	it("已启用后换来源(本地→远程):探测新 adapter → swap → dispose 旧 → 写回", async () => {
		const oldPup = { dispose: vi.fn(async () => {}) } as unknown as StandalonePuppeteer;
		const probePage = { close: vi.fn(async () => {}) };
		const newPup = {
			page: vi.fn(async () => probePage),
			dispose: vi.fn(async () => {}),
		} as unknown as StandalonePuppeteer;
		const createPuppeteer = vi.fn(() => newPup);
		const enableImageRendering = vi.fn(() => false);
		const swapImageRendering = vi.fn();
		const persistChromeSource = vi.fn(async () => {});
		const onPuppeteerEnabled = vi.fn();
		const app = createCardsRoute({
			deps: depsWithEngines(enableImageRendering, swapImageRendering),
			puppeteer: oldPup,
			initialChromeSource: { chromePath: "/usr/bin/chromium" },
			api: null,
			createPuppeteer,
			persistChromeSource,
			onPuppeteerEnabled,
		});
		const res = await app.request("/enable-rendering", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ chromeEndpoint: "ws://browser:3000" }),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ ok: true, chromeEndpoint: "ws://browser:3000" });
		// 替换在用的渲染器前必须先验新浏览器可用,别把好配置换成坏的。
		expect(newPup.page).toHaveBeenCalledTimes(1);
		expect(swapImageRendering).toHaveBeenCalledWith(newPup);
		expect(enableImageRendering).not.toHaveBeenCalled();
		expect(oldPup.dispose).toHaveBeenCalledTimes(1);
		expect(persistChromeSource).toHaveBeenCalledWith({ chromeEndpoint: "ws://browser:3000" });
		expect(onPuppeteerEnabled).toHaveBeenCalledWith(newPup);
		// GET /render-source 反映切换后的来源。
		const status = await app.request("/render-source");
		expect(await status.json()).toEqual({
			enabled: true,
			source: { chromeEndpoint: "ws://browser:3000" },
			persistable: true,
		});
	});

	it("已启用后换本地路径:同样先探测(launch 一次)再 swap", async () => {
		const oldPup = { dispose: vi.fn(async () => {}) } as unknown as StandalonePuppeteer;
		const probePage = { close: vi.fn(async () => {}) };
		const newPup = {
			page: vi.fn(async () => probePage),
			dispose: vi.fn(async () => {}),
		} as unknown as StandalonePuppeteer;
		const swapImageRendering = vi.fn();
		const app = createCardsRoute({
			deps: depsWithEngines(
				vi.fn(() => false),
				swapImageRendering,
			),
			puppeteer: oldPup,
			initialChromeSource: { chromePath: "/old/chrome" },
			api: null,
			createPuppeteer: vi.fn(() => newPup),
			persistChromeSource: vi.fn(async () => {}),
		});
		const res = await app.request("/enable-rendering", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ chromePath: "/new/chrome" }),
		});
		expect(res.status).toBe(200);
		expect(newPup.page).toHaveBeenCalledTimes(1);
		expect(swapImageRendering).toHaveBeenCalledWith(newPup);
		expect(oldPup.dispose).toHaveBeenCalledTimes(1);
	});

	it("已启用后提交相同来源 → alreadyEnabled,不构造新 adapter 不写回", async () => {
		const oldPup = { dispose: vi.fn(async () => {}) } as unknown as StandalonePuppeteer;
		const createPuppeteer = vi.fn();
		const persistChromeSource = vi.fn(async () => {});
		const app = createCardsRoute({
			deps: depsWithEngines(
				vi.fn(() => false),
				vi.fn(),
			),
			puppeteer: oldPup,
			initialChromeSource: { chromePath: "/usr/bin/chromium" },
			api: null,
			createPuppeteer,
			persistChromeSource,
		});
		const res = await app.request("/enable-rendering", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ chromePath: "/usr/bin/chromium" }),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ ok: true, alreadyEnabled: true });
		expect(createPuppeteer).not.toHaveBeenCalled();
		expect(persistChromeSource).not.toHaveBeenCalled();
		expect(oldPup.dispose).not.toHaveBeenCalled();
	});

	it("热切换持久化写盘失败:不 dispose 旧浏览器,如实报「已生效但写盘失败」", async () => {
		// 顺序契约:swap 已生效之后才 persist,写盘失败时旧浏览器故意不销毁 —— 不能
		// 出现"报切换失败,但其实新浏览器已经在用、旧的已经没了"的错觉(旧根因)。
		const oldPup = { dispose: vi.fn(async () => {}) } as unknown as StandalonePuppeteer;
		const probePage = { close: vi.fn(async () => {}) };
		const newPup = {
			page: vi.fn(async () => probePage),
			dispose: vi.fn(async () => {}),
		} as unknown as StandalonePuppeteer;
		const swapImageRendering = vi.fn();
		const persistChromeSource = vi.fn(async () => {
			throw new Error("EACCES: permission denied");
		});
		const app = createCardsRoute({
			deps: depsWithEngines(
				vi.fn(() => false),
				swapImageRendering,
			),
			puppeteer: oldPup,
			initialChromeSource: { chromePath: "/usr/bin/chromium" },
			api: null,
			createPuppeteer: vi.fn(() => newPup),
			persistChromeSource,
		});
		const res = await app.request("/enable-rendering", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ chromeEndpoint: "ws://browser:3000" }),
		});
		expect(res.status).toBe(500);
		const body = (await res.json()) as { ok: boolean; err?: string };
		expect(body.ok).toBe(false);
		expect(body.err).toMatch(/已生效/);
		expect(body.err).toContain("EACCES");
		// 切换本身(swap)已经生效——不是"报失败就当作啥都没变"。
		expect(swapImageRendering).toHaveBeenCalledWith(newPup);
		// 但旧浏览器刻意不销毁,留作"重启会退回它"的可用状态。
		expect(oldPup.dispose).not.toHaveBeenCalled();
	});

	it("GET /render-source:未启用时 enabled=false source=null;persistable 跟注入走", async () => {
		const app = createCardsRoute({
			deps: depsWithEngines(vi.fn()),
			puppeteer: null,
			api: null,
		});
		const res = await app.request("/render-source");
		expect(await res.json()).toEqual({ enabled: false, source: null, persistable: false });
	});

	it("已启用:enableImageRendering 返回 false → dispose 多余 adapter,不写回", async () => {
		const fakePup = { dispose: vi.fn(async () => {}) } as unknown as StandalonePuppeteer;
		const createPuppeteer = vi.fn(() => fakePup);
		const persistChromeSource = vi.fn(async () => {});
		const app = createCardsRoute({
			deps: depsWithEngines(vi.fn(() => false)),
			puppeteer: null,
			api: null,
			createPuppeteer,
			persistChromeSource,
		});
		const res = await app.request("/enable-rendering", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ chromePath: "/usr/bin/google-chrome" }),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ ok: true, alreadyEnabled: true });
		expect(fakePup.dispose).toHaveBeenCalled();
		expect(persistChromeSource).not.toHaveBeenCalled();
	});

	it("body 缺 chromePath 与 chromeEndpoint → 400,不构造 puppeteer", async () => {
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

describe("cards route — 热切换后预览渲染器随之失效重建", () => {
	const STYLE = { cardColorStart: "#111111", cardColorEnd: "#ffffff" };

	function depsWithEnginesAndDataDir(swapImageRendering: ReturnType<typeof vi.fn>): RouteDeps {
		return {
			runtime: {
				serviceCtx: {
					logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
				},
				engines: { enableImageRendering: vi.fn(() => false), swapImageRendering },
			},
			store: { bootstrap: { dataDir: join(tmpdir(), "bn-test-hotswap-no-such-dir") } },
		} as unknown as RouteDeps;
	}

	/** 假 puppeteer:page() 每次都返回新页面对象,screenshot() 吐带标记的字节。 */
	function makeMarkedPuppeteer(marker: string): StandalonePuppeteer & { pageCalls: number } {
		const state = { pageCalls: 0 };
		const puppeteer = {
			page: vi.fn(async () => {
				state.pageCalls++;
				return {
					setContent: vi.fn(async () => {}),
					waitForFunction: vi.fn(async () => undefined),
					$: vi.fn(async () => ({
						boundingBox: async () => ({ x: 0, y: 0, width: 600, height: 400 }),
						dispose: async () => {},
					})),
					screenshot: vi.fn(async () => Buffer.from(marker)),
					close: vi.fn(async () => {}),
				};
			}),
			dispose: vi.fn(async () => {}),
		} as unknown as StandalonePuppeteer;
		Object.defineProperty(puppeteer, "pageCalls", { get: () => state.pageCalls });
		return puppeteer as StandalonePuppeteer & { pageCalls: number };
	}

	it("热切换(/enable-rendering)后,下一次 /preview 用新 adapter 渲染,不再打到已销毁的旧 adapter", async () => {
		const pupA = makeMarkedPuppeteer("A");
		const pupB = makeMarkedPuppeteer("B");
		// pupB 的假页面对象自带 close(),/enable-rendering 里 replacing 分支的连通性
		// 探测(page().close())与之后预览渲染复用同一份 fake page,探测调用也计入
		// pupB.page 调用次数,属预期。
		const swapImageRendering = vi.fn();
		const deps = depsWithEnginesAndDataDir(swapImageRendering);
		const app = createCardsRoute({
			deps,
			puppeteer: pupA,
			initialChromeSource: { chromePath: "/old/chrome" },
			api: null,
			createPuppeteer: vi.fn(() => pupB as unknown as StandalonePuppeteer),
			persistChromeSource: vi.fn(async () => {}),
		});

		// 第一次预览:绑定 pupA 的渲染器被构造并缓存。
		const first = await app.request("/preview", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ kind: "sc", style: STYLE, content: { price: 30 } }),
		});
		expect(first.status).toBe(200);
		expect(pupA.page).toHaveBeenCalledTimes(1);

		// 热切换到 pupB —— 引擎侧的 swapImageRendering 只管推送渲染,不管路由自己缓存
		// 的预览 renderer;pupA 在这之后被 dispose,若预览渲染器缓存不失效就会打到
		// 一个已销毁的 adapter 上。
		const swap = await app.request("/enable-rendering", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ chromePath: "/new/chrome" }),
		});
		expect(swap.status).toBe(200);
		expect(swapImageRendering).toHaveBeenCalledWith(pupB);
		expect(pupA.dispose).toHaveBeenCalledTimes(1);

		// 第二次预览:必须用新 adapter(pupB)重新渲染,而不是复用绑定 pupA 的缓存实例。
		const pupBPageCallsBeforeSecondPreview = (pupB.page as ReturnType<typeof vi.fn>).mock.calls
			.length;
		const second = await app.request("/preview", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ kind: "sc", style: STYLE, content: { price: 30 } }),
		});
		expect(second.status).toBe(200);
		expect((pupB.page as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
			pupBPageCallsBeforeSecondPreview,
		);
		// pupA 没再被第二次预览调用(还是只有第一次那一次)。
		expect(pupA.page).toHaveBeenCalledTimes(1);
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

	it("mock 预览:backgroundImages 首张悬空(文件已删)→ 跳过,用第一张盘上存在的图", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bn-preview-ghost-bg-"));
		try {
			const real = await saveCardBg(dir, PNG, "image/png");
			const ghost = `${"a".repeat(32)}.png`; // 合法格式但文件不存在(悬空引用)
			const captured = { html: "" };
			const page = {
				setContent: vi.fn(async (html: string) => {
					captured.html = html;
				}),
				waitForFunction: vi.fn(async () => undefined),
				$: vi.fn(async () => ({
					boundingBox: async () => ({ x: 0, y: 0, width: 600, height: 400 }),
					dispose: async () => {},
				})),
				screenshot: vi.fn(async () => Buffer.from("png")),
				close: vi.fn(async () => {}),
			};
			const puppeteer = { page: async () => page } as unknown as StandalonePuppeteer;
			const app = createCardsRoute({ deps: depsWithDataDir(dir), puppeteer, api: null });
			const res = await postPreview(app, {
				kind: "live",
				style: { ...STYLE, backgroundImages: [ghost, real] },
			});
			expect(res.status).toBe(200);
			// 悬空首张被跳过,第二张成功内联成 data URL;老行为是取 [0] 解析失败静默回退渐变。
			expect(captured.html).toContain("data:image/png;base64,");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("mock live 预览:liveCoverImages 首张悬空 → 跳过,封面用第一张存在的图", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bn-preview-ghost-cover-"));
		try {
			const real = await saveCardBg(dir, PNG, "image/png");
			const ghost = `${"b".repeat(32)}.png`;
			const captured = { html: "" };
			const page = {
				setContent: vi.fn(async (html: string) => {
					captured.html = html;
				}),
				waitForFunction: vi.fn(async () => undefined),
				$: vi.fn(async () => ({
					boundingBox: async () => ({ x: 0, y: 0, width: 600, height: 400 }),
					dispose: async () => {},
				})),
				screenshot: vi.fn(async () => Buffer.from("png")),
				close: vi.fn(async () => {}),
			};
			const puppeteer = { page: async () => page } as unknown as StandalonePuppeteer;
			const app = createCardsRoute({ deps: depsWithDataDir(dir), puppeteer, api: null });
			const res = await postPreview(app, {
				kind: "live",
				style: { ...STYLE, liveCoverImages: [ghost, real] },
			});
			expect(res.status).toBe(200);
			expect(captured.html).toContain("data:image/png;base64,");
			expect(captured.html).not.toContain("%3ECover%3C");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("mock live 预览:style.liveCoverImages 首张解析成 data URL 注入封面", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bn-preview-cover-"));
		try {
			const id = await saveCardBg(dir, PNG, "image/png");
			// 捕获 setContent HTML 的假 puppeteer。
			const captured = { html: "" };
			const page = {
				setContent: vi.fn(async (html: string) => {
					captured.html = html;
				}),
				waitForFunction: vi.fn(async () => undefined),
				$: vi.fn(async () => ({
					boundingBox: async () => ({ x: 0, y: 0, width: 600, height: 400 }),
					dispose: async () => {},
				})),
				screenshot: vi.fn(async () => Buffer.from("png")),
				close: vi.fn(async () => {}),
			};
			const puppeteer = { page: async () => page } as unknown as StandalonePuppeteer;
			const app = createCardsRoute({ deps: depsWithDataDir(dir), puppeteer, api: null });
			const res = await postPreview(app, {
				kind: "live",
				style: { ...STYLE, liveCoverImages: [id] },
			});
			expect(res.status).toBe(200);
			// 封面被自定义图(data:image/png)替换,示例 SVG 封面不再出现。
			expect(captured.html).toContain("data:image/png;base64,");
			expect(captured.html).not.toContain("%3ECover%3C");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("cards route — /preview sc/guard 发送者取登录账号", () => {
	const STYLE = { cardColorStart: "#111111", cardColorEnd: "#ffffff" };

	function loggedInApi(): BilibiliAPI {
		return {
			getMyselfInfoCached: vi.fn(async () => ({ code: 0, data: { mid: 999, uname: "登录名" } })),
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
			getMyselfInfoCached: vi.fn(async () => ({ code: 0, data: { mid: 999, uname: "登录名" } })),
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
			getMyselfInfoCached: vi.fn(async () => ({ code: 0, data: { mid: 999, uname: "登录名" } })),
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
		// 第一次成功解析 → 缓存;第二次 getMyselfInfoCached 抛错(模拟瞬时失败)。
		const getMyselfInfoCached = vi
			.fn()
			.mockResolvedValueOnce({ code: 0, data: { mid: 999, uname: "登录名" } })
			.mockRejectedValue(new Error("network"));
		const getUserCardInfo = vi.fn(async () => ({
			code: 0,
			data: { card: { name: "登录名", face: "https://i0.hdslb.com/face.png" } },
		}));
		const api = { getMyselfInfoCached, getUserCardInfo } as unknown as BilibiliAPI;
		const spy = vi
			.spyOn(ImageRenderer.prototype, "generateSCCard")
			.mockResolvedValue(Buffer.from("x"));
		const app = createCardsRoute({
			deps: makeDeps(),
			puppeteer: makeFakePuppeteer(),
			api,
		});

		await postPreview(app, { kind: "sc", style: STYLE, content: { price: 30 } });
		// 跨过 5 分钟 TTL,迫使第二次重新解析 → getMyselfInfoCached 抛错 → 走 stale-while-error。
		vi.setSystemTime(new Date("2026-01-01T00:06:00Z"));
		await postPreview(app, { kind: "sc", style: STYLE, content: { price: 30 } });

		const lastArg = spy.mock.calls.at(-1)?.[0] as { senderName: string };
		expect(lastArg.senderName).toBe("登录名"); // 没有闪回「示例粉丝」
		expect(getMyselfInfoCached).toHaveBeenCalledTimes(2); // 确实重试了第二次(并失败)
		spy.mockRestore();
		vi.useRealTimers();
	});
});
