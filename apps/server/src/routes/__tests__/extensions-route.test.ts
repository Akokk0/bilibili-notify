/**
 * 拓展页要的两个只读口:装了什么,以及某个拓展自己交上来的那份面板数据。
 *
 * 🔴 状态那条走 `/api/*` 而不是 `/ext/<id>/*` —— 后者**刻意**在会话鉴权外
 * (ADR-0012 决策 36),把面板数据挂那儿等于公开出去。
 */

import type { ExtensionsResponse } from "@bilibili-notify/contract";
import type { GlobalConfig } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import type { ConfigStore } from "../../config/store.js";
import type { ExtensionEntry } from "../../extensions/loader.js";
import { createExtensionsRoute } from "../extensions.js";

function boot(
	over: { enabled?: boolean; entries?: ExtensionEntry[]; status?: Record<string, unknown> } = {},
) {
	const store = {
		getGlobals: () =>
			({ extensions: { bridge: { enabled: over.enabled ?? false } } }) as unknown as GlobalConfig,
		getConnections: () => [],
	} as unknown as ConfigStore;
	return createExtensionsRoute({
		store,
		extensions: () => over.entries ?? [],
		status: (id) => over.status?.[id],
	});
}

/** 一条「装着、跑着」的拓展。 */
function running(id: string): ExtensionEntry {
	return {
		id,
		origin: "data",
		state: "running",
		manifest: {
			id,
			name: `${id} 拓展`,
			description: "一句话说明",
			version: "1.0.0",
			apiVersion: 1,
			provides: ["push"],
		},
	};
}

describe("GET /api/ext", () => {
	it("列的是**真装着的**那些,带上主人的开关与它现在的状态", async () => {
		const body = (await (
			await boot({ enabled: true, entries: [running("bridge")] }).request("/")
		).json()) as ExtensionsResponse;
		const bridge = body.extensions.find((e) => e.id === "bridge");
		expect(bridge?.enabled).toBe(true);
		expect(bridge?.state).toBe("running");
		expect(bridge?.version).toBe("1.0.0");
		expect(bridge?.provides).toEqual(["push"]);
	});

	it("一个都没装 → 空表。**没有写死的清单了** —— 拓展是装进来的", async () => {
		const body = (await (await boot().request("/")).json()) as ExtensionsResponse;
		expect(body.extensions).toEqual([]);
	});

	it("开关开着、却因为连败被自动停用 —— 两件事都要看得见", async () => {
		const body = (await (
			await boot({
				enabled: true,
				entries: [{ id: "bridge", origin: "data", state: "blocked", detail: "连续加载失败 3 次" }],
			}).request("/")
		).json()) as ExtensionsResponse;
		const bridge = body.extensions[0];
		expect(bridge?.enabled).toBe(true);
		expect(bridge?.state).toBe("blocked");
		expect(bridge?.detail).toContain("连续");
	});

	it("清单读不出来的那条:名字退回目录名,原因带着 —— 消失的东西没法排查", async () => {
		const body = (await (
			await boot({
				entries: [{ id: "junk", origin: "data", state: "unreadable", detail: "不是合法 JSON" }],
			}).request("/")
		).json()) as ExtensionsResponse;
		expect(body.extensions[0]?.name).toBe("junk");
		expect(body.extensions[0]?.detail).toContain("JSON");
	});

	it("每张卡都有名字 —— 卡片上总得印点什么", async () => {
		const body = (await (
			await boot({
				entries: [running("bridge"), { id: "junk", origin: "data", state: "unreadable" }],
			}).request("/")
		).json()) as ExtensionsResponse;
		for (const ext of body.extensions) expect(ext.name.length).toBeGreaterThan(0);
	});
});

describe("GET /api/ext/:id/status", () => {
	it("拓展交上来什么就下发什么 —— 形状第一版不约束(决策 36)", async () => {
		const res = await boot({
			entries: [running("bridge")],
			status: { bridge: { sessions: [{ connectionId: "a", connected: false }] } },
		}).request("/bridge/status");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ sessions: [{ connectionId: "a", connected: false }] });
	});

	/**
	 * 「没这个拓展」与「它没交过数据」都是 404 而不是空对象 —— 面板要能把这两件事
	 * 与「交上来的就是一张空表」分开说。
	 */
	it("没跑 / 没交过 → 404,不是空对象", async () => {
		expect((await boot({ entries: [running("bridge")] }).request("/bridge/status")).status).toBe(
			404,
		);
		expect((await boot().request("/nobody/status")).status).toBe(404);
	});

	it("**现取** —— 拓展给的是个函数,两次问拿到的是两次的真相", async () => {
		let n = 0;
		const app = createExtensionsRoute({
			store: {
				getGlobals: () => ({ extensions: {} }) as unknown as GlobalConfig,
				getConnections: () => [],
			} as unknown as ConfigStore,
			extensions: () => [],
			status: () => ({ n: ++n }),
		});
		expect(await (await app.request("/x/status")).json()).toEqual({ n: 1 });
		expect(await (await app.request("/x/status")).json()).toEqual({ n: 2 });
	});
});
