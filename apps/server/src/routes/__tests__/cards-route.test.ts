import { describe, expect, it, vi } from "vitest";
import type { StandalonePuppeteer } from "../../runtime/puppeteer.js";
import { createCardsRoute } from "../cards.js";
import type { RouteDeps } from "../types.js";

function makeDeps(): RouteDeps {
	return {
		runtime: {
			serviceCtx: {
				logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
			},
		},
	} as unknown as RouteDeps;
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
