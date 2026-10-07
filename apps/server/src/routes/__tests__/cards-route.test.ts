import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CSS_CUSTOM_PROPERTY_MAX_CHARS, ImageRenderer } from "@bilibili-notify/image";
import {
	BILIBILI_SOURCE_KEY,
	CARD_SKIN_LIMITS,
	type CardSkinManifest,
	DEFAULT_CARD_SKIN,
	DEFAULT_CARD_SKIN_ID,
	fail,
	makeEmptySubscription,
	ok,
	type Post,
} from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { png } from "../../__tests__/support/report-images.js";
import type { Api } from "../../bilibili/api/index.js";
import { CardSkinStore } from "../../card-skins/store.js";
import { listCardBg, saveCardBg } from "../../runtime/card-assets.js";
import type { PuppeteerAdapter } from "../../runtime/puppeteer.js";
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
			dataRoot: dataDir,
			serviceCtx: {
				logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
			},
		},
		// 预览的真实拉取要按 uid 找订阅(读资料里的头像);这些用例没有订阅。
		store: { getGlobals: () => EMPTY_GLOBALS, getSubscriptions: () => [] },
	} as unknown as RouteDeps;
}

/** 假的徽章图标:`ensure()` 跑过之后 `iconOf` 才给图库引用(模拟「出卡前先抓」)。 */
const GUARD_ICON_REF = `${"d".repeat(64)}.png`;
function makeGuardIcons(opts: { gets?: boolean } = {}) {
	let fetched = false;
	const ensure = vi.fn(async () => {
		fetched = opts.gets !== false;
	});
	const iconOf = vi.fn((_key: string) => (fetched ? { ref: GUARD_ICON_REF } : undefined));
	return { ensure, iconOf, refs: () => [] };
}

/** 预览路由抓图存进图库后得到的引用(假的图库每张都回它)。 */
const PREVIEW_IMAGE_REF = `${"e".repeat(64)}.png`;

/** 假的 B 站请求客户端(`Api.http`):每个地址回一张 png,数一数抓了哪些地址。不联网。 */
function imageHttp() {
	const fetch = vi.fn(async (url: URL | string) =>
		ok({
			url: String(url),
			status: 200,
			headers: new Headers(),
			body: png(8, 8, 1),
			isSuccess: true,
			text: () => "",
			json: () => ({ ok: false as const, code: "invalid" as const, message: "不是 json" }),
		}),
	);
	return { fetch };
}

/** 预览里「已订阅的那位 UP」:有这一个订阅,资料里存着头像引用。 */
const SUBSCRIBED_UID = "12345";
const SUBSCRIBED_AVATAR = `${"f".repeat(64)}.jpg`;

function makeDeps(guardIcons = makeGuardIcons(), opts: { subscribed?: boolean } = {}): RouteDeps {
	const subscription = makeEmptySubscription({
		id: "11111111-1111-1111-1111-111111111111",
		identity: { sourceKey: BILIBILI_SOURCE_KEY, externalId: SUBSCRIBED_UID },
	});
	return {
		runtime: {
			guardIcons,
			// 订阅资料里的头像(`cachedProfile.avatar`):预览的真实拉取读它,不为头像联网。
			subRuntimeStore: {
				get: (id: string) =>
					opts.subscribed && id === subscription.id
						? { cachedProfile: { name: "真实UP", avatar: SUBSCRIBED_AVATAR } }
						: undefined,
			},
			// 预览抓图存进的图库(`postImages` 这一家):每张都回同一个引用。
			postImages: { put: vi.fn(async () => ok({ ref: PREVIEW_IMAGE_REF })) },
			dataRoot: join(tmpdir(), "bn-test-cards-route-no-such-dir"),
			serviceCtx: {
				logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
			},
		},
		// 这些用例只打 /chrome 与 /preview(无背景图),dataDir 从不真正落 fs。
		// 用 OS 临时目录下的不存在子目录(跨平台:不硬编码 POSIX /tmp,无真实路径/密钥)。
		store: {
			getGlobals: () => EMPTY_GLOBALS,
			getSubscriptions: () => (opts.subscribed ? [subscription] : []),
		},
	} as unknown as RouteDeps;
}

/** 渲染 mock 路径用的假 puppeteer —— page().screenshot 直接吐一段假 PNG 字节。 */
/** 灌进去的 HTML 留一份 —— 「喂给 Chrome 的到底是什么」只能从这儿看。 */
const capturedHtml: string[] = [];

function makeFakePuppeteer(): PuppeteerAdapter {
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
	return { page: vi.fn(async () => fakePage) } as unknown as PuppeteerAdapter;
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
		/** 全局直播封面列表(`cards.liveCoverImageIds`)—— 验证删除引用检查覆盖封面引用。 */
		globalCover?: string[];
		/** 皮肤旋钮那一层(2026-09-14 起背景图的正主)。 */
		knobs?: Record<string, Record<string, unknown>>;
		subs?: Array<
			{
				cover?: string[];
				/** 这位 UP 自己那层旋钮覆盖(ADR-0014 决策 17 的 🔗)。 */
				knobs?: Record<string, Record<string, unknown>>;
			} & ({ uid: string } | { kind: "extension"; externalId: string })
		>;
	}): RouteDeps {
		return {
			runtime: {
				dataRoot: opts.dataDir,
				serviceCtx: {
					logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
				},
			},
			store: {
				getGlobals: () => ({
					defaults: {
						cardSkin: "default",
						cardSkinKnobs: opts.knobs ?? {},
						cards: { enabled: true, liveCoverImageIds: opts.globalCover ?? [] },
					},
				}),
				getSubscriptions: () =>
					(opts.subs ?? []).map((s) => ({
						...("uid" in s
							? { identity: { sourceKey: "bilibili", externalId: s.uid } }
							: { identity: { sourceKey: "douyin", externalId: s.externalId } }),
						overrides: {
							cards: s.cover ? { liveCoverImageIds: s.cover } : undefined,
							cardSkinKnobs: s.knobs,
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

	it("删除仅被全局直播封面(cards.liveCoverImageIds)引用的图 → 409 拦截", async () => {
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

	it("删除被某 UP 的直播封面引用的图 → conflict(409),message 指出该 UP", async () => {
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
			const json = (await res.json()) as Record<string, unknown>;
			expect(json.code).toBe("conflict");
			expect(json.message).toContain("UP 30303");
			// 用家并进了 message,不再另占一格。
			expect(json).not.toHaveProperty("referencedBy");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("删除被**皮肤旋钮**引用的背景图 → conflict(409),message 指出是哪套皮肤", async () => {
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
			const json = (await res.json()) as { code: string; message: string };
			expect(json.code).toBe("conflict");
			expect(json.message).toContain("皮肤「neon」");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	/**
	 * per-UP 那层旋钮(ADR-0014 决策 17 的 🔗)里的壁纸同样是一条引用 —— 漏看它就是上面那条的
	 * per-UP 版:删得掉、请求成功,这位 UP 的卡静静回落兜底。两支订阅都算。
	 * 验红:把 `cardBgReferences` 里扫订阅旋钮那一段删掉,这条红。
	 */
	it("删除被某 UP 单独拧的**皮肤旋钮**引用的背景图 → conflict(409),message 指出该 UP 与皮肤", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bn-del-up-knob-"));
		try {
			const id = await saveCardBg(dir, PNG, "image/png");
			const app = createCardsRoute({
				deps: depsWithStore({
					dataDir: dir,
					subs: [
						{ uid: "10086", knobs: { neon: { wallpaper: [id] } } },
						{
							kind: "extension",
							externalId: "sec-1",
							knobs: { neon: { wallpaper: [id] } },
						},
					],
				}),
				puppeteer: null,
				api: null,
			});
			const res = await app.request(`/asset/${id}`, { method: "DELETE" });
			expect(res.status).toBe(409);
			const json = (await res.json()) as { code: string; message: string };
			expect(json.code).toBe("conflict");
			expect(json.message).toBe(
				"该背景图还有 2 处在用：UP 10086 · 皮肤「neon」、订阅「sec-1」 · 皮肤「neon」，请先在卡片设置里移除再删除",
			);
			expect(await listCardBg(dir)).toEqual([id]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("删除被某 UP 覆盖引用的封面图 → conflict(409),message 指出该 UP", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bn-del-ref-up-"));
		try {
			const id = await saveCardBg(dir, PNG, "image/png");
			const app = createCardsRoute({
				deps: depsWithStore({ dataDir: dir, subs: [{ uid: "10086", cover: [id] }] }),
				puppeteer: null,
				api: null,
			});
			const res = await app.request(`/asset/${id}`, { method: "DELETE" });
			expect(res.status).toBe(409);
			const json = (await res.json()) as { code: string; message: string };
			expect(json.code).toBe("conflict");
			expect(json.message).toContain("UP 10086");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("删除被拓展订阅引用的封面图 → conflict(409),message 用外部 id 指认(ADR-0019 决策 47;别名已退役,ADR-0021 决策 16)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bn-del-cover-ext-"));
		try {
			const id = await saveCardBg(dir, PNG, "image/png");
			const app = createCardsRoute({
				deps: depsWithStore({
					dataDir: dir,
					subs: [
						{ kind: "extension", externalId: "MS4wLjAB-sec", cover: [id] },
						{ kind: "extension", externalId: "sec-2", cover: [id] },
					],
				}),
				puppeteer: null,
				api: null,
			});
			const res = await app.request(`/asset/${id}`, { method: "DELETE" });
			expect(res.status).toBe(409);
			const json = (await res.json()) as { message: string };
			expect(json.message).toContain("订阅「MS4wLjAB-sec」、订阅「sec-2」");
			expect(await listCardBg(dir)).toEqual([id]); // 仍在盘上
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("删除非法 id → invalid(400)", async () => {
		const app = createCardsRoute({
			deps: depsWithStore({ dataDir: join(tmpdir(), "bn-x-no-such-dir") }),
			puppeteer: null,
			api: null,
		});
		const res = await app.request("/asset/..%2f..%2fsecrets.json", { method: "DELETE" });
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ code: "invalid", message: "无效的资产 id" });
	});

	it("用家多了只点前三个名字再报个数 —— 一条错误不该变成一面墙", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bn-del-many-"));
		try {
			const id = await saveCardBg(dir, PNG, "image/png");
			const app = createCardsRoute({
				deps: depsWithStore({
					dataDir: dir,
					subs: ["101", "102", "103", "104", "105"].map((uid) => ({ uid, cover: [id] })),
				}),
				puppeteer: null,
				api: null,
			});
			const res = await app.request(`/asset/${id}`, { method: "DELETE" });
			expect(res.status).toBe(409);
			const json = (await res.json()) as { message: string };
			expect(json.message).toContain("还有 5 处在用：UP 101、UP 102、UP 103 等 5 处");
			expect(json.message).not.toContain("UP 104");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("cards route — testPushCaption(测试推送图说)", () => {
	it("每种卡片类型 → 带「测试推送」前缀 + 该类型中文标签的文案", () => {
		expect(testPushCaption("live")).toContain("直播卡");
		expect(testPushCaption("post")).toContain("动态卡");
		expect(testPushCaption("superchat")).toContain("醒目留言卡");
		expect(testPushCaption("membership")).toContain("上舰卡");
		for (const k of ["live", "post", "superchat", "membership"] as const) {
			// 非空且带前缀 —— 顶替 QQ 富媒体空 content 的占位空格,接收方一眼知是测试。
			expect(testPushCaption(k)).toContain("测试推送");
			expect(testPushCaption(k).trim().length).toBeGreaterThan(0);
		}
	});
});

describe("cards route — GET /chrome(探测本机 Chrome)", () => {
	it("GET /chrome 返回探测到的 Chrome 路径", async () => {
		const app = createCardsRoute({
			deps: makeDeps(),
			puppeteer: null,
			api: null,
			detectChrome: () => "/usr/bin/google-chrome",
		});
		const res = await app.request("/chrome");
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
		const res = await app.request("/chrome");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ path: null });
	});
});

describe("cards route — POST /renderer(热启用渲染)", () => {
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

	it("POST /renderer: 构造 puppeteer + 热启用引擎 + 写回配置 + 通知", async () => {
		const fakePup = { dispose: vi.fn(async () => {}) } as unknown as PuppeteerAdapter;
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
		const res = await app.request("/renderer", {
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

	it("POST /renderer with chromeEndpoint: 先探测连通,再热启用 + 写回", async () => {
		const probePage = { close: vi.fn(async () => {}) };
		const fakePup = {
			page: vi.fn(async () => probePage),
			dispose: vi.fn(async () => {}),
		} as unknown as PuppeteerAdapter;
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
		const res = await app.request("/renderer", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ chromeEndpoint: "ws://browser:3000" }),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ ok: true, chromeEndpoint: "ws://browser:3000" });
		expect(createPuppeteer).toHaveBeenCalledWith({ chromeEndpoint: "ws://browser:3000" });
		// 远程端点没有 `/chrome` 那样的预验,必须真开一页确认连得上才算启用成功。
		expect(fakePup.page).toHaveBeenCalledTimes(1);
		expect(probePage.close).toHaveBeenCalledTimes(1);
		expect(enableImageRendering).toHaveBeenCalledWith(fakePup);
		expect(persistChromeSource).toHaveBeenCalledWith({ chromeEndpoint: "ws://browser:3000" });
		expect(onPuppeteerEnabled).toHaveBeenCalledWith(fakePup);
	});

	it("chromeEndpoint 探测失败 → unavailable(503),dispose,不启用不写回", async () => {
		const fakePup = {
			page: vi.fn(async () => {
				throw new Error("connect ECONNREFUSED browser:3000");
			}),
			dispose: vi.fn(async () => {}),
		} as unknown as PuppeteerAdapter;
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
		const res = await app.request("/renderer", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ chromeEndpoint: "ws://browser:3000" }),
		});
		// 502 → 503:探活连不上是 `unavailable`(等一会儿 / 修好那台浏览器就好),对端给的原因原样写进 message。
		expect(res.status).toBe(503);
		const body = (await res.json()) as { code: string; message: string };
		expect(body.code).toBe("unavailable");
		expect(body.message).toContain("浏览器连接失败");
		expect(body.message).toMatch(/ECONNREFUSED/);
		expect(body).not.toHaveProperty("err");
		expect(enableImageRendering).not.toHaveBeenCalled();
		expect(persistChromeSource).not.toHaveBeenCalled();
		expect(fakePup.dispose).toHaveBeenCalled();
	});

	it("已启用后换来源(本地→远程):探测新 adapter → swap → dispose 旧 → 写回", async () => {
		const oldPup = { dispose: vi.fn(async () => {}) } as unknown as PuppeteerAdapter;
		const probePage = { close: vi.fn(async () => {}) };
		const newPup = {
			page: vi.fn(async () => probePage),
			dispose: vi.fn(async () => {}),
		} as unknown as PuppeteerAdapter;
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
		const res = await app.request("/renderer", {
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
		// GET /renderer 反映切换后的来源。
		const status = await app.request("/renderer");
		expect(await status.json()).toEqual({
			enabled: true,
			source: { chromeEndpoint: "ws://browser:3000" },
			persistable: true,
		});
	});

	it("已启用后换本地路径:同样先探测(launch 一次)再 swap", async () => {
		const oldPup = { dispose: vi.fn(async () => {}) } as unknown as PuppeteerAdapter;
		const probePage = { close: vi.fn(async () => {}) };
		const newPup = {
			page: vi.fn(async () => probePage),
			dispose: vi.fn(async () => {}),
		} as unknown as PuppeteerAdapter;
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
		const res = await app.request("/renderer", {
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
		const oldPup = { dispose: vi.fn(async () => {}) } as unknown as PuppeteerAdapter;
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
		const res = await app.request("/renderer", {
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
		const oldPup = { dispose: vi.fn(async () => {}) } as unknown as PuppeteerAdapter;
		const probePage = { close: vi.fn(async () => {}) };
		const newPup = {
			page: vi.fn(async () => probePage),
			dispose: vi.fn(async () => {}),
		} as unknown as PuppeteerAdapter;
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
		const res = await app.request("/renderer", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ chromeEndpoint: "ws://browser:3000" }),
		});
		// 500 → 503:配置写不进去是环境的事,原因(EACCES)照实写进 message,主人要照着去修。
		expect(res.status).toBe(503);
		const body = (await res.json()) as { code: string; message: string };
		expect(body.code).toBe("unavailable");
		expect(body.message).toMatch(/已生效/);
		expect(body.message).toContain("EACCES");
		// 切换本身(swap)已经生效——不是"报失败就当作啥都没变"。
		expect(swapImageRendering).toHaveBeenCalledWith(newPup);
		// 但旧浏览器刻意不销毁,留作"重启会退回它"的可用状态。
		expect(oldPup.dispose).not.toHaveBeenCalled();
	});

	it("GET /renderer:未启用时 enabled=false source=null;persistable 跟注入走", async () => {
		const app = createCardsRoute({
			deps: depsWithEngines(vi.fn()),
			puppeteer: null,
			api: null,
		});
		const res = await app.request("/renderer");
		expect(await res.json()).toEqual({ enabled: false, source: null, persistable: false });
	});

	it("已启用:enableImageRendering 返回 false → dispose 多余 adapter,不写回", async () => {
		const fakePup = { dispose: vi.fn(async () => {}) } as unknown as PuppeteerAdapter;
		const createPuppeteer = vi.fn(() => fakePup);
		const persistChromeSource = vi.fn(async () => {});
		const app = createCardsRoute({
			deps: depsWithEngines(vi.fn(() => false)),
			puppeteer: null,
			api: null,
			createPuppeteer,
			persistChromeSource,
		});
		const res = await app.request("/renderer", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ chromePath: "/usr/bin/google-chrome" }),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ ok: true, alreadyEnabled: true });
		expect(fakePup.dispose).toHaveBeenCalled();
		expect(persistChromeSource).not.toHaveBeenCalled();
	});

	it("body 缺 chromePath 与 chromeEndpoint → invalid(400),不构造 puppeteer", async () => {
		const createPuppeteer = vi.fn();
		const app = createCardsRoute({
			deps: depsWithEngines(vi.fn()),
			puppeteer: null,
			api: null,
			createPuppeteer,
		});
		const res = await app.request("/renderer", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { code: string; message: string };
		expect(body.code).toBe("invalid");
		expect(body.message).toContain("chromePath 或 chromeEndpoint");
		expect(createPuppeteer).not.toHaveBeenCalled();
	});

	it("engines 未就绪 → unavailable(503),这是「等一会儿就好」,不是 not_configured", async () => {
		const deps = {
			runtime: {
				serviceCtx: {
					logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
				},
				engines: null,
			},
		} as unknown as RouteDeps;
		const app = createCardsRoute({ deps, puppeteer: null, api: null });
		const res = await app.request("/renderer", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ chromePath: "/x" }),
		});
		expect(res.status).toBe(503);
		expect(((await res.json()) as { code: string }).code).toBe("unavailable");
	});
});

describe("cards route — 热切换后预览渲染器随之失效重建", () => {
	const STYLE = {};

	function depsWithEnginesAndDataDir(swapImageRendering: ReturnType<typeof vi.fn>): RouteDeps {
		return {
			runtime: {
				dataRoot: join(tmpdir(), "bn-test-hotswap-no-such-dir"),
				serviceCtx: {
					logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
				},
				engines: { enableImageRendering: vi.fn(() => false), swapImageRendering },
			},
			store: {
				getGlobals: () => EMPTY_GLOBALS,
			},
		} as unknown as RouteDeps;
	}

	/** 假 puppeteer:page() 每次都返回新页面对象,screenshot() 吐带标记的字节。 */
	function makeMarkedPuppeteer(marker: string): PuppeteerAdapter & { pageCalls: number } {
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
		} as unknown as PuppeteerAdapter;
		Object.defineProperty(puppeteer, "pageCalls", { get: () => state.pageCalls });
		return puppeteer as PuppeteerAdapter & { pageCalls: number };
	}

	it("热切换(POST /renderer)后,下一次 /preview 用新 adapter 渲染,不再打到已销毁的旧 adapter", async () => {
		const pupA = makeMarkedPuppeteer("A");
		const pupB = makeMarkedPuppeteer("B");
		// pupB 的假页面对象自带 close(),POST /renderer 里 replacing 分支的连通性
		// 探测(page().close())与之后预览渲染复用同一份 fake page,探测调用也计入
		// pupB.page 调用次数,属预期。
		const swapImageRendering = vi.fn();
		const deps = depsWithEnginesAndDataDir(swapImageRendering);
		const app = createCardsRoute({
			deps,
			puppeteer: pupA,
			initialChromeSource: { chromePath: "/old/chrome" },
			api: null,
			createPuppeteer: vi.fn(() => pupB as unknown as PuppeteerAdapter),
			persistChromeSource: vi.fn(async () => {}),
		});

		// 第一次预览:绑定 pupA 的渲染器被构造并缓存。
		const first = await app.request("/preview", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ kind: "superchat", style: STYLE, content: { amount: 30 } }),
		});
		expect(first.status).toBe(200);
		expect(pupA.page).toHaveBeenCalledTimes(1);

		// 热切换到 pupB —— 引擎侧的 swapImageRendering 只管推送渲染,不管路由自己缓存
		// 的预览 renderer;pupA 在这之后被 dispose,若预览渲染器缓存不失效就会打到
		// 一个已销毁的 adapter 上。
		const swap = await app.request("/renderer", {
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
			body: JSON.stringify({ kind: "superchat", style: STYLE, content: { amount: 30 } }),
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
	it("fetchUserInfo 返回 live_room.roomid → 解析成房间号字符串", async () => {
		const api = {
			fetchUserInfo: vi.fn(async () => ({ code: 0, data: { live_room: { roomid: 778899 } } })),
		} as unknown as Api;
		expect(await resolveRoomIdFromUid(api, "12345")).toBe("778899");
	});

	it("非纯数字 uid → 抛错(不打接口)", async () => {
		const fetchUserInfo = vi.fn();
		const api = { fetchUserInfo } as unknown as Api;
		await expect(resolveRoomIdFromUid(api, "abc")).rejects.toThrow();
		expect(fetchUserInfo).not.toHaveBeenCalled();
	});

	it("未开通直播间(live_room 缺失 / roomid<=0)→ 抛错", async () => {
		const api = {
			fetchUserInfo: vi.fn(async () => ({ code: 0, data: { live_room: { roomid: 0 } } })),
		} as unknown as Api;
		await expect(resolveRoomIdFromUid(api, "12345")).rejects.toThrow(/未开通直播间|无法解析/);
	});
});

describe("cards route — /preview live-by-uid fallback", () => {
	const STYLE = {};

	function postPreview(app: ReturnType<typeof createCardsRoute>, body: unknown) {
		return app.request("/preview", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	it("fallback:true 且真实拉取失败 → 回退示例数据,200 ok", async () => {
		// fetchUserInfo 抛错(网络) → live 真实路径失败 → fallback 回退 mock 渲染。
		const api = {
			fetchUserInfo: vi.fn(async () => {
				throw new Error("network down");
			}),
		} as unknown as Api;
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

	it("fallback 缺省(false)且真实拉取失败 → 200 + 失败那一支(unavailable),把原话交给用户", async () => {
		const api = {
			fetchUserInfo: vi.fn(async () => {
				throw new Error("network down");
			}),
		} as unknown as Api;
		const app = createCardsRoute({ deps: makeDeps(), puppeteer: makeFakePuppeteer(), api });
		const res = await postPreview(app, {
			kind: "live",
			style: STYLE,
			content: { uid: "12345" },
		});
		// 「画一张、回报结果」:请求没毛病、这一趟没成 —— 200,体是 `Result` 的失败那一支。
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			ok: false,
			code: "unavailable",
			message: "卡片渲染失败：network down",
		});
	});

	/**
	 * **这一条原来钉的是「悬空首张被跳过、第二张内联进了 HTML」。** 内联那一半 2026-09-19
	 * 就不成立了(`--bn-card-bg-image` 不再注),2026-09-20 整条
	 * `cardStyle.backgroundImages` 链连同 `StyleSchema` 里那个字段一起删掉 —— 所以现在
	 * 请求体里写它等于**没写**:zod 把未知键剥掉,谁都读不到。
	 *
	 * 仍留一条**路由这一层**的守卫:请求体里塞一个存量前端会发来的 `backgroundImages`,
	 * 画出来的 HTML 里不许出现任何图。判据:把那个字段加回 `StyleSchema` 并接回渲染,这条红。
	 */
	it("mock 预览:请求体里退役的 backgroundImages 到不了卡片(背景图走 wallpaper 旋钮)", async () => {
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
			const puppeteer = { page: async () => page } as unknown as PuppeteerAdapter;
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

	it("mock live 预览:liveCoverImageIds 首张悬空 → 跳过,封面用第一张存在的图", async () => {
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
			const puppeteer = { page: async () => page } as unknown as PuppeteerAdapter;
			const app = createCardsRoute({ deps: depsWithDataDir(dir), puppeteer, api: null });
			const res = await postPreview(app, {
				kind: "live",
				style: { ...STYLE, liveCoverImageIds: [ghost, real] },
			});
			expect(res.status).toBe(200);
			expect(captured.html).toContain("data:image/png;base64,");
			expect(captured.html).not.toContain("%3ECover%3C");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("mock live 预览:style.liveCoverImageIds 首张解析成 data URL 注入封面", async () => {
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
			const puppeteer = { page: async () => page } as unknown as PuppeteerAdapter;
			const app = createCardsRoute({ deps: depsWithDataDir(dir), puppeteer, api: null });
			const res = await postPreview(app, {
				kind: "live",
				style: { ...STYLE, liveCoverImageIds: [id] },
			});
			expect(res.status).toBe(200);
			// 封面被自定义图(data:image/png)替换,示例 SVG 封面不再出现。
			expect(captured.html).toContain("data:image/png;base64,");
			expect(captured.html).not.toContain("%3ECover%3C");
			// mock 示例是写好的视图,头像是内置 SVG,照画(真实拉取那条路 B 站到 3a 前不画头像,见下)。
			expect(captured.html).toContain('alt="主播头像"');
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("live 真实数据预览(有 roomId,走 renderRealLive):liveCoverImageIds 首张悬空 → 跳过,不再传幽灵 id 给 renderer", async () => {
		// renderRealLive 曾漏加 firstExistingCardBg 守卫,直接把 liveCoverImageIds[0] 透传 ——
		// 幽灵 id 解析失败会静默回退 B 站原始封面,即便第二张图有效。这里用真实数据分支
		// (content.roomId 命中,不落 mock 兜底)验证 colorOptions.liveCoverImage 拿到的是
		// 第一张盘上存在的图,不是幽灵 id。
		const dir = await mkdtemp(join(tmpdir(), "bn-preview-real-ghost-cover-"));
		try {
			const real = await saveCardBg(dir, PNG, "image/png");
			const ghost = `${"c".repeat(32)}.png`;
			const api = {
				fetchLiveRoomInfo: vi.fn(async () => ({
					code: 0,
					data: { uid: 12345, live_status: 1 },
				})),
				getMasterInfo: vi.fn(async () => ({
					code: 0,
					data: { info: { uname: "真实UP", face: "https://i0.hdslb.com/up.png" } },
				})),
			} as unknown as Api;
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
				style: { ...STYLE, liveCoverImageIds: [ghost, real] },
				content: { roomId: "778899" },
			});
			expect(res.status).toBe(200);
			const colorOptions = spy.mock.calls[0]?.[1] as { liveCoverImage?: string };
			expect(colorOptions.liveCoverImage).toBe(real);
			spy.mockRestore();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	/**
	 * 主人真机撞见的:按 UP 预览一位**没在播**的 UP,这条路恒按「直播中」出卡,取的是关键帧 ——
	 * 没开播时 B 站给的关键帧是空串,封面那一格画成一张只剩 alt 文字的裂图。
	 * 验红:把 `liveCardInputFromRoomInfo` 的封面改回只取关键帧 / 把 `buildLiveCardView` 的占位去掉,
	 * 对应那条红。图一律 data URL:测试不许联网。
	 */
	describe("真实数据预览:没在播的房间", () => {
		const ROOM_COVER = "data:image/png;base64,ROOM-COVER";

		async function coverSrcOf(room: Record<string, unknown>): Promise<string | undefined> {
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
			const api = {
				// 抓不到图(图库那头不收 data URL):封面保持只有地址,原样交给出图器 —— 这几条测的是挑哪张封面。
				http: { fetch: vi.fn(async () => fail("unavailable", "测试不联网")) },
				fetchLiveRoomInfo: vi.fn(async () => ({
					code: 0,
					data: { uid: 12345, live_status: 0, title: "没在播", ...room },
				})),
				getMasterInfo: vi.fn(async () => ({
					code: 0,
					data: { info: { uname: "真实UP", face: "data:image/png;base64,FACE" } },
				})),
			} as unknown as Api;
			const puppeteer = { page: async () => page } as unknown as PuppeteerAdapter;
			const app = createCardsRoute({ deps: makeDeps(), puppeteer, api });
			const res = await postPreview(app, {
				kind: "live",
				style: STYLE,
				content: { roomId: "778899" },
			});
			expect(res.status).toBe(200);
			return /src="([^"]*)" alt="封面"/.exec(captured.html)?.[1];
		}

		it("关键帧是空串 → 封面退到直播间封面", async () => {
			expect(await coverSrcOf({ keyframe: "", user_cover: ROOM_COVER })).toBe(ROOM_COVER);
		});

		it("连直播间封面也没有 → 画内嵌的占位图,不出空的 src", async () => {
			const src = await coverSrcOf({ keyframe: "", user_cover: "" });
			expect(src).toMatch(/^data:image\/svg\+xml;base64,/);
		});
	});
});

describe("cards route — /preview sc/guard 发送者取登录账号", () => {
	const STYLE = {};

	function loggedInApi(): Api {
		return {
			getMyselfInfoCached: vi.fn(async () => ({ code: 0, data: { mid: 999, uname: "登录名" } })),
			fetchUserCard: vi.fn(async () => ({
				code: 0,
				data: { card: { name: "登录名", face: "https://i0.hdslb.com/face.png" } },
			})),
		} as unknown as Api;
	}

	function postPreview(app: ReturnType<typeof createCardsRoute>, body: unknown) {
		return app.request("/preview", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	it("sc:viewer.name=登录账号(fallback:true 的 per-UP 风格请求,与作用域无关)", async () => {
		const spy = vi
			.spyOn(ImageRenderer.prototype, "generateSuperchatCard")
			.mockResolvedValue(Buffer.from("x"));
		const app = createCardsRoute({
			deps: makeDeps(),
			puppeteer: makeFakePuppeteer(),
			api: loggedInApi(),
		});
		const res = await postPreview(app, {
			kind: "superchat",
			style: STYLE,
			content: { amount: 30 },
			fallback: true,
		});
		expect(res.status).toBe(200);
		const arg = spy.mock.calls[0]?.[0] as { viewer: { name: string } };
		expect(arg.viewer.name).toBe("登录名");
		spy.mockRestore();
	});

	/**
	 * **旋钮要到得了 SC / 上舰的预览**(ADR-0014 决策 16 的 🔗)。这两种卡的预览走
	 * `ImageRenderer`,另两种走 SSR 那条 —— 只接一条的话就是「改了颜色,直播卡预览变了、
	 * SC 卡没变」。验红:把 `getImageRenderer` 的 config 里那句 `cardSkinKnobs` 删掉。
	 */
	it("SC 预览:旋钮覆盖从配置进了渲染器的 config", async () => {
		const spy = vi
			.spyOn(ImageRenderer.prototype, "generateSuperchatCard")
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
		const body = {
			kind: "superchat" as const,
			style: STYLE,
			content: { amount: 30 },
			fallback: true,
		};
		// 第一趟构造渲染器,第二趟才走 updateConfig —— 两趟都发,拿得到那份 config。
		expect((await postPreview(app, body)).status).toBe(200);
		expect((await postPreview(app, body)).status).toBe(200);
		const cfg = update.mock.calls.at(-1)?.[0] as { cardSkinKnobs?: Record<string, unknown> };
		expect(cfg?.cardSkinKnobs).toEqual({ knobby: { accent: "#00f0ff" } });
		spy.mockRestore();
		update.mockRestore();
	});

	// ㉓c:SC 预览与真推送同一条路 —— 价格先经翻译算档(`superchatEventFromLiveEvent`),再按档补一个与 B 站醒目留言
	// 一致的时长;不传头像(`viewer.avatar` / `creator.avatar` 只收图库引用,B 站 3a 才交)。
	// 验红:把 cards.ts 里 SC 预览交给入口的 `tier` 换成固定一档,第一条红;给 `viewer` 加回 `avatar`,第二条红。
	it.each([
		[30, { rank: 1, durationSec: 60 }],
		[100, { rank: 3, durationSec: 300 }],
		[2000, { rank: 6, durationSec: 7200 }],
	] as const)("sc:价格 %s 元 → 档 %j,viewer 与 creator 都不带头像", async (price, tier) => {
		const spy = vi
			.spyOn(ImageRenderer.prototype, "generateSuperchatCard")
			.mockResolvedValue(Buffer.from("x"));
		const app = createCardsRoute({
			deps: makeDeps(),
			puppeteer: makeFakePuppeteer(),
			api: loggedInApi(),
		});
		const res = await postPreview(app, {
			kind: "superchat",
			style: STYLE,
			content: { amount: price },
			fallback: true,
		});
		expect(res.status).toBe(200);
		const arg = spy.mock.calls[0]?.[0];
		expect(arg).toMatchObject({ amount: price, currency: "CNY", tier });
		expect(Object.keys(arg?.viewer ?? {})).toEqual(["name"]);
		expect(Object.keys(arg?.creator ?? {})).toEqual(["name"]);
		spy.mockRestore();
	});

	// ㉓e:上舰预览的请求体带的是档的 key(`tierKey`),服务端按 key 在档位表里找那一档;档的各项取自同一张表。
	// 验红:把 cards.ts 里 `guardTierByKey(...)` 换成固定取舰长,第二行(总督)红。
	it.each([
		["captain", "舰长", 1, "#4ebcec"],
		["commander", "提督", 2, "#d8a0e6"],
		["governor", "总督", 3, "#f2a053"],
	] as const)(
		"guard:tierKey %s → 档位表里的「%s」(rank %s、档色 %s、带徽章与宣告语),不带头像",
		async (tierKey, name, rank, color) => {
			const spy = vi
				.spyOn(ImageRenderer.prototype, "generateMembershipCard")
				.mockResolvedValue(Buffer.from("x"));
			const app = createCardsRoute({
				deps: makeDeps(),
				puppeteer: makeFakePuppeteer(),
				api: loggedInApi(),
			});
			const res = await postPreview(app, {
				kind: "membership",
				style: STYLE,
				content: { tierKey },
				fallback: true,
			});
			expect(res.status).toBe(200);
			const arg = spy.mock.calls[0]?.[0];
			expect(arg?.tier).toMatchObject({ name, rank, color });
			expect(arg?.tier.icon).toEqual({ ref: GUARD_ICON_REF });
			expect(arg?.tier.announcement).toContain("{viewer}");
			expect(Object.keys(arg?.viewer ?? {})).toEqual(["name"]);
			expect(Object.keys(arg?.creator ?? {})).toEqual(["name"]);
			spy.mockRestore();
		},
	);

	// 验红:把 cards.ts 里上舰预览那句 `await opts.deps.runtime.guardIcons.ensure()` 删掉,这条红(没抓到就取了)。
	it("guard:预览前先 ensure() 再按档取图标", async () => {
		const guardIcons = makeGuardIcons();
		const spy = vi
			.spyOn(ImageRenderer.prototype, "generateMembershipCard")
			.mockResolvedValue(Buffer.from("x"));
		const app = createCardsRoute({
			deps: makeDeps(guardIcons),
			puppeteer: makeFakePuppeteer(),
			api: loggedInApi(),
		});
		await postPreview(app, {
			kind: "membership",
			style: STYLE,
			content: { tierKey: "governor" },
			fallback: true,
		});
		expect(guardIcons.ensure).toHaveBeenCalledTimes(1);
		expect(guardIcons.iconOf).toHaveBeenCalledWith("governor");
		expect(spy.mock.calls[0]?.[0]?.tier.icon).toEqual({ ref: GUARD_ICON_REF });
		spy.mockRestore();
	});

	// 验红:把 cards.ts 里 `icon` 那一格改回 `icon: tier.icon`(档位表的地址),这条红。
	it("guard:没抓到图标 → 出卡输入没有 icon 这一格,预览照出", async () => {
		const spy = vi
			.spyOn(ImageRenderer.prototype, "generateMembershipCard")
			.mockResolvedValue(Buffer.from("x"));
		const app = createCardsRoute({
			deps: makeDeps(makeGuardIcons({ gets: false })),
			puppeteer: makeFakePuppeteer(),
			api: loggedInApi(),
		});
		const res = await postPreview(app, {
			kind: "membership",
			style: STYLE,
			content: {},
			fallback: true,
		});
		expect(res.status).toBe(200);
		expect(spy.mock.calls[0]?.[0]?.tier).not.toHaveProperty("icon");
		spy.mockRestore();
	});

	it("guard:没带 tierKey → 最低一档(舰长)", async () => {
		const spy = vi
			.spyOn(ImageRenderer.prototype, "generateMembershipCard")
			.mockResolvedValue(Buffer.from("x"));
		const app = createCardsRoute({
			deps: makeDeps(),
			puppeteer: makeFakePuppeteer(),
			api: loggedInApi(),
		});
		const res = await postPreview(app, {
			kind: "membership",
			style: STYLE,
			content: {},
			fallback: true,
		});
		expect(res.status).toBe(200);
		expect(spy.mock.calls[0]?.[0]?.tier).toMatchObject({ name: "舰长", rank: 1 });
		spy.mockRestore();
	});

	// 档位表里没有的 key 是请求本身的毛病:400,与「预览请求体格式不对」同一条报错路子,不去渲染。
	it.each(["nope", "", "Captain", "constructor"])(
		"guard:认不出的 tierKey %j → 400 invalid,不渲染",
		async (tierKey) => {
			const spy = vi
				.spyOn(ImageRenderer.prototype, "generateMembershipCard")
				.mockResolvedValue(Buffer.from("x"));
			const app = createCardsRoute({
				deps: makeDeps(),
				puppeteer: makeFakePuppeteer(),
				api: loggedInApi(),
			});
			const res = await postPreview(app, {
				kind: "membership",
				style: STYLE,
				content: { tierKey },
				fallback: true,
			});
			expect(res.status).toBe(400);
			expect(await res.json()).toMatchObject({ code: "invalid" });
			expect(spy).not.toHaveBeenCalled();
			spy.mockRestore();
		},
	);

	it("sc:金额 0、负数或带小数 → 400 invalid(金额要正整数元)", async () => {
		const app = createCardsRoute({
			deps: makeDeps(),
			puppeteer: makeFakePuppeteer(),
			api: loggedInApi(),
		});
		for (const amount of [0, -1, 1.5]) {
			const res = await postPreview(app, {
				kind: "superchat",
				style: STYLE,
				content: { amount },
				fallback: true,
			});
			expect(res.status, String(amount)).toBe(400);
		}
	});

	// 预览不画头像,也就不为头像多调一次接口:登录账号只取名字(`getMyselfInfoCached`),不再调 `fetchUserCard`。
	// 验红:把 cards.ts 的 getLoggedInAccount 加回 `fetchUserCard` 那一步,这条红。
	it("sc / guard:登录账号只取名字,不为头像再调 fetchUserCard", async () => {
		const api = loggedInApi();
		const sc = vi
			.spyOn(ImageRenderer.prototype, "generateSuperchatCard")
			.mockResolvedValue(Buffer.from("x"));
		const guard = vi
			.spyOn(ImageRenderer.prototype, "generateMembershipCard")
			.mockResolvedValue(Buffer.from("x"));
		const app = createCardsRoute({ deps: makeDeps(), puppeteer: makeFakePuppeteer(), api });
		await postPreview(app, {
			kind: "superchat",
			style: STYLE,
			content: { amount: 30 },
			fallback: true,
		});
		await postPreview(app, { kind: "membership", style: STYLE, content: {}, fallback: true });
		expect(api.fetchUserCard).not.toHaveBeenCalled();
		expect(sc.mock.calls[0]?.[0]?.viewer.name).toBe("登录名");
		sc.mockRestore();
		guard.mockRestore();
	});

	it("guard:viewer.name=登录账号(fallback:true 的 per-UP 风格请求)", async () => {
		const spy = vi
			.spyOn(ImageRenderer.prototype, "generateMembershipCard")
			.mockResolvedValue(Buffer.from("x"));
		const app = createCardsRoute({
			deps: makeDeps(),
			puppeteer: makeFakePuppeteer(),
			api: loggedInApi(),
		});
		const res = await postPreview(app, {
			kind: "membership",
			style: STYLE,
			content: { tierKey: "captain" },
			fallback: true,
		});
		expect(res.status).toBe(200);
		const arg = spy.mock.calls[0]?.[0] as { viewer: { name: string } };
		expect(arg.viewer.name).toBe("登录名");
		spy.mockRestore();
	});

	it("sc:per-UP 传 uid → 接收方按 getMasterInfo 解析真实 UP,发送者仍为登录账号", async () => {
		const api = {
			getMyselfInfoCached: vi.fn(async () => ({ code: 0, data: { mid: 999, uname: "登录名" } })),
			fetchUserCard: vi.fn(async () => ({
				code: 0,
				data: { card: { name: "登录名", face: "https://i0.hdslb.com/face.png" } },
			})),
			getMasterInfo: vi.fn(async () => ({
				code: 0,
				data: { info: { uname: "真实UP", face: "https://i0.hdslb.com/up.png" } },
			})),
		} as unknown as Api;
		const spy = vi
			.spyOn(ImageRenderer.prototype, "generateSuperchatCard")
			.mockResolvedValue(Buffer.from("x"));
		const app = createCardsRoute({ deps: makeDeps(), puppeteer: makeFakePuppeteer(), api });
		const res = await postPreview(app, {
			kind: "superchat",
			style: STYLE,
			content: { uid: "12345", amount: 30 },
			fallback: true,
		});
		expect(res.status).toBe(200);
		const arg = spy.mock.calls[0]?.[0] as { viewer: { name: string }; creator: { name: string } };
		expect(arg.creator.name).toBe("真实UP");
		expect(arg.viewer.name).toBe("登录名");
		spy.mockRestore();
	});

	it("sc:接收方 getMasterInfo 失败 + fallback → 回退示例 UP,200", async () => {
		const api = {
			getMyselfInfoCached: vi.fn(async () => ({ code: 0, data: { mid: 999, uname: "登录名" } })),
			fetchUserCard: vi.fn(async () => ({
				code: 0,
				data: { card: { name: "登录名", face: "https://i0.hdslb.com/face.png" } },
			})),
			getMasterInfo: vi.fn(async () => {
				throw new Error("network");
			}),
		} as unknown as Api;
		const spy = vi
			.spyOn(ImageRenderer.prototype, "generateSuperchatCard")
			.mockResolvedValue(Buffer.from("x"));
		const app = createCardsRoute({ deps: makeDeps(), puppeteer: makeFakePuppeteer(), api });
		const res = await postPreview(app, {
			kind: "superchat",
			style: STYLE,
			content: { uid: "12345", amount: 30 },
			fallback: true,
		});
		expect(res.status).toBe(200);
		const arg = spy.mock.calls[0]?.[0] as { creator: { name: string } };
		expect(arg.creator.name).toBe("示例 UP 主");
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
		const fetchUserCard = vi.fn(async () => ({
			code: 0,
			data: { card: { name: "登录名", face: "https://i0.hdslb.com/face.png" } },
		}));
		const api = { getMyselfInfoCached, fetchUserCard } as unknown as Api;
		const spy = vi
			.spyOn(ImageRenderer.prototype, "generateSuperchatCard")
			.mockResolvedValue(Buffer.from("x"));
		const app = createCardsRoute({
			deps: makeDeps(),
			puppeteer: makeFakePuppeteer(),
			api,
		});

		await postPreview(app, { kind: "superchat", style: STYLE, content: { amount: 30 } });
		// 跨过 5 分钟 TTL,迫使第二次重新解析 → getMyselfInfoCached 抛错 → 走 stale-while-error。
		vi.setSystemTime(new Date("2026-01-01T00:06:00Z"));
		await postPreview(app, { kind: "superchat", style: STYLE, content: { amount: 30 } });

		const lastArg = spy.mock.calls.at(-1)?.[0] as { viewer: { name: string } };
		expect(lastArg.viewer.name).toBe("登录名"); // 没有闪回「示例粉丝」
		expect(getMyselfInfoCached).toHaveBeenCalledTimes(2); // 确实重试了第二次(并失败)
		spy.mockRestore();
		vi.useRealTimers();
	});
});

// ── 预览也走皮肤(ADR-0014 决策 15 / 22) ──────────────────────────────────────

describe("cards route — /preview 走皮肤", () => {
	const STYLE = {};

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
						html: "<p>SKIN-MARK-{creator.name}</p>",
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
		return { captured, pup: { page: vi.fn(async () => page) } as unknown as PuppeteerAdapter };
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
			fetchLiveRoomInfo: vi.fn(async () => ({ code: 0, data: { uid: 12345, live_status: 1 } })),
			getMasterInfo: vi.fn(async () => ({
				code: 0,
				data: { info: { uname: "真实UP", face: "https://i0.hdslb.com/up.png" } },
			})),
		} as unknown as Api;
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
		const colorOptions = spy.mock.calls[0]?.[1] as { cardSkin?: string } | undefined;
		expect(colorOptions?.cardSkin).toBe("marked");
		spy.mockRestore();
	});

	/**
	 * 真实直播预览(`renderRealLive`)是「B 站房间数据 → `liveCardInputFromRoomInfo` → `generateLiveCard`」这一条
	 * (㉒c,出卡入口收成一个以后不再有吃原始数据的那个):路由没有测试钉着的话,零件各自绿也证明不了它接上了。
	 * 验红:把 renderRealLive 里的 `liveCardInputFromRoomInfo(…)` 换成直接递房间数据,或把状态写死成别的,这条红。
	 * 这位 UP 不是订阅的:按主播信息里的头像地址现抓(本例的图库抓取走假客户端,见下面「没订阅的 UP」用例)。
	 */
	it("真实直播那条路:先翻成中立输入、封面抓进图库,再交给 generateLiveCard,没订阅的 UP 头像现抓", async () => {
		const http = imageHttp();
		const api = {
			http,
			fetchLiveRoomInfo: vi.fn(async () => ({
				code: 0,
				data: {
					uid: 12345,
					live_status: 0,
					title: "真实标题",
					area_name: "真实分区",
					user_cover: "https://i0.hdslb.com/cover.png",
					keyframe: "",
					live_time: "2026-09-13 20:00:00",
					online: 321,
				},
			})),
			getMasterInfo: vi.fn(async () => ({
				code: 0,
				data: { info: { uname: "真实UP", face: "https://i0.hdslb.com/up.png" } },
			})),
		} as unknown as Api;
		const spy = vi
			.spyOn(ImageRenderer.prototype, "generateLiveCard")
			.mockResolvedValue(Buffer.from("x"));
		const app = createCardsRoute({
			deps: makeDeps(),
			puppeteer: makeFakePuppeteer(),
			api,
		});
		const res = await postPreview(app, {
			kind: "live",
			style: STYLE,
			content: { roomId: "778899" },
		});
		expect(res.status).toBe(200);
		expect(spy.mock.calls[0]?.[0]).toStrictEqual({
			// 预览恒按「直播中」出卡(状态码 2),没在播的房间也一样。
			status: "streaming",
			// 这位 UP 没订阅:头像按主播信息里的地址现抓(头像档)。
			creator: { name: "真实UP", avatar: PREVIEW_IMAGE_REF },
			title: "真实标题",
			category: "真实分区",
			description: "",
			// 预览与真推送同一条:出卡前封面经 B 站接口的请求客户端抓进图库(3a-34),原地址留着。
			// 验红:删掉 renderRealLive 里的 `fetchLiveCover`,这条红(封面只有地址)。
			cover: { url: "https://i0.hdslb.com/cover.png", ref: PREVIEW_IMAGE_REF },
			startedAt: "2026-09-13T12:00:00.000Z",
			currentViewers: 321,
		});
		expect(http.fetch.mock.calls.map((call) => String(call[0]))).toEqual([
			"https://i0.hdslb.com/up.png",
			"https://i0.hdslb.com/cover.png",
		]);
		spy.mockRestore();
	});

	// 3a-35(主人定):预览里没订阅的 UP,头像按拉回来的地址现抓(头像档),抓到有头像、抓不到不画、预览照出。
	// 验红:去掉 cards.ts `renderRealLive` 里 `fetchAvatar(...)` 那一支,头一条红。
	it("真实直播那条路:没订阅的 UP 按主播信息里的头像地址现抓;抓不到就没有头像、预览照出", async () => {
		const face = "https://i0.hdslb.com/bfs/face/up.jpg";
		const apiOf = (http: unknown) =>
			({
				http,
				fetchLiveRoomInfo: vi.fn(async () => ({
					code: 0,
					data: { uid: 999, live_status: 1, title: "t", user_cover: "", keyframe: "" },
				})),
				getMasterInfo: vi.fn(async () => ({
					code: 0,
					data: { info: { uname: "路人UP", face } },
				})),
			}) as unknown as Api;
		const spy = vi
			.spyOn(ImageRenderer.prototype, "generateLiveCard")
			.mockResolvedValue(Buffer.from("x"));
		const okHttp = imageHttp();
		const okApp = createCardsRoute({
			deps: makeDeps(),
			puppeteer: makeFakePuppeteer(),
			api: apiOf(okHttp),
		});
		expect(
			(await postPreview(okApp, { kind: "live", style: STYLE, content: { roomId: "778899" } }))
				.status,
		).toBe(200);
		expect(okHttp.fetch.mock.calls.map((call) => String(call[0]))).toEqual([
			`${face}@480w_80q_1s.webp`,
		]);
		expect(spy.mock.calls[0]?.[0]).toMatchObject({
			creator: { name: "路人UP", avatar: PREVIEW_IMAGE_REF },
		});

		const failHttp = { fetch: vi.fn(async () => fail("unavailable", "测试不联网")) };
		const failApp = createCardsRoute({
			deps: makeDeps(),
			puppeteer: makeFakePuppeteer(),
			api: apiOf(failHttp),
		});
		expect(
			(await postPreview(failApp, { kind: "live", style: STYLE, content: { roomId: "778899" } }))
				.status,
		).toBe(200);
		expect((spy.mock.calls[1]?.[0] as { creator: object } | undefined)?.creator).toStrictEqual({
			name: "路人UP",
		});
		spy.mockRestore();
	});

	it("真实动态那条路:没订阅的 UP 按外层作者的头像地址现抓;抓不到就没有头像", async () => {
		const face = "https://i0.hdslb.com/bfs/face/author.jpg";
		const rawItem = {
			basic: {},
			id_str: "1",
			type: "DYNAMIC_TYPE_WORD",
			modules: {
				module_author: { name: "路人UP", face, pub_ts: 1_700_000_000, vip: { type: 0 } },
				module_dynamic: { desc: { text: "你好", rich_text_nodes: [] } },
			},
		};
		const spy = vi
			.spyOn(ImageRenderer.prototype, "generatePostCard")
			.mockResolvedValue(Buffer.from("x"));
		const run = async (http: unknown) => {
			const api = {
				http,
				fetchUserSpaceDynamic: vi.fn(async () => ({ code: 0, data: { items: [rawItem] } })),
			} as unknown as Api;
			const app = createCardsRoute({ deps: makeDeps(), puppeteer: makeFakePuppeteer(), api });
			return postPreview(app, { kind: "post", style: STYLE, content: { uid: "999" } });
		};
		const okHttp = imageHttp();
		expect((await run(okHttp)).status).toBe(200);
		expect(okHttp.fetch.mock.calls.map((call) => String(call[0]))).toEqual([
			`${face}@480w_80q_1s.webp`,
		]);
		expect((spy.mock.calls[0]?.[0] as Post | undefined)?.creator.avatar).toBe(PREVIEW_IMAGE_REF);
		expect(
			(await run({ fetch: vi.fn(async () => fail("unavailable", "测试不联网")) })).status,
		).toBe(200);
		// 先钉第二张卡确实出了,下面那句「没有头像」才不是空过。
		expect(spy).toHaveBeenCalledTimes(2);
		expect((spy.mock.calls[1]?.[0] as Post | undefined)?.creator.avatar).toBeUndefined();
		spy.mockRestore();
	});

	// 3a-35:已订阅的 UP,真实直播预览的主播头像读订阅资料里的引用(和真推送一致)。
	// 验红:去掉 cards.ts `renderRealLive` 里递给 `liveCardInputFromRoomInfo` 的头像,这条红。
	it("真实直播那条路:已订阅的 UP 带资料里的头像,不为它联网", async () => {
		const http = imageHttp();
		const api = {
			http,
			fetchLiveRoomInfo: vi.fn(async () => ({
				code: 0,
				data: { uid: 12345, live_status: 1, title: "t", user_cover: "", keyframe: "" },
			})),
			getMasterInfo: vi.fn(async () => ({
				code: 0,
				data: { info: { uname: "真实UP", face: "https://i0.hdslb.com/up.png" } },
			})),
		} as unknown as Api;
		const spy = vi
			.spyOn(ImageRenderer.prototype, "generateLiveCard")
			.mockResolvedValue(Buffer.from("x"));
		const app = createCardsRoute({
			deps: makeDeps(undefined, { subscribed: true }),
			puppeteer: makeFakePuppeteer(),
			api,
		});
		const res = await postPreview(app, {
			kind: "live",
			style: STYLE,
			content: { roomId: "778899" },
		});
		expect(res.status).toBe(200);
		expect(spy.mock.calls[0]?.[0]).toMatchObject({
			creator: { name: "真实UP", avatar: SUBSCRIBED_AVATAR },
		});
		expect(http.fetch).not.toHaveBeenCalled();
		spy.mockRestore();
	});

	/**
	 * 真实动态预览(`renderRealDynamic`)也是「B 站原始动态 → `postFromDynamic` → `generatePostCard`」这一条:
	 * 路由没有测试钉着的话,零件各自绿也证明不了它接上了。验红:把 renderRealDynamic 里的
	 * `postFromDynamic(item)` 换成直接递原始动态,或把皮肤 id 那一格删掉,这条红。
	 */
	it("真实动态那条路:先翻成 Post 再交给 generatePostCard,皮肤 id 在 colorOptions 里", async () => {
		const rawItem = {
			basic: {},
			id_str: "1",
			type: "DYNAMIC_TYPE_WORD",
			modules: {
				module_author: { name: "真实UP", pub_ts: 1_700_000_000, vip: { type: 0 } },
				module_dynamic: {
					desc: {
						text: "你好",
						rich_text_nodes: [
							{ type: "RICH_TEXT_NODE_TYPE_TEXT", orig_text: "你好", text: "你好" },
						],
					},
				},
				module_stat: { forward: { count: 1 }, comment: { count: 2 }, like: { count: 3 } },
			},
		};
		const api = {
			fetchUserSpaceDynamic: vi.fn(async () => ({ code: 0, data: { items: [rawItem] } })),
		} as unknown as Api;
		const spy = vi
			.spyOn(ImageRenderer.prototype, "generatePostCard")
			.mockResolvedValue(Buffer.from("x"));
		const app = createCardsRoute({
			deps: globalsDeps(DEFAULT_CARD_SKIN_ID),
			puppeteer: makeFakePuppeteer(),
			api,
			cardSkins: skinStore({ marked: MARKED }),
		});
		const res = await postPreview(app, {
			kind: "post",
			style: STYLE,
			content: { uid: "12345" },
			cardSkin: "marked",
		});
		expect(res.status).toBe(200);
		const post = spy.mock.calls[0]?.[0];
		expect(post).toMatchObject({ creator: { name: "真实UP" }, text: "你好" });
		expect(post).not.toHaveProperty("modules");
		expect((spy.mock.calls[0]?.[1] as { cardSkin?: string } | undefined)?.cardSkin).toBe("marked");
		spy.mockRestore();
	});

	// 验红:删掉 renderRealDynamic 里的 `fetchPostImages`,这条红(配图只有地址,出图器只认引用)。
	it("真实动态那条路:作品里的配图先抓进图库,再交给 generatePostCard", async () => {
		const pic = "https://i0.hdslb.com/bfs/new_dyn/pic.jpg";
		const rawItem = {
			basic: {},
			id_str: "1",
			type: "DYNAMIC_TYPE_DRAW",
			modules: {
				module_author: { name: "真实UP", pub_ts: 1_700_000_000, vip: { type: 0 } },
				module_dynamic: {
					desc: { text: "", rich_text_nodes: [] },
					major: { opus: { pics: [{ url: pic, width: 10, height: 20 }] } },
				},
				module_stat: { forward: { count: 1 }, comment: { count: 2 }, like: { count: 3 } },
			},
		};
		const http = imageHttp();
		const api = {
			http,
			fetchUserSpaceDynamic: vi.fn(async () => ({ code: 0, data: { items: [rawItem] } })),
		} as unknown as Api;
		const spy = vi
			.spyOn(ImageRenderer.prototype, "generatePostCard")
			.mockResolvedValue(Buffer.from("x"));
		const app = createCardsRoute({
			deps: globalsDeps(DEFAULT_CARD_SKIN_ID),
			puppeteer: makeFakePuppeteer(),
			api,
		});
		const res = await postPreview(app, { kind: "post", style: STYLE, content: { uid: "12345" } });
		expect(res.status).toBe(200);
		const post = spy.mock.calls[0]?.[0] as { images?: { url?: string; ref?: string }[] };
		expect(post.images?.[0]).toMatchObject({ url: pic, ref: PREVIEW_IMAGE_REF });
		expect(String(http.fetch.mock.calls[0]?.[0])).toBe(`${pic}@1280w_80q_1s.webp`);
		spy.mockRestore();
	});

	// 3a-35:预览的真实拉取与真推送一致 —— 已订阅的 UP 读订阅资料里的头像引用,转发的原作者头像现抓。
	// 验红:去掉 cards.ts `renderRealDynamic` 里递给 fetchPostImages 的 `avatar` / `repostAvatarUrl`,这条红。
	it("真实动态那条路:已订阅的 UP 带资料里的头像,转发的原作者头像现抓", async () => {
		const face = "https://i0.hdslb.com/bfs/face/orig.jpg";
		const rawItem = {
			basic: {},
			id_str: "1",
			type: "DYNAMIC_TYPE_FORWARD",
			modules: {
				module_author: { name: "真实UP", pub_ts: 1_700_000_000, vip: { type: 0 } },
				module_dynamic: { desc: { text: "转发", rich_text_nodes: [] } },
			},
			orig: {
				type: "DYNAMIC_TYPE_WORD",
				modules: {
					module_author: { name: "原作者", face, pub_ts: 1_700_000_000, vip: { type: 0 } },
					module_dynamic: { desc: { text: "原文", rich_text_nodes: [] } },
				},
			},
		};
		const http = imageHttp();
		const api = {
			http,
			fetchUserSpaceDynamic: vi.fn(async () => ({ code: 0, data: { items: [rawItem] } })),
		} as unknown as Api;
		const spy = vi
			.spyOn(ImageRenderer.prototype, "generatePostCard")
			.mockResolvedValue(Buffer.from("x"));
		const deps = makeDeps(undefined, { subscribed: true });
		(deps.store as unknown as { getGlobals: () => unknown }).getGlobals = () => ({
			defaults: { cardSkin: DEFAULT_CARD_SKIN_ID },
		});
		const app = createCardsRoute({ deps, puppeteer: makeFakePuppeteer(), api });
		const res = await postPreview(app, { kind: "post", style: STYLE, content: { uid: "12345" } });
		expect(res.status).toBe(200);
		const post = spy.mock.calls[0]?.[0] as Post;
		expect(post.creator.avatar).toBe(SUBSCRIBED_AVATAR);
		expect(post.repost?.creator.avatar).toBe(PREVIEW_IMAGE_REF);
		expect(http.fetch.mock.calls.map((call) => String(call[0]))).toEqual([
			`${face}@480w_80q_1s.webp`,
		]);
		spy.mockRestore();
	});

	it("SC / 上舰同样带着皮肤 id", async () => {
		const spy = vi
			.spyOn(ImageRenderer.prototype, "generateSuperchatCard")
			.mockResolvedValue(Buffer.from("x"));
		const app = createCardsRoute({
			deps: globalsDeps(DEFAULT_CARD_SKIN_ID),
			puppeteer: makeFakePuppeteer(),
			api: null,
			cardSkins: skinStore({ marked: MARKED }),
		});
		const res = await postPreview(app, {
			kind: "superchat",
			style: STYLE,
			content: { amount: 30 },
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
			.spyOn(ImageRenderer.prototype, "generateSuperchatCard")
			.mockResolvedValue(Buffer.from("x"));
		const app = createCardsRoute({
			deps: globalsDeps("marked"),
			puppeteer: makeFakePuppeteer(),
			api: null,
			cardSkins: skinStore({ marked: MARKED }),
		});
		const res = await postPreview(app, {
			kind: "superchat",
			style: STYLE,
			content: { amount: 30 },
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
			fetchLiveRoomInfo: vi.fn(async () => ({ code: 0, data: { uid: 12345, live_status: 1 } })),
			getMasterInfo: vi.fn(async () => ({
				code: 0,
				data: { info: { uname: "真实UP", face: "https://i0.hdslb.com/up.png" } },
			})),
		} as unknown as Api;
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
		const colorOptions = spy.mock.calls[0]?.[1] as { cardSkin?: string } | undefined;
		expect(colorOptions?.cardSkin).toBe("marked");
		spy.mockRestore();
	});

	/**
	 * 测试推送与预览出图走同一份 `renderPreviewCard`,请求里的皮肤与 per-UP 草稿旋钮也得一起交进去
	 * —— 所见即所推。验红:把 `/test` 里交给 `renderPreviewCard` 的 `cardSkin` 或 `cardSkinKnobs`
	 * 删掉,这条红。
	 */
	it("测试推送同样带着请求里的皮肤与草稿旋钮,推给所选目标", async () => {
		const TARGET_ID = "22222222-2222-4222-8222-222222222222";
		const spy = vi
			.spyOn(ImageRenderer.prototype, "generateSuperchatCard")
			.mockResolvedValue(Buffer.from("x"));
		try {
			const sendToTarget = vi.fn(async () => ({ ok: true, latencyMs: 3 }));
			const d = globalsDeps(DEFAULT_CARD_SKIN_ID) as unknown as {
				runtime: { engines?: unknown };
				store: { getTargets?: () => unknown };
			};
			d.runtime.engines = { push: { sendToTarget } };
			d.store.getTargets = () => [{ id: TARGET_ID, name: "群一", enabled: true }];
			const app = createCardsRoute({
				deps: d as unknown as RouteDeps,
				puppeteer: makeFakePuppeteer(),
				api: null,
				cardSkins: skinStore({ marked: MARKED }),
			});
			const res = await app.request("/test", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					targetId: TARGET_ID,
					kind: "superchat",
					style: STYLE,
					content: { amount: 30 },
					cardSkin: "marked",
					cardSkinKnobs: { marked: { accent: "#00f0ff" } },
					fallback: true,
				}),
			});
			expect(res.status).toBe(200);
			const colorOptions = spy.mock.calls[0]?.[1] as
				| { cardSkin?: string; cardSkinKnobs?: unknown }
				| undefined;
			expect(colorOptions?.cardSkin).toBe("marked");
			expect(colorOptions?.cardSkinKnobs).toEqual({ marked: { accent: "#00f0ff" } });
			expect(sendToTarget).toHaveBeenCalledWith(
				TARGET_ID,
				expect.objectContaining({ kind: "image" }),
			);
		} finally {
			// 断言红了也得还原:漏掉的 spy 会让后面那条用例跟着红。
			spy.mockRestore();
		}
	});
});

/**
 * `POST /skins/:id/screenshot` —— 编辑器那颗「最终效果」(ADR-0014 决策 22;皮肤 id 在路径里,ADR-0036)。
 *
 * 实时预览回的是 HTML,由**看的人的浏览器**画;推出去那张是 **server 上的 Chrome** 画的,
 * 字体渲染像素级对不上。这个端点补的正是那一刀。
 *
 * 钉三条:① **与实时预览同源** —— 两边各走各的话,作者会看着一个能用的预览、截出一张
 * 不一样的图,而两边都说不出哪儿错了;② 没配 Chrome 回 **503 带办法**,不是一句「失败了」
 * (编辑器照它把按钮禁掉并说清楚);③ 回**高度**,超上限要如实说 —— 出图那头超了会静默
 * 回落默认皮肤(决策 19),而编辑器是作者唯一能提前知道的地方。
 */
describe("cards route — POST /skins/:id/screenshot 最终效果", () => {
	const draft = () => structuredClone(DEFAULT_CARD_SKIN) as Record<string, unknown>;

	type ShotJson = {
		ok: boolean;
		dataUrl?: string;
		width?: number;
		height?: number;
		overHeight?: boolean;
		scene?: string;
		code?: string;
		message?: string;
		issues?: Array<{ message: string }>;
	};

	async function shot(
		body: unknown,
		puppeteer: PuppeteerAdapter | null,
		skinId: string = DEFAULT_CARD_SKIN_ID,
	) {
		const dir = join(tmpdir(), "bn-test-skin-screenshot-no-such-dir");
		const app = createCardsRoute({
			deps: depsWithDataDir(dir),
			puppeteer,
			api: null,
			cardSkins: new CardSkinStore({ dir: join(dir, "card-skins") }),
		});
		const res = await app.request(`/skins/${skinId}/screenshot`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		return { res, json: (await res.json()) as ShotJson };
	}

	it("截出一张图,回 dataUrl + 卡宽 + 高度", async () => {
		const { res, json } = await shot({ kind: "live", manifest: draft() }, makeFakePuppeteer());
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
		const { res } = await shot({ kind: "live", manifest: draft() }, makeFakePuppeteer());
		expect(res.status).toBe(200);
		expect(capturedHtml.length).toBeGreaterThan(0);
		// 验红:给截图那条也传 `transparentPage: true`,这条红。
		expect(capturedHtml[0]).not.toContain("background:transparent");
	});

	it("路径里的皮肤 id 不合规 → invalid(400),不会去截", async () => {
		const { res, json } = await shot(
			{ kind: "live", manifest: draft() },
			makeFakePuppeteer(),
			"Bad_Id",
		);
		expect(res.status).toBe(400);
		expect(json.code).toBe("invalid");
	});

	it("没配 Chrome → not_configured(409),并且把该怎么办说出来", async () => {
		const { res, json } = await shot({ kind: "live", manifest: draft() }, null);
		expect(res.status).toBe(409);
		expect(json.code).toBe("not_configured");
		expect(json.message).toContain("BN_CHROME_PATH");
		expect(json).not.toHaveProperty("ok");
	});

	it("草稿过的是与实时预览同一道装包门 —— 拒了就 invalid(400),逐条原因进 issues", async () => {
		const { res, json } = await shot(
			{ kind: "live", manifest: { schemaVersion: 2 } },
			makeFakePuppeteer(),
		);
		expect(res.status).toBe(400);
		expect(json.code).toBe("invalid");
		expect(json.message).toContain("这版草稿没通过检查");
		expect(json.issues?.length).toBeGreaterThan(0);
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

		const { res, json } = await shot({ kind: "live", manifest: d }, p);
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

		const { res, json } = await shot({ kind: "live", manifest: draft() }, tall);
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
				dataRoot: dataDir,
				serviceCtx: {
					logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
				},
			},
			store: {
				getGlobals: () => ({
					defaults: {
						cardSkin: DEFAULT_CARD_SKIN_ID,
						cardSkinKnobs: { [DEFAULT_CARD_SKIN_ID]: knobs },
					},
				}),
			},
		} as unknown as RouteDeps;
	}

	for (const kind of ["live", "post"] as const) {
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

	/**
	 * **超过 CSS 自定义属性 2 MiB 上限的图要先压一下。** Blink 对一条自定义属性的值封顶
	 * `2,097,152` 字符,超了**整条声明在解析期就被丢掉** —— 于是皮肤 CSS 里的
	 * `var(--bn-knob-wallpaper, 渐变)` 判定「没设」、安安静静画兜底渐变。主人那张 1.7MB
	 * 的背景图正是栽在这儿:HTML 那头一个字节不少,只有真 Chrome 的 `getComputedStyle`
	 * 看得见它是空的(2026-09-20 真机量的)。
	 *
	 * 判据:把 `renderPreviewCard` 里那个 `shrinkImage` 拆掉,这一条必须红 —— 那时注进去的
	 * 是原样的 png,长度越线,等于交给 Chrome 再丢一次。
	 */
	it("大图先压进 2 MiB 预算再注 —— 不然 Chrome 整条丢弃、预览画兜底", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bn-knob-preview-big-"));
		try {
			const big = new Uint8Array(1_600_000);
			big.set(PNG, 0);
			const assetId = await saveCardBg(dir, big, "image/png");
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
					kind: "live",
					style: {},
					content: {},
					cardSkin: DEFAULT_CARD_SKIN_ID,
				}),
			});
			expect(res.status).toBe(200);
			const html = capturedHtml.join("");
			expect(html).toMatch(/--bn-knob-wallpaper:url\((?:"|&quot;)data:image\/webp;base64,/);
			const value = /--bn-knob-wallpaper:([^;]*)/.exec(html)?.[1] ?? "";
			expect(value.length).toBeLessThanOrEqual(CSS_CUSTOM_PROPERTY_MAX_CHARS);
			expect(html).not.toContain("--bn-knob-wallpaper:url(&quot;data:image/png");
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

/**
 * **per-UP 那侧的预览吃草稿里的旋钮**(ADR-0014 决策 17 的 🔗,2026-09-24;缺省只在一处解析那条
 * 见决策 19 的 🔗)。面板在 per-UP 作用域把这位 UP 那层草稿(按皮肤 id 分)放进请求体,服务端在
 * 出图那一刻与**配置里的全局那份**逐枚合并 —— 所以拧一格预览当场变,不必先保存;全局作用域一个字
 * 都不传,照旧只认全局。四条出图路子(SC / 上舰 / 真实拉取走渲染器,直播 / 动态示例走 SSR)
 * 都要认它,这里各挑一条:SSR 那条与渲染器那条。
 */
describe("cards route — per-UP 预览带草稿旋钮", () => {
	function depsWithGlobalKnobs(dataDir: string): RouteDeps {
		return {
			runtime: {
				dataRoot: dataDir,
				serviceCtx: {
					logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
				},
			},
			store: {
				getGlobals: () => ({
					defaults: {
						cardSkin: DEFAULT_CARD_SKIN_ID,
						cardSkinKnobs: {
							[DEFAULT_CARD_SKIN_ID]: { "gradient-start": "#111111", "gradient-end": "#222222" },
						},
					},
				}),
			},
		} as unknown as RouteDeps;
	}

	async function preview(dataDir: string, body: Record<string, unknown>): Promise<string> {
		capturedHtml.length = 0;
		const app = createCardsRoute({
			deps: depsWithGlobalKnobs(dataDir),
			puppeteer: makeFakePuppeteer(),
			api: null,
		});
		const res = await app.request("/preview", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ style: {}, content: {}, fallback: true, ...body }),
		});
		expect(res.status).toBe(200);
		return capturedHtml.join("");
	}

	/** 验红:把 `renderPreviewCard` 示例那条的 `knobValues` 换回只取全局那份,这条红。 */
	it("示例直播卡:草稿拧过的赢、没拧的跟全局,草稿里的壁纸也读了盘", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bn-perup-preview-"));
		try {
			const assetId = await saveCardBg(dir, PNG, "image/png");
			const html = await preview(dir, {
				kind: "live",
				cardSkinKnobs: {
					[DEFAULT_CARD_SKIN_ID]: { "gradient-start": "#aaaaaa", wallpaper: [assetId] },
				},
			});
			expect(html).toContain("--bn-knob-gradient-start:#aaaaaa");
			expect(html).not.toContain("#111111");
			expect(html).toContain("--bn-knob-gradient-end:#222222");
			expect(html).toMatch(/--bn-knob-wallpaper:url\((?:"|&quot;)data:image\/png;base64,/);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	/** 验红:把 SC 那条交给 `generateSuperchatCard` 的 `cardSkinKnobs` 删掉,这条红。 */
	it("SC 卡(走渲染器那条):草稿同样逐枚叠在全局上", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bn-perup-preview-sc-"));
		try {
			const html = await preview(dir, {
				kind: "superchat",
				content: { amount: 30 },
				cardSkinKnobs: { [DEFAULT_CARD_SKIN_ID]: { "gradient-start": "#aaaaaa" } },
			});
			expect(html).toContain("--bn-knob-gradient-start:#aaaaaa");
			expect(html).not.toContain("#111111");
			expect(html).toContain("--bn-knob-gradient-end:#222222");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("草稿存的是别的皮肤那份 → 这张预览不认它", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bn-perup-preview-other-"));
		try {
			const html = await preview(dir, {
				kind: "live",
				cardSkinKnobs: { cyberpunk: { "gradient-start": "#aaaaaa" } },
			});
			expect(html).toContain("--bn-knob-gradient-start:#111111");
			expect(html).not.toContain("#aaaaaa");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
