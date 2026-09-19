import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BilibiliAPI } from "@bilibili-notify/api";
import { ImageRenderer } from "@bilibili-notify/image";
import {
	CARD_SKIN_LIMITS,
	type CardSkinManifest,
	DEFAULT_CARD_SKIN,
	DEFAULT_CARD_SKIN_ID,
} from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { CardSkinStore } from "../../card-skins/store.js";
import { listCardBg, saveCardBg } from "../../runtime/card-assets.js";
import type { StandalonePuppeteer } from "../../runtime/puppeteer.js";
import { createCardsRoute, resolveRoomIdFromUid, testPushCaption } from "../cards.js";
import type { RouteDeps } from "../types.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 预览路由要从配置里取「这套皮肤的旋钮覆盖」,所以每个 store 替身都得有 `getGlobals`。
 * 空 defaults = 没换过皮肤、一个旋钮都没拧过。
 */
const EMPTY_GLOBALS = { defaults: { cardSkin: "default", cardSkinKnobs: {} } };

function depsWithDataDir(dataDir: string): RouteDeps {
	return {
		runtime: {
			serviceCtx: {
				logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
			},
		},
		store: { bootstrap: { dataDir }, getGlobals: () => EMPTY_GLOBALS },
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
		store: {
			bootstrap: { dataDir: join(tmpdir(), "bn-test-cards-route-no-such-dir") },
			getGlobals: () => EMPTY_GLOBALS,
		},
	} as unknown as RouteDeps;
}

/** 渲染 mock 路径用的假 puppeteer —— page().screenshot 直接吐一段假 PNG 字节。 */
/** 灌进去的 HTML 留一份 —— 「喂给 Chrome 的到底是什么」只能从这儿看。 */
const capturedHtml: string[] = [];

function makeFakePuppeteer(): StandalonePuppeteer {
	const fakePage = {
		setContent: vi.fn(async (html: string) => {
			capturedHtml.push(html);
		}),
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
		/** 皮肤旋钮那一层(2026-09-14 起背景图的正主)。 */
		knobs?: Record<string, Record<string, unknown>>;
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
						cardSkin: "default",
						cardSkinKnobs: opts.knobs ?? {},
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

	it("删除被**皮肤旋钮**引用的背景图 → 409,referencedBy 指出是哪套皮肤", async () => {
		// 2026-09-14 起壁纸的正主是旋钮。漏掉这一处是静默的:删得掉、请求成功,皮肤清单里
		// 留着一个指向空气的 id,出图静静回落渐变。
		const dir = await mkdtemp(join(tmpdir(), "bn-del-knob-"));
		try {
			const id = await saveCardBg(dir, PNG, "image/png");
			const app = createCardsRoute({
				deps: depsWithStore({ dataDir: dir, knobs: { neon: { wallpaper: [id] } } }),
				puppeteer: null,
				api: null,
			});
			const res = await app.request(`/asset/${id}`, { method: "DELETE" });
			expect(res.status).toBe(409);
			const json = (await res.json()) as { referencedBy?: string[] };
			expect(json.referencedBy?.some((s) => s.includes("neon"))).toBe(true);
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
	const STYLE = { font: "PingFang SC, sans-serif" };

	function depsWithEnginesAndDataDir(swapImageRendering: ReturnType<typeof vi.fn>): RouteDeps {
		return {
			runtime: {
				serviceCtx: {
					logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
				},
				engines: { enableImageRendering: vi.fn(() => false), swapImageRendering },
			},
			store: {
				bootstrap: { dataDir: join(tmpdir(), "bn-test-hotswap-no-such-dir") },
				getGlobals: () => EMPTY_GLOBALS,
			},
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
	const STYLE = { font: "PingFang SC, sans-serif" };

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

	/**
	 * **这一条原来钉的是「悬空首张被跳过、第二张内联进了 HTML」。** 内联那一半今天不成立了:
	 * `cardStyle.backgroundImages` 2026-09-14 退役成皮肤自己的 `image` 旋钮,而 2026-09-19
	 * 补上了 ADR-0014 决策 15 那条 🔗 的最后一步 —— `--bn-card-bg-image` **不再注**,
	 * 所以这条退役字段的值端到端**到不了卡片**了(背景图走 `--bn-knob-wallpaper`)。
	 *
	 * 「跳过悬空、取第一张存在的」那半**逻辑还在、也还有测试**,在它自己的缝上:
	 * `runtime/__tests__/card-assets.test.ts` 的 `firstExistingCardBg` 两条。这里改成钉
	 * 新的事实,免得留一条为错误的理由绿着的测试。
	 *
	 * 🔴 **顺带记下**:`firstExistingCardBg` 的产物如今喂进一条走不通的链
	 * (`routes/cards.ts` → ImageRenderer → props.backgroundImage → 无人读)。拆那条链
	 * 与整卡模板退役(决策 24 的 2026-09-18 🔗)缠在一起,是另一件事。
	 */
	it("mock 预览:退役的 backgroundImages 到不了卡片(背景图走 wallpaper 旋钮)", async () => {
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
			// 判据:把 `frameVariables` 里那句 `--bn-card-bg-image` 注入加回去,这条红。
			expect(captured.html).not.toContain("--bn-card-bg-image");
			expect(captured.html).not.toContain("data:image/png;base64,");
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

	it("live 真实数据预览(有 roomId,走 renderRealLive):liveCoverImages 首张悬空 → 跳过,不再传幽灵 id 给 renderer", async () => {
		// renderRealLive 曾漏加 firstExistingCardBg 守卫,直接把 liveCoverImages[0] 透传 ——
		// 幽灵 id 解析失败会静默回退 B 站原始封面,即便第二张图有效。这里用真实数据分支
		// (content.roomId 命中,不落 mock 兜底)验证 colorOptions.liveCoverImage 拿到的是
		// 第一张盘上存在的图,不是幽灵 id。
		const dir = await mkdtemp(join(tmpdir(), "bn-preview-real-ghost-cover-"));
		try {
			const real = await saveCardBg(dir, PNG, "image/png");
			const ghost = `${"c".repeat(32)}.png`;
			const api = {
				getLiveRoomInfo: vi.fn(async () => ({
					code: 0,
					data: { uid: 12345, live_status: 1 },
				})),
				getMasterInfo: vi.fn(async () => ({
					code: 0,
					data: { info: { uname: "真实UP", face: "https://i0.hdslb.com/up.png" } },
				})),
			} as unknown as BilibiliAPI;
			const spy = vi
				.spyOn(ImageRenderer.prototype, "generateLiveCard")
				.mockResolvedValue(Buffer.from("x"));
			const app = createCardsRoute({
				deps: depsWithDataDir(dir),
				puppeteer: makeFakePuppeteer(),
				api,
			});
			const res = await postPreview(app, {
				kind: "live",
				style: { ...STYLE, liveCoverImages: [ghost, real] },
				content: { roomId: "778899" },
			});
			expect(res.status).toBe(200);
			const colorOptions = spy.mock.calls[0]?.[5] as { liveCoverImage?: string };
			expect(colorOptions.liveCoverImage).toBe(real);
			spy.mockRestore();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("cards route — /preview sc/guard 发送者取登录账号", () => {
	const STYLE = { font: "PingFang SC, sans-serif" };

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

	/**
	 * **旋钮要到得了 SC / 上舰的预览**(ADR-0014 决策 16 的 🔗)。这两种卡的预览走
	 * `ImageRenderer`,另两种走 SSR 那条 —— 只接一条的话就是「改了颜色,直播卡预览变了、
	 * SC 卡没变」。验红:把 `getImageRenderer` 的 config 里那句 `cardSkinKnobs` 删掉。
	 */
	it("SC 预览:旋钮覆盖从配置进了渲染器的 config", async () => {
		const spy = vi
			.spyOn(ImageRenderer.prototype, "generateSCCard")
			.mockResolvedValue(Buffer.from("x"));
		const update = vi.spyOn(ImageRenderer.prototype, "updateConfig");
		const deps = makeDeps() as unknown as { store: { getGlobals: () => unknown } };
		deps.store.getGlobals = () => ({
			defaults: {
				cardSkin: "knobby",
				cardSkinKnobs: { knobby: { accent: "#00f0ff" } },
			},
		});
		const app = createCardsRoute({
			deps: deps as unknown as RouteDeps,
			puppeteer: makeFakePuppeteer(),
			api: loggedInApi(),
		});
		const body = { kind: "sc" as const, style: STYLE, content: { price: 30 }, fallback: true };
		// 第一趟构造渲染器,第二趟才走 updateConfig —— 两趟都发,拿得到那份 config。
		expect((await postPreview(app, body)).status).toBe(200);
		expect((await postPreview(app, body)).status).toBe(200);
		const cfg = update.mock.calls.at(-1)?.[0] as { cardSkinKnobs?: Record<string, unknown> };
		expect(cfg?.cardSkinKnobs).toEqual({ knobby: { accent: "#00f0ff" } });
		spy.mockRestore();
		update.mockRestore();
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

// ── 预览也走皮肤(ADR-0014 决策 15 / 22) ──────────────────────────────────────

describe("cards route — /preview 走皮肤", () => {
	const STYLE = { font: "PingFang SC, sans-serif" };

	/** 一套认得出来的皮肤:直播卡只有一个自定义块,里头写死一句标记。 */
	const MARKED: CardSkinManifest = {
		...DEFAULT_CARD_SKIN,
		name: "带标记的",
		cards: {
			...DEFAULT_CARD_SKIN.cards,
			live: {
				width: 640,
				blocks: [
					{
						id: "mark",
						kind: "custom",
						grid: { row: 1, column: 1, span: 12 },
						html: "<p>SKIN-MARK-{up.name}</p>",
					},
				],
			},
		},
	};

	/** 店的替身:只有出图那三口(读盘细节归 store 自己的测试)。 */
	function skinStore(byId: Record<string, CardSkinManifest>): CardSkinStore {
		return {
			ensureReady: async () => {},
			get: (id: string) => byId[id] ?? null,
			readAsset: async () => null,
		} as unknown as CardSkinStore;
	}

	/** 能把灌进去的 HTML 留下来的假 puppeteer。 */
	function capturingPuppeteer() {
		const captured: string[] = [];
		const page = {
			setContent: vi.fn(async (html: string) => {
				captured.push(html);
			}),
			$: vi.fn(async () => ({
				boundingBox: async () => ({ x: 0, y: 0, width: 600, height: 400 }),
				dispose: async () => {},
			})),
			screenshot: vi.fn(async () => Buffer.from("fake-png-bytes")),
			close: vi.fn(async () => {}),
		};
		return { captured, pup: { page: vi.fn(async () => page) } as unknown as StandalonePuppeteer };
	}

	function globalsDeps(activeSkin: string): RouteDeps {
		const d = makeDeps() as unknown as {
			store: { getGlobals?: () => unknown };
		};
		d.store.getGlobals = () => ({ defaults: { cardSkin: activeSkin } });
		return d as unknown as RouteDeps;
	}

	function postPreview(app: ReturnType<typeof createCardsRoute>, body: unknown) {
		return app.request("/preview", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	it("虚构 mock 那条路按请求里的皮肤画,宽度也跟着皮肤走", async () => {
		const { captured, pup } = capturingPuppeteer();
		const app = createCardsRoute({
			deps: globalsDeps(DEFAULT_CARD_SKIN_ID),
			puppeteer: pup,
			api: null,
			cardSkins: skinStore({ marked: MARKED }),
		});
		const res = await postPreview(app, { kind: "live", style: STYLE, cardSkin: "marked" });
		expect(res.status).toBe(200);
		// 验红:把 renderPreviewCard 里那条 renderCardWithSkin 换回 renderCard(LiveCard, …),
		// 这两条都红 —— 预览会永远画出厂那副样子,而主人在编辑器里改的东西一个都看不到。
		expect(captured[0]).toContain("SKIN-MARK-");
		expect(captured[0]).toContain("width: 640px");
	});

	it("请求没指皮肤 → 用全局在用的那套", async () => {
		const { captured, pup } = capturingPuppeteer();
		const app = createCardsRoute({
			deps: globalsDeps("marked"),
			puppeteer: pup,
			api: null,
			cardSkins: skinStore({ marked: MARKED }),
		});
		expect((await postPreview(app, { kind: "live", style: STYLE })).status).toBe(200);
		// 验红:把 `previewSkinId` 里的 `|| ...defaults.cardSkin` 去掉,这条红。
		expect(captured[0]).toContain("SKIN-MARK-");
	});

	it("真实拉取那条路把皮肤 id 交给 generateLiveCard 的 colorOptions", async () => {
		const api = {
			getLiveRoomInfo: vi.fn(async () => ({ code: 0, data: { uid: 12345, live_status: 1 } })),
			getMasterInfo: vi.fn(async () => ({
				code: 0,
				data: { info: { uname: "真实UP", face: "https://i0.hdslb.com/up.png" } },
			})),
		} as unknown as BilibiliAPI;
		const spy = vi
			.spyOn(ImageRenderer.prototype, "generateLiveCard")
			.mockResolvedValue(Buffer.from("x"));
		const app = createCardsRoute({
			deps: globalsDeps(DEFAULT_CARD_SKIN_ID),
			puppeteer: makeFakePuppeteer(),
			api,
			cardSkins: skinStore({ marked: MARKED }),
		});
		const res = await postPreview(app, {
			kind: "live",
			style: STYLE,
			content: { roomId: "778899" },
			cardSkin: "marked",
		});
		expect(res.status).toBe(200);
		// 验红:把 renderRealLive 里那句 `cardSkin` 删掉,这条红。
		const colorOptions = spy.mock.calls[0]?.[5] as { cardSkin?: string } | undefined;
		expect(colorOptions?.cardSkin).toBe("marked");
		spy.mockRestore();
	});

	it("SC / 上舰同样带着皮肤 id", async () => {
		const spy = vi
			.spyOn(ImageRenderer.prototype, "generateSCCard")
			.mockResolvedValue(Buffer.from("x"));
		const app = createCardsRoute({
			deps: globalsDeps(DEFAULT_CARD_SKIN_ID),
			puppeteer: makeFakePuppeteer(),
			api: null,
			cardSkins: skinStore({ marked: MARKED }),
		});
		const res = await postPreview(app, {
			kind: "sc",
			style: STYLE,
			content: { price: 30 },
			cardSkin: "marked",
			fallback: true,
		});
		expect(res.status).toBe(200);
		const colorOptions = spy.mock.calls[0]?.[1] as { cardSkin?: string } | undefined;
		expect(colorOptions?.cardSkin).toBe("marked");
		spy.mockRestore();
	});

	/**
	 * **「不指皮肤」只有一个意思:用全局在用的那套。**
	 *
	 * 这条路以前有两个缺省各说各话 —— 虚构 mock 那条自己回 globals 取,走渲染器的那条
	 * (SC / 上舰 / 真实拉取)落进 `skinIdOf` 的内置默认。于是同一屏里直播卡是新皮肤、
	 * SC 卡是出厂样子,而两边都说不出哪儿错了。
	 */
	it("请求没指皮肤 → SC 也用全局在用的那套", async () => {
		const spy = vi
			.spyOn(ImageRenderer.prototype, "generateSCCard")
			.mockResolvedValue(Buffer.from("x"));
		const app = createCardsRoute({
			deps: globalsDeps("marked"),
			puppeteer: makeFakePuppeteer(),
			api: null,
			cardSkins: skinStore({ marked: MARKED }),
		});
		const res = await postPreview(app, {
			kind: "sc",
			style: STYLE,
			content: { price: 30 },
			fallback: true,
		});
		expect(res.status).toBe(200);
		// 验红:把 renderPreviewCard 开头那句 `cardSkin || …defaults.cardSkin` 改回直接用
		// 入参,这条红 —— 主人装了皮肤,SC 预览却还是出厂那副样子。
		const colorOptions = spy.mock.calls[0]?.[1] as { cardSkin?: string } | undefined;
		expect(colorOptions?.cardSkin).toBe("marked");
		spy.mockRestore();
	});

	it("请求没指皮肤 → 真实拉取那条也用全局在用的那套", async () => {
		const api = {
			getLiveRoomInfo: vi.fn(async () => ({ code: 0, data: { uid: 12345, live_status: 1 } })),
			getMasterInfo: vi.fn(async () => ({
				code: 0,
				data: { info: { uname: "真实UP", face: "https://i0.hdslb.com/up.png" } },
			})),
		} as unknown as BilibiliAPI;
		const spy = vi
			.spyOn(ImageRenderer.prototype, "generateLiveCard")
			.mockResolvedValue(Buffer.from("x"));
		const app = createCardsRoute({
			deps: globalsDeps("marked"),
			puppeteer: makeFakePuppeteer(),
			api,
			cardSkins: skinStore({ marked: MARKED }),
		});
		const res = await postPreview(app, {
			kind: "live",
			style: STYLE,
			content: { roomId: "778899" },
		});
		expect(res.status).toBe(200);
		// 同上:填了房间号就回出厂皮肤,正是主人报的「填了数据又回到原皮」。
		const colorOptions = spy.mock.calls[0]?.[5] as { cardSkin?: string } | undefined;
		expect(colorOptions?.cardSkin).toBe("marked");
		spy.mockRestore();
	});
});

/**
 * `POST /skin-shot` —— 编辑器那颗「最终效果」(ADR-0014 决策 22)。
 *
 * 实时预览回的是 HTML,由**看的人的浏览器**画;推出去那张是 **server 上的 Chrome** 画的,
 * 字体渲染像素级对不上。这个端点补的正是那一刀。
 *
 * 钉三条:① **与实时预览同源** —— 两边各走各的话,作者会看着一个能用的预览、截出一张
 * 不一样的图,而两边都说不出哪儿错了;② 没配 Chrome 回 **503 带办法**,不是一句「失败了」
 * (编辑器照它把按钮禁掉并说清楚);③ 回**高度**,超上限要如实说 —— 出图那头超了会静默
 * 回落默认皮肤(决策 19),而编辑器是作者唯一能提前知道的地方。
 */
describe("cards route — POST /skin-shot 最终效果", () => {
	const draft = () => structuredClone(DEFAULT_CARD_SKIN) as Record<string, unknown>;

	type ShotJson = {
		ok: boolean;
		dataUrl?: string;
		width?: number;
		height?: number;
		overHeight?: boolean;
		scene?: string;
		err?: string;
		errors?: string[];
	};

	async function shot(body: unknown, puppeteer: StandalonePuppeteer | null) {
		const dir = join(tmpdir(), "bn-test-skin-shot-no-such-dir");
		const app = createCardsRoute({
			deps: depsWithDataDir(dir),
			puppeteer,
			api: null,
			cardSkins: new CardSkinStore({ dir: join(dir, "card-skins") }),
		});
		const res = await app.request("/skin-shot", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		return { res, json: (await res.json()) as ShotJson };
	}

	it("截出一张图,回 dataUrl + 卡宽 + 高度", async () => {
		const { res, json } = await shot(
			{ skinId: DEFAULT_CARD_SKIN_ID, kind: "live", manifest: draft() },
			makeFakePuppeteer(),
		);
		expect(res.status).toBe(200);
		expect(json.ok).toBe(true);
		expect(json.dataUrl?.startsWith("data:image/jpeg;base64,")).toBe(true);
		expect(json.width).toBe(DEFAULT_CARD_SKIN.cards.live?.width);
		expect(json.height).toBe(400);
		expect(json.scene).toBe("streaming");
	});

	/**
	 * ⛔ 截图这条**不能**跟实时预览一样把页面底摁成透明:截出来是 JPEG,没有 alpha,
	 * 透明会被压成黑 —— 圆角外多一圈黑边,而这颗按钮的全部意义就是像素级可信。
	 */
	it("喂给 Chrome 的 HTML 不带透明底", async () => {
		capturedHtml.length = 0;
		const { res } = await shot(
			{ skinId: DEFAULT_CARD_SKIN_ID, kind: "live", manifest: draft() },
			makeFakePuppeteer(),
		);
		expect(res.status).toBe(200);
		expect(capturedHtml.length).toBeGreaterThan(0);
		// 验红:给 `/skin-shot` 那条也传 `transparentPage: true`,这条红。
		expect(capturedHtml[0]).not.toContain("background:transparent");
	});

	it("没配 Chrome → 503,并且把该怎么办说出来", async () => {
		const { res, json } = await shot(
			{ skinId: DEFAULT_CARD_SKIN_ID, kind: "live", manifest: draft() },
			null,
		);
		expect(res.status).toBe(503);
		expect(json.ok).toBe(false);
		expect(json.err).toContain("BN_CHROME_PATH");
	});

	it("草稿过的是与实时预览同一道装包门 —— 拒了就 400 逐条列原因", async () => {
		const { res, json } = await shot(
			{ skinId: DEFAULT_CARD_SKIN_ID, kind: "live", manifest: { schemaVersion: 1 } },
			makeFakePuppeteer(),
		);
		expect(res.status).toBe(400);
		expect(Array.isArray(json.errors)).toBe(true);
		expect(json.errors?.length).toBeGreaterThan(0);
	});

	it("出血不算进超高的判定 —— 与出图那头同一把尺子", async () => {
		const BLEED = 30;
		const d = draft() as Record<string, unknown>;
		const cards = d.cards as Record<string, Record<string, unknown>>;
		cards.live = { ...cards.live, bleed: { size: BLEED, color: "#07091a" } };
		// 图高 = 上限 + 上下两道出血,卡本身刚好卡在上限上,不该报超。
		const p = makeFakePuppeteer();
		vi.mocked(p.page).mockResolvedValue({
			setContent: vi.fn(async () => {}),
			$: vi.fn(async () => ({
				boundingBox: async () => ({
					x: 0,
					y: 0,
					width: 660,
					height: CARD_SKIN_LIMITS.maxHeight + BLEED * 2,
				}),
				dispose: async () => {},
			})),
			screenshot: vi.fn(async () => Buffer.from("fake-png-bytes")),
			close: vi.fn(async () => {}),
		} as never);

		const { res, json } = await shot(
			{ skinId: DEFAULT_CARD_SKIN_ID, kind: "live", manifest: d },
			p,
		);
		expect(res.status).toBe(200);
		// 验红:把减出血那一步去掉,这条立刻红。
		expect(json.overHeight).toBe(false);
	});

	it("超过最大高度 → 照样回图,但把话说明白(出图那头会静默回落默认皮肤)", async () => {
		const tall = makeFakePuppeteer();
		vi.mocked(tall.page).mockResolvedValue({
			setContent: vi.fn(async () => {}),
			$: vi.fn(async () => ({
				boundingBox: async () => ({ x: 0, y: 0, width: 600, height: 9999 }),
				dispose: async () => {},
			})),
			screenshot: vi.fn(async () => Buffer.from("fake-png-bytes")),
			close: vi.fn(async () => {}),
		} as never);

		const { res, json } = await shot(
			{ skinId: DEFAULT_CARD_SKIN_ID, kind: "live", manifest: draft() },
			tall,
		);
		expect(res.status).toBe(200);
		expect(json.ok).toBe(true);
		expect(json.height).toBe(9999);
		expect(json.overHeight).toBe(true);
	});
});

/**
 * **图 / 字体这两档旋钮在预览里也得真的生效**(2026-09-19 审查)。
 *
 * 它们与别的旋钮不是一条路:值是资产库里的一个 id,要 await 读盘才变得成 CSS,所以
 * `cardSkinKnobCss` 那条**同步**路径对它们恒回 null,得由宿主调 `resolveKnobAssets`
 * 另外解析。只传 `knobValues` 的调用方于是会得到一个**静静半灵**的旋钮面板:颜色、
 * 玻璃这些照常跟着变,唯独「卡片背景图」与「字体」什么也不做 —— 而推出去的卡是对的
 * (ImageRenderer 那条路调了它)。「预览好看、推出去变样」的镜像版。
 *
 * 判据照 `wiring-needs-its-own-guard`:把 `renderPreviewCard` 里那两处 `knobAssets`
 * 剪掉,这一组必须红。断言钉的是**变量真被注出来**,不是某个函数被调过。
 */
describe("cards route — 预览:背景图 / 字体旋钮要经宿主解析", () => {
	function depsWithKnobs(dataDir: string, knobs: Record<string, unknown>): RouteDeps {
		return {
			runtime: {
				serviceCtx: {
					logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
				},
			},
			store: {
				bootstrap: { dataDir },
				getGlobals: () => ({
					defaults: {
						cardSkin: DEFAULT_CARD_SKIN_ID,
						cardSkinKnobs: { [DEFAULT_CARD_SKIN_ID]: knobs },
					},
				}),
			},
		} as unknown as RouteDeps;
	}

	for (const kind of ["live", "dyn"] as const) {
		it(`${kind} 卡:拧了「卡片背景图」→ --bn-knob-wallpaper 真的注进去了`, async () => {
			const dir = await mkdtemp(join(tmpdir(), "bn-knob-preview-"));
			try {
				const assetId = await saveCardBg(dir, PNG, "image/png");
				capturedHtml.length = 0;
				const app = createCardsRoute({
					deps: depsWithKnobs(dir, { wallpaper: [assetId] }),
					puppeteer: makeFakePuppeteer(),
					api: null,
				});
				const res = await app.request("/preview", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						kind,
						style: {},
						content: {},
						cardSkin: DEFAULT_CARD_SKIN_ID,
					}),
				});
				expect(res.status).toBe(200);
				expect(capturedHtml.length).toBeGreaterThan(0);
				const html = capturedHtml.join("");
				// 外框 CSS 一直在读它(`var(--bn-knob-wallpaper, <渐变>)`),所以只断言「读了」
				// 是复述现状 —— 要断言的是**喂进去的那一半**真的在。
				// 变量注在根块的 `style="…"` 里,所以那对引号是 `&quot;`(2026-09-19 写这条时
				// 先按 `"` 断言,红了才发现 —— 两种都认,免得下次换了注法又为错误的理由红)。
				expect(html).toMatch(/--bn-knob-wallpaper:url\((?:"|&quot;)data:image\/png;base64,/);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		});
	}

	it("没拧过就不注 —— 皮肤自己写的兜底该活着", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bn-knob-preview-none-"));
		try {
			capturedHtml.length = 0;
			const app = createCardsRoute({
				deps: depsWithKnobs(dir, {}),
				puppeteer: makeFakePuppeteer(),
				api: null,
			});
			const res = await app.request("/preview", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					kind: "live",
					style: {},
					content: {},
					cardSkin: DEFAULT_CARD_SKIN_ID,
				}),
			});
			expect(res.status).toBe(200);
			expect(capturedHtml.join("")).not.toContain("--bn-knob-wallpaper:");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('资产被删了就不注 —— 空 url("") 会把卡片当场刷白', async () => {
		const dir = await mkdtemp(join(tmpdir(), "bn-knob-preview-dangling-"));
		try {
			capturedHtml.length = 0;
			const app = createCardsRoute({
				deps: depsWithKnobs(dir, { wallpaper: ["没有这个资产"] }),
				puppeteer: makeFakePuppeteer(),
				api: null,
			});
			const res = await app.request("/preview", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					kind: "live",
					style: {},
					content: {},
					cardSkin: DEFAULT_CARD_SKIN_ID,
				}),
			});
			expect(res.status).toBe(200);
			expect(capturedHtml.join("")).not.toContain("--bn-knob-wallpaper:");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
