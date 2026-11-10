import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BILIBILI_SOURCE_KEY } from "@bilibili-notify/contract";
import { CSS_CUSTOM_PROPERTY_MAX_CHARS, ImageRenderer } from "@bilibili-notify/image";
import {
	CARD_SKIN_LIMITS,
	type CardSkinManifest,
	DEFAULT_CARD_SKIN,
	DEFAULT_CARD_SKIN_ID,
	fail,
	type LiveInteractionReader,
	makeEmptySubscription,
	ok,
	type Post,
	type Source,
} from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { CardSkinStore } from "../../card-skins/store.js";
import { i18n } from "../../i18n/index.js";
import { saveCardBg } from "../../runtime/card-assets.js";
import type { PuppeteerAdapter } from "../../runtime/puppeteer.js";
import { bilibiliLikeSources, sourceRegistryOf } from "../../subscriptions/__tests__/fixtures.js";
import type { SourceRegistry } from "../../subscriptions/registry.js";
import { createCardsRoute, testPushCaption } from "../cards.js";
import type { RouteDeps } from "../types.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 预览路由要从配置里取「这套皮肤的旋钮覆盖」,所以每个 store 替身都得有 `getGlobals`。
 * 空 defaults = 没换过皮肤、一个旋钮都没拧过。
 */
const EMPTY_GLOBALS = {
	defaults: { cardSkin: "default", cardSkinKnobs: {} },
	timezone: "Asia/Shanghai",
};

function depsWithDataDir(dataDir: string, timezone = "Asia/Shanghai"): RouteDeps {
	return {
		runtime: {
			sourceRegistry: bilibiliLikeSources(),
			dataRoot: dataDir,
			serviceCtx: {
				logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
			},
		},
		// 预览的真实拉取要按 uid 找订阅(读资料里的头像);这些用例没有订阅。
		store: { getGlobals: () => ({ ...EMPTY_GLOBALS, timezone }), getSubscriptions: () => [] },
	} as unknown as RouteDeps;
}

/** 描述符或来源懒取口交回的徽章图引用。 */
const GUARD_ICON_REF = `${"d".repeat(64)}.png`;

/** 预览里「已订阅的那位 UP」:有这一个订阅,资料里存着头像引用。 */
const SUBSCRIBED_UID = "12345";
const SUBSCRIBED_AVATAR = `${"f".repeat(64)}.jpg`;

function makeDeps(
	sourceRegistry: SourceRegistry = bilibiliLikeSources({ iconRef: GUARD_ICON_REF }),
	opts: { subscribed?: boolean } = {},
): RouteDeps {
	const subscription = makeEmptySubscription({
		id: "11111111-1111-1111-1111-111111111111",
		identity: { sourceKey: BILIBILI_SOURCE_KEY, externalId: SUBSCRIBED_UID },
	});
	return {
		runtime: {
			// 会员档位读口读它:预览按档的 key 找档、示例取最低一档,路由里不认识任何平台的档位表。
			sourceRegistry,
			// 订阅资料里的头像(`cachedProfile.avatar`):预览的真实拉取读它,不为头像联网。
			subscriptionStateStore: {
				get: (id: string) =>
					opts.subscribed && id === subscription.id
						? { cachedProfile: { name: "真实UP", avatar: SUBSCRIBED_AVATAR } }
						: undefined,
			},
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

describe("cards route — testPushCaption(测试推送图说)", () => {
	it("每种卡片类型 → 带「测试推送」前缀 + 该类型中文标签的文案", () => {
		expect(testPushCaption("live")).toContain("直播卡");
		expect(testPushCaption("post")).toContain("作品卡");
		expect(testPushCaption("superchat")).toContain("醒目留言卡");
		expect(testPushCaption("membership")).toContain("会员卡");
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
			detectChrome: () => null,
		});
		const res = await app.request("/chrome");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ path: null });
	});
});

describe("cards route — POST /renderer(热启用渲染)", () => {
	function depsWithPipeline(
		enableImageRendering: ReturnType<typeof vi.fn>,
		swapImageRendering: ReturnType<typeof vi.fn> = vi.fn(),
	): RouteDeps {
		return {
			runtime: {
				serviceCtx: {
					logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
				},
				pipeline: { enableImageRendering, swapImageRendering },
			},
		} as unknown as RouteDeps;
	}

	it("POST /renderer: 构造 puppeteer + 热启用推送链路 + 写回配置 + 通知", async () => {
		const fakePup = { dispose: vi.fn(async () => {}) } as unknown as PuppeteerAdapter;
		const createPuppeteer = vi.fn(() => fakePup);
		const enableImageRendering = vi.fn(() => true);
		const persistChromeSource = vi.fn(async () => {});
		const onPuppeteerEnabled = vi.fn();
		const app = createCardsRoute({
			deps: depsWithPipeline(enableImageRendering),
			puppeteer: null,
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
			deps: depsWithPipeline(enableImageRendering),
			puppeteer: null,
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
			deps: depsWithPipeline(enableImageRendering),
			puppeteer: null,
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
			deps: depsWithPipeline(enableImageRendering, swapImageRendering),
			puppeteer: oldPup,
			initialChromeSource: { chromePath: "/usr/bin/chromium" },
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
			deps: depsWithPipeline(
				vi.fn(() => false),
				swapImageRendering,
			),
			puppeteer: oldPup,
			initialChromeSource: { chromePath: "/old/chrome" },
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
			deps: depsWithPipeline(
				vi.fn(() => false),
				vi.fn(),
			),
			puppeteer: oldPup,
			initialChromeSource: { chromePath: "/usr/bin/chromium" },
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
			deps: depsWithPipeline(
				vi.fn(() => false),
				swapImageRendering,
			),
			puppeteer: oldPup,
			initialChromeSource: { chromePath: "/usr/bin/chromium" },
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
			deps: depsWithPipeline(vi.fn()),
			puppeteer: null,
		});
		const res = await app.request("/renderer");
		expect(await res.json()).toEqual({ enabled: false, source: null, persistable: false });
	});

	it("已启用:enableImageRendering 返回 false → dispose 多余 adapter,不写回", async () => {
		const fakePup = { dispose: vi.fn(async () => {}) } as unknown as PuppeteerAdapter;
		const createPuppeteer = vi.fn(() => fakePup);
		const persistChromeSource = vi.fn(async () => {});
		const app = createCardsRoute({
			deps: depsWithPipeline(vi.fn(() => false)),
			puppeteer: null,
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
			deps: depsWithPipeline(vi.fn()),
			puppeteer: null,
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

	it("pipeline 未就绪 → unavailable(503),这是「等一会儿就好」,不是 not_configured", async () => {
		const deps = {
			runtime: {
				serviceCtx: {
					logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
				},
				pipeline: null,
			},
		} as unknown as RouteDeps;
		const app = createCardsRoute({ deps, puppeteer: null });
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

	function depsWithPipelineAndDataDir(swapImageRendering: ReturnType<typeof vi.fn>): RouteDeps {
		return {
			runtime: {
				dataRoot: join(tmpdir(), "bn-test-hotswap-no-such-dir"),
				serviceCtx: {
					logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
				},
				pipeline: { enableImageRendering: vi.fn(() => false), swapImageRendering },
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
		const deps = depsWithPipelineAndDataDir(swapImageRendering);
		const app = createCardsRoute({
			deps,
			puppeteer: pupA,
			initialChromeSource: { chromePath: "/old/chrome" },
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

		// 热切换到 pupB —— 推送链路侧的 swapImageRendering 只管推送渲染,不管路由自己缓存
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

describe("cards route — /preview 示例数据", () => {
	const STYLE = {};

	function postPreview(app: ReturnType<typeof createCardsRoute>, body: unknown) {
		return app.request("/preview", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	it("localizes sample cards on each request through the same preview route", async () => {
		const app = createCardsRoute({ deps: makeDeps(), puppeteer: makeFakePuppeteer() });
		const previous = i18n.state();
		try {
			for (const [locale, creator, title, followers] of [
				["en", "Sample creator", "Cyberpunk 2077: first playthrough of the expansion!", "2.15M"],
				["ja", "サンプルクリエイター", "【サイバーパンク2077】拡張パックを初見プレイ！", "215万"],
				["zh-TW", "範例創作者", "【電馭叛客 2077】資料片實況首播！", "215萬"],
			] as const) {
				i18n.set({ locale, voice: "plain" });
				const response = await postPreview(app, { kind: "live", style: STYLE });
				expect(response.status).toBe(200);
				expect(await response.json()).toMatchObject({
					ok: true,
					dataUrl: expect.stringMatching(/^data:image\/png;base64,/),
				});
				const html = capturedHtml.at(-1);
				expect(html).toContain(creator);
				expect(html).toContain(title);
				expect(html).toContain(followers);
				expect(html).toContain("2026-05-09 19:00:00");
			}
		} finally {
			i18n.set(previous);
		}
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
			const app = createCardsRoute({ deps: depsWithDataDir(dir), puppeteer });
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
			const app = createCardsRoute({ deps: depsWithDataDir(dir), puppeteer });
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
			const app = createCardsRoute({ deps: depsWithDataDir(dir), puppeteer });
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
});

/**
 * 挑了订阅的作品 / 直播预览(4-14):路由只问那条订阅的来源要真数据(`Source.fetchPreview`),不认识任何平台。
 * 来源没实现 → 示例,不算失败;来源回了失败 → 照样画示例,`sampleReason` 带原话(主人定:回落示例并说原因)。
 * 作者名与头像跟真推送同一条链:名字是资料名,头像作品 / 详情自己没带才用订阅资料里的。
 */
describe("cards route — /preview 挑了订阅:真数据问来源", () => {
	const STYLE = {};
	const SUB_ID = "11111111-1111-1111-1111-111111111111";
	const IDENTITY = { sourceKey: BILIBILI_SOURCE_KEY, externalId: SUBSCRIBED_UID };
	const SOURCE_COVER = `${"9".repeat(64)}.webp`;
	type FetchPreview = NonNullable<Source["fetchPreview"]>;

	function postPreview(app: ReturnType<typeof createCardsRoute>, body: unknown) {
		return app.request("/preview", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	/** 来源交的一条作品:作者自己没带头像(外层作者的头像由核心按订阅资料补,与真推送一样)。 */
	function sourcePost(): Post {
		return {
			creator: { name: "来源里的作者名" },
			publishedAt: "2023-11-14T22:13:20.000Z",
			text: "来源交的正文",
		};
	}

	const postReport = (post: Post = sourcePost()) =>
		ok({ kind: "post" as const, report: { postId: "1", url: "https://example.com/1", post } });

	function depsWith(
		fetchPreview: FetchPreview | undefined,
		opts: { subscribed?: boolean; timezone?: string; dataRoot?: string } = {},
	): RouteDeps {
		const deps = makeDeps(
			bilibiliLikeSources({ iconRef: GUARD_ICON_REF, ...(fetchPreview ? { fetchPreview } : {}) }),
			{ subscribed: opts.subscribed ?? true },
		) as unknown as {
			runtime: { dataRoot: string };
			store: { getGlobals: () => unknown };
		};
		if (opts.timezone)
			deps.store.getGlobals = () => ({ ...EMPTY_GLOBALS, timezone: opts.timezone });
		if (opts.dataRoot) deps.runtime.dataRoot = opts.dataRoot;
		return deps as unknown as RouteDeps;
	}

	it("作品:按 nth 问那条订阅的来源,它交的作品经 generatePostCard 出卡;作者没带头像就用订阅资料里的", async () => {
		const fetchPreview = vi.fn<FetchPreview>(async () => postReport());
		const spy = vi
			.spyOn(ImageRenderer.prototype, "generatePostCard")
			.mockResolvedValue(Buffer.from("x"));
		try {
			const app = createCardsRoute({
				deps: depsWith(fetchPreview),
				puppeteer: makeFakePuppeteer(),
			});
			const res = await postPreview(app, {
				kind: "post",
				style: STYLE,
				content: { subscriptionId: SUB_ID, nth: 3 },
				cardSkin: DEFAULT_CARD_SKIN_ID,
			});
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({
				ok: true,
				dataUrl: expect.stringMatching(/^data:image\/jpeg;base64,/),
			});
			expect(fetchPreview).toHaveBeenCalledWith(
				IDENTITY,
				{ kind: "post", nth: 3 },
				expect.any(AbortSignal),
			);
			const [post, colorOptions] = spy.mock.calls[0] ?? [];
			expect(post).toMatchObject({
				text: "来源交的正文",
				creator: { name: "来源里的作者名", avatar: SUBSCRIBED_AVATAR },
			});
			expect(colorOptions).toMatchObject({ cardSkin: DEFAULT_CARD_SKIN_ID });
		} finally {
			spy.mockRestore();
		}
	});

	it("作品:没给 nth 就问最新那条(1)", async () => {
		const fetchPreview = vi.fn<FetchPreview>(async () => postReport());
		const spy = vi
			.spyOn(ImageRenderer.prototype, "generatePostCard")
			.mockResolvedValue(Buffer.from("x"));
		try {
			const app = createCardsRoute({
				deps: depsWith(fetchPreview),
				puppeteer: makeFakePuppeteer(),
			});
			await postPreview(app, { kind: "post", style: STYLE, content: { subscriptionId: SUB_ID } });
			expect(fetchPreview.mock.calls[0]?.[1]).toEqual({ kind: "post", nth: 1 });
		} finally {
			spy.mockRestore();
		}
	});

	it("直播:来源交的详情翻成卡片输入,恒按直播中;作者名取资料名,详情没带头像用资料的,封面就是来源的引用", async () => {
		const fetchPreview = vi.fn<FetchPreview>(async () =>
			ok({
				kind: "live" as const,
				startedAt: "2026-03-01T03:58:30.000Z",
				details: { title: "今晚直播", cover: { ref: SOURCE_COVER } },
			}),
		);
		const spy = vi
			.spyOn(ImageRenderer.prototype, "generateLiveCard")
			.mockResolvedValue(Buffer.from("x"));
		try {
			const app = createCardsRoute({
				deps: depsWith(fetchPreview),
				puppeteer: makeFakePuppeteer(),
			});
			const res = await postPreview(app, {
				kind: "live",
				style: STYLE,
				content: { subscriptionId: SUB_ID },
				cardSkin: DEFAULT_CARD_SKIN_ID,
			});
			expect(res.status).toBe(200);
			expect(fetchPreview).toHaveBeenCalledWith(
				IDENTITY,
				{ kind: "live" },
				expect.any(AbortSignal),
			);
			const [input, colorOptions] = spy.mock.calls[0] ?? [];
			expect(input).toMatchObject({
				status: "streaming",
				title: "今晚直播",
				cover: { ref: SOURCE_COVER },
				startedAt: "2026-03-01T03:58:30.000Z",
				creator: { name: "真实UP", avatar: SUBSCRIBED_AVATAR },
			});
			expect(colorOptions).toMatchObject({ cardSkin: DEFAULT_CARD_SKIN_ID });
		} finally {
			spy.mockRestore();
		}
	});

	it("直播:liveCoverImageIds 首张悬空 → 跳过,交给 generateLiveCard 的是第一张盘上存在的图", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bn-preview-real-ghost-cover-"));
		const spy = vi
			.spyOn(ImageRenderer.prototype, "generateLiveCard")
			.mockResolvedValue(Buffer.from("x"));
		try {
			const real = await saveCardBg(dir, PNG, "image/png");
			const ghost = `${"c".repeat(32)}.png`;
			const deps = depsWith(async () => ok({ kind: "live" as const, details: {} }), {
				dataRoot: dir,
			});
			const app = createCardsRoute({ deps, puppeteer: makeFakePuppeteer() });
			const res = await postPreview(app, {
				kind: "live",
				style: { liveCoverImageIds: [ghost, real] },
				content: { subscriptionId: SUB_ID },
			});
			expect(res.status).toBe(200);
			const colorOptions = spy.mock.calls[0]?.[1] as { liveCoverImage?: string };
			expect(colorOptions.liveCoverImage).toBe(real);
		} finally {
			spy.mockRestore();
			await rm(dir, { recursive: true, force: true });
		}
	});

	/**
	 * 真数据与推送同一条:卡上的时间按全局时区排(这里纽约)。直播那条恒按「直播中」出卡、写的是时长(不随时区变),
	 * 所以走作品 —— 同一条 `getImageRenderer` 接线。验红:删掉 cards.ts 预览渲染器里的 `timezone: () => …` 那一行,这条红。
	 */
	it("作品:发布时间按全局时区写(纽约)", async () => {
		capturedHtml.length = 0;
		const app = createCardsRoute({
			deps: depsWith(async () => postReport(), { timezone: "America/New_York" }),
			puppeteer: makeFakePuppeteer(),
		});
		const res = await postPreview(app, {
			kind: "post",
			style: STYLE,
			content: { subscriptionId: SUB_ID },
		});
		expect(res.status).toBe(200);
		expect(capturedHtml.at(-1) ?? "").toContain("2023/11/14 17:13:20");
		expect(capturedHtml.at(-1) ?? "").not.toContain("2023/11/15 06:13:20");
	});

	// 验红:把 cards.ts 里「来源回了失败就记下 sampleReason」那一句删掉,这条红。
	it("来源回了失败 → 照样画一张示例卡(200 ok),sampleReason 带来源的原话", async () => {
		const app = createCardsRoute({
			deps: depsWith(async () => fail("not_found", "这位创作者还没有作品")),
			puppeteer: makeFakePuppeteer(),
		});
		const res = await postPreview(app, {
			kind: "post",
			style: STYLE,
			content: { subscriptionId: SUB_ID },
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			ok: true,
			dataUrl: expect.stringMatching(/^data:image\/png;base64,/),
			sampleReason: "这位创作者还没有作品",
		});
	});

	it("来源抛了 → 当失败收:示例卡加原话,记一行 error", async () => {
		const deps = depsWith(async () => {
			throw new Error("来源炸了");
		});
		const app = createCardsRoute({ deps, puppeteer: makeFakePuppeteer() });
		const res = await postPreview(app, {
			kind: "live",
			style: STYLE,
			content: { subscriptionId: SUB_ID },
		});
		expect(await res.json()).toMatchObject({ ok: true, sampleReason: "来源炸了" });
		const error = (deps.runtime.serviceCtx.logger as unknown as { error: ReturnType<typeof vi.fn> })
			.error;
		expect(error).toHaveBeenCalledWith("来源预览调用失败", {
			sourceKey: "bilibili",
			error: expect.objectContaining({ message: "来源炸了" }),
		});
	});

	it("来源交回的不是这一种卡 → 示例卡,说清是哪不对", async () => {
		const app = createCardsRoute({
			deps: depsWith(async () => postReport()),
			puppeteer: makeFakePuppeteer(),
		});
		const res = await postPreview(app, {
			kind: "live",
			style: STYLE,
			content: { subscriptionId: SUB_ID },
		});
		expect(await res.json()).toMatchObject({ ok: true, sampleReason: "来源交回的不是这一种卡" });
	});

	it("来源没实现 fetchPreview → 示例卡,不算失败(没有 sampleReason)", async () => {
		const app = createCardsRoute({ deps: depsWith(undefined), puppeteer: makeFakePuppeteer() });
		const res = await postPreview(app, {
			kind: "post",
			style: STYLE,
			content: { subscriptionId: SUB_ID },
		});
		expect(await res.json()).toEqual({
			ok: true,
			dataUrl: expect.stringMatching(/^data:image\/png;base64,/),
		});
	});

	it("没挑订阅 → 不问来源,画示例", async () => {
		const fetchPreview = vi.fn<FetchPreview>(async () => postReport());
		const app = createCardsRoute({ deps: depsWith(fetchPreview), puppeteer: makeFakePuppeteer() });
		const res = await postPreview(app, { kind: "post", style: STYLE });
		expect(await res.json()).toEqual({
			ok: true,
			dataUrl: expect.stringMatching(/^data:image\/png;base64,/),
		});
		expect(fetchPreview).not.toHaveBeenCalled();
	});

	it("挑了一条已经没有的订阅 → 404 not_found,不画、不问来源", async () => {
		const fetchPreview = vi.fn<FetchPreview>(async () => postReport());
		const app = createCardsRoute({
			deps: depsWith(fetchPreview, { subscribed: false }),
			puppeteer: makeFakePuppeteer(),
		});
		const res = await postPreview(app, {
			kind: "post",
			style: STYLE,
			content: { subscriptionId: SUB_ID },
		});
		expect(res.status).toBe(404);
		expect(await res.json()).toMatchObject({ code: "not_found" });
		expect(fetchPreview).not.toHaveBeenCalled();
	});

	it("测试推送:来源回了失败 → 推出去的是示例卡,送达了也带 sampleReason", async () => {
		const TARGET_ID = "22222222-2222-4222-8222-222222222222";
		const sendToTarget = vi.fn(async () => ({ ok: true, latencyMs: 3 }));
		const deps = depsWith(async () => fail("unavailable", "接口短暂失败")) as unknown as {
			runtime: { pipeline?: unknown };
			store: { getTargets?: () => unknown };
		};
		deps.runtime.pipeline = { push: { sendToTarget } };
		deps.store.getTargets = () => [{ id: TARGET_ID, name: "群一", enabled: true }];
		const app = createCardsRoute({
			deps: deps as unknown as RouteDeps,
			puppeteer: makeFakePuppeteer(),
		});
		const res = await app.request("/test", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				targetId: TARGET_ID,
				kind: "post",
				style: STYLE,
				content: { subscriptionId: SUB_ID },
			}),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, latencyMs: 3, sampleReason: "接口短暂失败" });
		expect(sendToTarget).toHaveBeenCalledWith(
			TARGET_ID,
			expect.objectContaining({ kind: "image" }),
		);
	});
});

describe("cards route — /preview sc/guard 示例消息", () => {
	const STYLE = {};

	function postPreview(app: ReturnType<typeof createCardsRoute>, body: unknown) {
		return app.request("/preview", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	it("sc:挑了订阅 → 付款人取那个来源登录着的账号名,收的人取订阅资料名", async () => {
		const spy = vi
			.spyOn(ImageRenderer.prototype, "generateSuperchatCard")
			.mockResolvedValue(Buffer.from("x"));
		try {
			const app = createCardsRoute({
				deps: makeDeps(bilibiliLikeSources({ iconRef: GUARD_ICON_REF, accountName: "登录名" }), {
					subscribed: true,
				}),
				puppeteer: makeFakePuppeteer(),
			});
			const res = await postPreview(app, {
				kind: "superchat",
				style: STYLE,
				content: { amount: 30, subscriptionId: "11111111-1111-1111-1111-111111111111" },
			});
			expect(res.status).toBe(200);
			const arg = spy.mock.calls[0]?.[0];
			expect(arg?.viewer.name).toBe("登录名");
			expect(arg?.creator.name).toBe("真实UP");
		} finally {
			spy.mockRestore();
		}
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
		});
		const body = {
			kind: "superchat" as const,
			style: STYLE,
			content: { amount: 30 },
		};
		// 第一趟构造渲染器,第二趟才走 updateConfig —— 两趟都发,拿得到那份 config。
		expect((await postPreview(app, body)).status).toBe(200);
		expect((await postPreview(app, body)).status).toBe(200);
		const cfg = update.mock.calls.at(-1)?.[0] as { cardSkinKnobs?: Record<string, unknown> };
		expect(cfg?.cardSkinKnobs).toEqual({ knobby: { accent: "#00f0ff" } });
		spy.mockRestore();
		update.mockRestore();
	});

	// 4-57：示例的默认档位与时长独立于金额，保留无头像的示例身份。
	it.each([30, 100, 2000])("sc:金额 %s 不决定示例档位与时长", async (amount) => {
		const spy = vi
			.spyOn(ImageRenderer.prototype, "generateSuperchatCard")
			.mockResolvedValue(Buffer.from("x"));
		try {
			const app = createCardsRoute({ deps: makeDeps(), puppeteer: makeFakePuppeteer() });
			const res = await postPreview(app, {
				kind: "superchat",
				style: STYLE,
				content: { amount },
			});
			expect(res.status).toBe(200);
			const arg = spy.mock.calls[0]?.[0];
			expect(arg).toMatchObject({ amount, currency: "CNY", tier: { rank: 1, durationSec: 60 } });
			expect(Object.keys(arg?.viewer ?? {})).toEqual(["name"]);
			expect(Object.keys(arg?.creator ?? {})).toEqual(["name"]);
		} finally {
			spy.mockRestore();
		}
	});

	it.each([
		{ rank: 6, durationSec: 17 },
		{ rank: 2, durationSec: 0 },
	])("sc:按独立输入的档位与时长%j预览，零时长不展示", async (tier) => {
		const spy = vi
			.spyOn(ImageRenderer.prototype, "generateSuperchatCard")
			.mockResolvedValue(Buffer.from("x"));
		try {
			const app = createCardsRoute({ deps: makeDeps(), puppeteer: makeFakePuppeteer() });
			const res = await postPreview(app, {
				kind: "superchat",
				style: STYLE,
				content: { text: "独立示例", amount: 1, ...tier },
			});
			expect(res.status).toBe(200);
			expect(spy.mock.calls[0]?.[0]).toMatchObject({ text: "独立示例", amount: 1, tier });
		} finally {
			spy.mockRestore();
		}
	});

	// ㉓e:上舰预览的请求体带的是档的 key(`tierKey`),服务端按 key 在在册来源声明的会员体系里找那一档;档的各项取自同一份声明。
	// 验红:把 cards.ts 里 `tiers.byKey(...)` 换成固定取最低一档(`tiers.lowest()`),第二行(提督)红。
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
			});
			const res = await postPreview(app, {
				kind: "membership",
				style: STYLE,
				content: { tierKey },
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

	// 验红:把 cards.ts 里描述符缺引用时问来源懒取口的那一段删掉,这条红。
	it("guard:描述符缺引用时经来源懒取口取图标", async () => {
		const fetchTierIcon = vi.fn<LiveInteractionReader["fetchTierIcon"]>(async () =>
			ok({ ref: GUARD_ICON_REF }),
		);
		const spy = vi
			.spyOn(ImageRenderer.prototype, "generateMembershipCard")
			.mockResolvedValue(Buffer.from("x"));
		const app = createCardsRoute({
			deps: makeDeps(bilibiliLikeSources({ fetchTierIcon })),
			puppeteer: makeFakePuppeteer(),
		});
		await postPreview(app, {
			kind: "membership",
			style: STYLE,
			content: { tierKey: "governor" },
		});
		expect(fetchTierIcon).toHaveBeenCalledWith(
			{ sourceKey: BILIBILI_SOURCE_KEY, externalId: "" },
			"guard",
			"governor",
			expect.any(AbortSignal),
		);
		expect(spy.mock.calls[0]?.[0]?.tier.icon).toEqual({ ref: GUARD_ICON_REF });
		spy.mockRestore();
	});

	// 验红:把 cards.ts 里 `icon` 那一格改回 `icon: tier.icon`(档位表的地址),这条红。
	it("guard:没抓到图标 → 出卡输入没有 icon 这一格,预览照出", async () => {
		const spy = vi
			.spyOn(ImageRenderer.prototype, "generateMembershipCard")
			.mockResolvedValue(Buffer.from("x"));
		const app = createCardsRoute({
			deps: makeDeps(bilibiliLikeSources()),
			puppeteer: makeFakePuppeteer(),
		});
		const res = await postPreview(app, {
			kind: "membership",
			style: STYLE,
			content: {},
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
		});
		const res = await postPreview(app, {
			kind: "membership",
			style: STYLE,
			content: {},
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
			});
			const res = await postPreview(app, {
				kind: "membership",
				style: STYLE,
				content: { tierKey },
			});
			expect(res.status).toBe(400);
			expect(await res.json()).toMatchObject({ code: "invalid" });
			expect(spy).not.toHaveBeenCalled();
			spy.mockRestore();
		},
	);

	// 报错体钉死:「认不出的 key」这件事挪了判的地方(请求体 schema → 路由工厂里按读口现判),说法与形状一个字不变。
	it.each([
		[
			"/preview",
			"预览请求体格式不对",
			{ kind: "membership", style: STYLE, content: { tierKey: "nope" } },
		],
		[
			"/test",
			"测试推送请求体格式不对",
			{
				targetId: "22222222-2222-4222-8222-222222222222",
				kind: "membership",
				style: STYLE,
				content: { tierKey: "nope" },
			},
		],
	])("guard:认不出的 tierKey 的 400 报错体(%s)", async (path, message, body) => {
		const app = createCardsRoute({
			deps: makeDeps(),
			puppeteer: makeFakePuppeteer(),
		});
		const res = await app.request(path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			code: "invalid",
			message,
			issues: [{ message: "不是档位表里的档", path: ["content", "tierKey"] }],
		});
	});

	// 防「路由仍偷偷读 B 站档位表」:登记一个只有自造档的来源,按它的 key 能出卡、按 B 站的 key 是 400。
	// 验红:把 cards.ts 里 `tiers.byKey(...)` / `tiers.lowest()` 换回 `guardTierByKey(...)`,这条红。
	it("guard:换一个只有自造档的来源 → 按它的 key 出卡,没带 key 取它最低一档,B 站的 key 是 400", async () => {
		const spy = vi
			.spyOn(ImageRenderer.prototype, "generateMembershipCard")
			.mockResolvedValue(Buffer.from("x"));
		try {
			const sourceRegistry = sourceRegistryOf({
				membershipPrograms: [
					{
						id: "vip",
						name: "自造会员",
						tiers: [
							{ key: "vip-gold", name: "自造金", rank: 2, color: "#aa0000" },
							{ key: "vip-silver", name: "自造银", rank: 1, color: "#00aa00" },
						],
					},
				],
			});
			const app = createCardsRoute({
				deps: makeDeps(sourceRegistry),
				puppeteer: makeFakePuppeteer(),
			});
			const post = (content: Record<string, unknown>) =>
				postPreview(app, { kind: "membership", style: STYLE, content });

			expect((await post({ tierKey: "vip-gold" })).status).toBe(200);
			expect(spy.mock.calls.at(-1)?.[0]?.tier).toMatchObject({ name: "自造金", rank: 2 });
			expect((await post({})).status).toBe(200);
			expect(spy.mock.calls.at(-1)?.[0]?.tier).toMatchObject({ name: "自造银", rank: 1 });
			const callsBefore = spy.mock.calls.length;
			const captain = await post({ tierKey: "captain" });
			expect(captain.status).toBe(400);
			expect(await captain.json()).toMatchObject({ code: "invalid" });
			expect(spy.mock.calls.length).toBe(callsBefore);
		} finally {
			spy.mockRestore();
		}
	});

	it("sc:金额 0、负数或带小数 → 400 invalid(金额要正整数元)", async () => {
		const app = createCardsRoute({
			deps: makeDeps(),
			puppeteer: makeFakePuppeteer(),
		});
		for (const amount of [0, -1, 1.5]) {
			const res = await postPreview(app, {
				kind: "superchat",
				style: STYLE,
				content: { amount },
			});
			expect(res.status, String(amount)).toBe(400);
		}
	});

	it.each(["/preview", "/test"])("sc:%s拒绝越界或非整数的示例档位/时长", async (path) => {
		const app = createCardsRoute({ deps: makeDeps(), puppeteer: makeFakePuppeteer() });
		for (const content of [
			{ rank: 0 },
			{ rank: 7 },
			{ rank: 1.5 },
			{ durationSec: -1 },
			{ durationSec: 1.5 },
		]) {
			const res = await app.request(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					targetId: "22222222-2222-4222-8222-222222222222",
					kind: "superchat",
					style: STYLE,
					content,
				}),
			});
			expect(res.status, JSON.stringify(content)).toBe(400);
			expect(await res.json()).toMatchObject({ code: "invalid" });
		}
	});

	it("guard:挑了订阅 → 新会员取那个来源登录着的账号名,收的人取订阅资料名", async () => {
		const spy = vi
			.spyOn(ImageRenderer.prototype, "generateMembershipCard")
			.mockResolvedValue(Buffer.from("x"));
		try {
			const app = createCardsRoute({
				deps: makeDeps(bilibiliLikeSources({ iconRef: GUARD_ICON_REF, accountName: "登录名" }), {
					subscribed: true,
				}),
				puppeteer: makeFakePuppeteer(),
			});
			const res = await postPreview(app, {
				kind: "membership",
				style: STYLE,
				content: { tierKey: "captain", subscriptionId: "11111111-1111-1111-1111-111111111111" },
			});
			expect(res.status).toBe(200);
			const arg = spy.mock.calls[0]?.[0];
			expect(arg?.viewer.name).toBe("登录名");
			expect(arg?.creator.name).toBe("真实UP");
		} finally {
			spy.mockRestore();
		}
	});

	// 不再借任何平台的登录账号:没挑订阅就不知道问哪个来源,付款人与收的人都是示例名。
	it("sc / guard:没挑订阅 → 付款人、新会员与收的人都是示例名", async () => {
		const sc = vi
			.spyOn(ImageRenderer.prototype, "generateSuperchatCard")
			.mockResolvedValue(Buffer.from("x"));
		const guard = vi
			.spyOn(ImageRenderer.prototype, "generateMembershipCard")
			.mockResolvedValue(Buffer.from("x"));
		try {
			const app = createCardsRoute({
				deps: makeDeps(bilibiliLikeSources({ iconRef: GUARD_ICON_REF, accountName: "登录名" })),
				puppeteer: makeFakePuppeteer(),
			});
			await postPreview(app, { kind: "superchat", style: STYLE, content: { amount: 30 } });
			await postPreview(app, { kind: "membership", style: STYLE, content: {} });
			expect(sc.mock.calls[0]?.[0]).toMatchObject({
				viewer: { name: "示例粉丝" },
				creator: { name: "示例创作者" },
			});
			expect(guard.mock.calls[0]?.[0]).toMatchObject({
				viewer: { name: "示例新会员" },
				creator: { name: "示例创作者" },
			});
		} finally {
			sc.mockRestore();
			guard.mockRestore();
		}
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
			cardSkins: skinStore({ marked: MARKED }),
		});
		expect((await postPreview(app, { kind: "live", style: STYLE })).status).toBe(200);
		// 验红:把 `previewSkinId` 里的 `|| ...defaults.cardSkin` 去掉,这条红。
		expect(captured[0]).toContain("SKIN-MARK-");
	});

	it("SC / 上舰同样带着皮肤 id", async () => {
		const spy = vi
			.spyOn(ImageRenderer.prototype, "generateSuperchatCard")
			.mockResolvedValue(Buffer.from("x"));
		const app = createCardsRoute({
			deps: globalsDeps(DEFAULT_CARD_SKIN_ID),
			puppeteer: makeFakePuppeteer(),
			cardSkins: skinStore({ marked: MARKED }),
		});
		const res = await postPreview(app, {
			kind: "superchat",
			style: STYLE,
			content: { amount: 30 },
			cardSkin: "marked",
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
			cardSkins: skinStore({ marked: MARKED }),
		});
		const res = await postPreview(app, {
			kind: "superchat",
			style: STYLE,
			content: { amount: 30 },
		});
		expect(res.status).toBe(200);
		// 验红:把 renderPreviewCard 开头那句 `cardSkin || …defaults.cardSkin` 改回直接用
		// 入参,这条红 —— 主人装了皮肤,SC 预览却还是出厂那副样子。
		const colorOptions = spy.mock.calls[0]?.[1] as { cardSkin?: string } | undefined;
		expect(colorOptions?.cardSkin).toBe("marked");
		spy.mockRestore();
	});

	it("请求没指皮肤 → 来源交真数据那条也用全局在用的那套", async () => {
		const spy = vi
			.spyOn(ImageRenderer.prototype, "generateLiveCard")
			.mockResolvedValue(Buffer.from("x"));
		try {
			const d = makeDeps(
				bilibiliLikeSources({
					fetchPreview: async () => ok({ kind: "live" as const, details: {} }),
				}),
				{ subscribed: true },
			) as unknown as { store: { getGlobals: () => unknown } };
			d.store.getGlobals = () => ({ defaults: { cardSkin: "marked" } });
			const app = createCardsRoute({
				deps: d as unknown as RouteDeps,
				puppeteer: makeFakePuppeteer(),
				cardSkins: skinStore({ marked: MARKED }),
			});
			const res = await postPreview(app, {
				kind: "live",
				style: STYLE,
				content: { subscriptionId: "11111111-1111-1111-1111-111111111111" },
			});
			expect(res.status).toBe(200);
			// 主人报过的「填了数据又回到原皮」:真数据那条也得吃全局在用的皮肤。
			const colorOptions = spy.mock.calls[0]?.[1] as { cardSkin?: string } | undefined;
			expect(colorOptions?.cardSkin).toBe("marked");
		} finally {
			spy.mockRestore();
		}
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
				runtime: { pipeline?: unknown };
				store: { getTargets?: () => unknown };
			};
			d.runtime.pipeline = { push: { sendToTarget } };
			d.store.getTargets = () => [{ id: TARGET_ID, name: "群一", enabled: true }];
			const app = createCardsRoute({
				deps: d as unknown as RouteDeps,
				puppeteer: makeFakePuppeteer(),
				cardSkins: skinStore({ marked: MARKED }),
			});
			const res = await app.request("/test", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					targetId: TARGET_ID,
					kind: "superchat",
					style: STYLE,
					content: { amount: 30, rank: 5, durationSec: 23 },
					cardSkin: "marked",
					cardSkinKnobs: { marked: { accent: "#00f0ff" } },
				}),
			});
			expect(res.status).toBe(200);
			expect(spy.mock.calls[0]?.[0]).toMatchObject({
				amount: 30,
				tier: { rank: 5, durationSec: 23 },
			});
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

/**
 * 画会员卡而读口给不出档(没有在册来源声明会员档位:B 站来源没登记上、或以后设置坏了只停了它)。
 * 五个入口里这条路由占四个:预览、测试推送、「最终效果」截图、盘上皮肤截图(`onSkinShot`)。
 * 每个都该回「依赖的东西现在不可用」的标准失败、说清原因,**不渲染、不推送、不是 500**;
 * 有档时照常出(正对照)。验红:去掉 `membershipTierUnavailable` 那几道判断,失败那几条红。
 */
describe("cards route — 画会员卡但没有来源声明会员档位", () => {
	const NO_TIER = "没有在跑的来源声明会员档位，画不了会员卡示例";
	const TARGET_ID = "22222222-2222-4222-8222-222222222222";
	const STYLE = {};

	const json = { "content-type": "application/json" };

	function setup(sourceRegistry: SourceRegistry) {
		const sendToTarget = vi.fn(async () => ({ ok: true, latencyMs: 3 }));
		const deps = makeDeps(sourceRegistry) as unknown as {
			runtime: { pipeline?: unknown };
			store: { getTargets?: () => unknown };
		};
		deps.runtime.pipeline = { push: { sendToTarget } };
		deps.store.getTargets = () => [{ id: TARGET_ID, name: "群一", enabled: true }];
		const puppeteer = makeFakePuppeteer();
		let shoot:
			| ((skinId: string, kind: "membership" | "post") => Promise<string | null>)
			| undefined;
		const dir = join(tmpdir(), "bn-test-no-tier-no-such-dir");
		const app = createCardsRoute({
			deps: deps as unknown as RouteDeps,
			puppeteer,
			cardSkins: new CardSkinStore({ dir: join(dir, "card-skins") }),
			onSkinShot: (fn) => {
				shoot = fn;
			},
		});
		const page = puppeteer.page as unknown as ReturnType<typeof vi.fn>;
		return { app, sendToTarget, page, shoot: () => shoot };
	}
	const post = (app: ReturnType<typeof createCardsRoute>, path: string, body: unknown) =>
		app.request(path, { method: "POST", headers: json, body: JSON.stringify(body) });

	const empty = () => sourceRegistryOf();

	it("/preview:没有档 → 200 + unavailable 失败那一支,不渲染;有档照常出", async () => {
		const spy = vi
			.spyOn(ImageRenderer.prototype, "generateMembershipCard")
			.mockResolvedValue(Buffer.from("x"));
		try {
			const body = { kind: "membership", style: STYLE, content: {} };
			const bad = await post(setup(empty()).app, "/preview", body);
			expect(bad.status).toBe(200);
			const badJson = (await bad.json()) as { ok: boolean; code: string; message: string };
			expect(badJson).toMatchObject({ ok: false, code: "unavailable" });
			expect(badJson.message).toContain(NO_TIER);
			expect(spy).not.toHaveBeenCalled();
			const good = await post(setup(bilibiliLikeSources()).app, "/preview", body);
			expect(await good.json()).toMatchObject({ ok: true });
			expect(spy).toHaveBeenCalledTimes(1);
		} finally {
			spy.mockRestore();
		}
	});

	it("/test:没有档 → 200 + unavailable 失败那一支,不渲染也不推;有档照常推", async () => {
		const spy = vi
			.spyOn(ImageRenderer.prototype, "generateMembershipCard")
			.mockResolvedValue(Buffer.from("x"));
		try {
			const body = {
				targetId: TARGET_ID,
				kind: "membership",
				style: STYLE,
				content: {},
			};
			const none = setup(empty());
			const bad = await post(none.app, "/test", body);
			expect(bad.status).toBe(200);
			const badJson = (await bad.json()) as { ok: boolean; code: string; message: string };
			expect(badJson).toMatchObject({ ok: false, code: "unavailable" });
			expect(badJson.message).toContain(NO_TIER);
			expect(spy).not.toHaveBeenCalled();
			expect(none.sendToTarget).not.toHaveBeenCalled();
			const some = setup(bilibiliLikeSources());
			const good = await post(some.app, "/test", body);
			expect(await good.json()).toMatchObject({ ok: true });
			expect(some.sendToTarget).toHaveBeenCalledTimes(1);
		} finally {
			spy.mockRestore();
		}
	});

	it("/skins/:id/screenshot:会员卡没有档 → 503 unavailable、不截图;别的卡种不受影响;有档照常截", async () => {
		const shotBody = (kind: string) => ({ kind, manifest: DEFAULT_CARD_SKIN });
		const none = setup(empty());
		const bad = await post(none.app, "/skins/default/screenshot", shotBody("membership"));
		expect(bad.status).toBe(503);
		const badJson = (await bad.json()) as { code: string; message: string };
		expect(badJson.code).toBe("unavailable");
		expect(badJson.message).toBe(NO_TIER);
		expect(none.page).not.toHaveBeenCalled();
		const other = await post(none.app, "/skins/default/screenshot", shotBody("post"));
		expect(other.status).toBe(200);
		const good = await post(
			setup(bilibiliLikeSources()).app,
			"/skins/default/screenshot",
			shotBody("membership"),
		);
		expect(good.status).toBe(200);
		expect(await good.json()).toMatchObject({ ok: true });
	});

	it("盘上皮肤截图(onSkinShot):会员卡没有档 → 带着原因 reject、不截图;有档照常出 data URL", async () => {
		const none = setup(empty());
		await expect(none.shoot()?.(DEFAULT_CARD_SKIN_ID, "membership")).rejects.toThrow(NO_TIER);
		expect(none.page).not.toHaveBeenCalled();
		const some = setup(bilibiliLikeSources());
		const url = await some.shoot()?.(DEFAULT_CARD_SKIN_ID, "membership");
		expect(url?.startsWith("data:image/jpeg;base64,")).toBe(true);
	});
});
