import { describe, expect, it, vi } from "vite-plus/test";
import { DevParamError, type DevRegistry, DevScenarioNotFound } from "../registry.js";
import { createDevRoute } from "../route.js";

/**
 * `/api/dev` 的 wire 层:列、跑、收摊。判断全在注册表,这里只把三种失败翻成状态码 ——
 * 没这个场景 404、参数不合法 400、场景自己抛了 500(交给 app 级 onError)。
 */

function fakeRegistry(overrides: Partial<DevRegistry> = {}): DevRegistry {
	return {
		list: () => [{ id: "a", group: "state", title: "A", params: [] }],
		run: vi.fn(async () => ({ active: [] })),
		active: () => [{ scenarioId: "a", label: "假的 A" }],
		reset: vi.fn(async () => []),
		...overrides,
	};
}

describe("dev 路由", () => {
	it("GET / 交出场景表与生效表", async () => {
		const app = createDevRoute({ registry: fakeRegistry() });
		const res = await app.request("/");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			scenarios: [{ id: "a", group: "state", title: "A", params: [] }],
			active: [{ scenarioId: "a", label: "假的 A" }],
		});
	});

	it("POST /run/:id 把 params 交给注册表,回执原样交出", async () => {
		const run = vi.fn(async () => ({ summary: "跑了", active: [] }));
		const app = createDevRoute({ registry: fakeRegistry({ run }) });
		const res = await app.request("/run/a", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ params: { phase: "ready" } }),
		});
		expect(res.status).toBe(200);
		expect(run).toHaveBeenCalledWith("a", { phase: "ready" });
		expect(await res.json()).toEqual({ summary: "跑了", active: [] });
	});

	it("POST /run/:id 没有 body 也行 —— 全按默认值", async () => {
		const run = vi.fn(async () => ({ active: [] }));
		const app = createDevRoute({ registry: fakeRegistry({ run }) });
		const res = await app.request("/run/a", { method: "POST" });
		expect(res.status).toBe(200);
		expect(run).toHaveBeenCalledWith("a", {});
	});

	it("没这个场景 404、参数不合法 400,都带一句 err", async () => {
		const app = createDevRoute({
			registry: fakeRegistry({
				run: async (id) => {
					if (id === "zzz") throw new DevScenarioNotFound(id);
					throw new DevParamError("相位没有「nope」这一档");
				},
			}),
		});
		const missing = await app.request("/run/zzz", { method: "POST" });
		expect(missing.status).toBe(404);
		expect(await missing.json()).toMatchObject({ err: expect.stringContaining("zzz") });

		const bad = await app.request("/run/a", { method: "POST" });
		expect(bad.status).toBe(400);
		expect(await bad.json()).toMatchObject({ err: expect.stringContaining("nope") });
	});

	it("params 不是对象 → 400,不交给注册表", async () => {
		const run = vi.fn(async () => ({ active: [] }));
		const app = createDevRoute({ registry: fakeRegistry({ run }) });
		const res = await app.request("/run/a", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ params: [1, 2] }),
		});
		expect(res.status).toBe(400);
		expect(run).not.toHaveBeenCalled();
	});

	it("POST /reset 全收、POST /reset/:id 只收那一个;回收完的生效表交出", async () => {
		const reset = vi.fn(async (id?: string) =>
			id === undefined ? [] : [{ scenarioId: "b", label: "B" }],
		);
		const app = createDevRoute({ registry: fakeRegistry({ reset }) });

		const all = await app.request("/reset", { method: "POST" });
		expect(await all.json()).toEqual({ active: [] });
		expect(reset).toHaveBeenLastCalledWith();

		const one = await app.request("/reset/a", { method: "POST" });
		expect(await one.json()).toEqual({ active: [{ scenarioId: "b", label: "B" }] });
		expect(reset).toHaveBeenLastCalledWith("a");
	});

	it("POST /reset/:id 没这个场景 → 404", async () => {
		const app = createDevRoute({
			registry: fakeRegistry({
				reset: (id) => {
					throw new DevScenarioNotFound(id ?? "?");
				},
			}),
		});
		expect((await app.request("/reset/zzz", { method: "POST" })).status).toBe(404);
	});
});

describe("dev 路由 · 截流", () => {
	const captures = () => ({
		status: vi.fn(() => ({
			enabled: true,
			entries: [
				{
					id: "1",
					at: 1,
					adapterId: "ad",
					adapterName: "A",
					platform: "onebot",
					targetId: "t",
					targetName: "群",
					private: false,
					kind: "text",
					text: "hi",
					images: 0,
				},
			],
		})),
		clear: vi.fn(),
		purgeHistory: vi.fn(async () => 3),
	});

	it("没接截流 → /captures 404(和整个 /api/dev 没挂一样,不向外承认)", async () => {
		const app = createDevRoute({ registry: fakeRegistry() });
		expect((await app.request("/captures")).status).toBe(404);
	});

	it("GET /active 只交生效表 —— 轮询打的是它,别把整张场景表按秒重发", async () => {
		const app = createDevRoute({ registry: fakeRegistry() });
		const res = await app.request("/active");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ active: [{ scenarioId: "a", label: "假的 A" }] });
	});

	it("GET /captures 交出开关与列表", async () => {
		const c = captures();
		const app = createDevRoute({ registry: fakeRegistry(), captures: c });
		const res = await app.request("/captures");
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ enabled: true, entries: [{ id: "1", text: "hi" }] });
	});

	it("POST /captures/clear 清空后交出新状态", async () => {
		const c = captures();
		const app = createDevRoute({ registry: fakeRegistry(), captures: c });
		const res = await app.request("/captures/clear", { method: "POST" });
		expect(res.status).toBe(200);
		expect(c.clear).toHaveBeenCalledOnce();
		expect(c.status).toHaveBeenCalled();
	});

	it("POST /captures/purge-history 回删了几行", async () => {
		const c = captures();
		const app = createDevRoute({ registry: fakeRegistry(), captures: c });
		const res = await app.request("/captures/purge-history", { method: "POST" });
		expect(await res.json()).toEqual({ deleted: 3 });
	});
});
