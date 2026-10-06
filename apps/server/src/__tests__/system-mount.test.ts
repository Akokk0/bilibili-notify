/**
 * 接线守卫:`/api/system` 真的挂在 app 上了吗。
 *
 * 🔴 路由自己那几条测试全绿,证明不了它被挂进来。少这一行的症状是**面板上永远没有
 * 那个按钮**(GET 404 → 前端当这台机器不支持重启),而两边都不报错。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createApp, createCardSkinStore } from "../app.js";
import type { BootstrapConfig } from "../config/schema.js";
import { createAppRuntime } from "../runtime/bootstrap.js";

function makeBootstrap(dataDir: string): BootstrapConfig {
	return { server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "silent" };
}

describe("/api/system 挂载", () => {
	let dataDir: string;
	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-system-mount-"));
	});
	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	it("没给 → 404,那台机器上就当没有重启这回事", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir), { dataRoot: dataDir });
		await runtime.configStore.load();
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.dataRoot) },
		});
		expect((await app.request("/api/system/restart", { method: "POST" })).status).toBe(404);
		await runtime.dispose();
	});

	it("给了 → 重启这条按得动", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir), { dataRoot: dataDir });
		await runtime.configStore.load();
		const restart = vi.fn(async () => {});
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.dataRoot) },
			system: {
				ability: { can: true, how: "container" },
				startedAt: "2026-09-10T00:00:00.000Z",
				version: "0.10.1",
				restart,
				notices: { list: async () => [], acknowledge: async () => false },
				requestGeneration: async () => {},
				zeroGenerationExists: async () => false,
				generations: { list: async () => [], remove: async () => ({ kind: "not_found" }) },
			},
		});
		expect((await app.request("/api/system/restart", { method: "POST" })).status).toBe(200);
		await new Promise((r) => setTimeout(r, 5));
		expect(restart).toHaveBeenCalledOnce();
		await runtime.dispose();
	});

	it("旧版本数据的两个口跟着 system 一起挂:没给 404,给了列表与删除都答(㉙c)", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir), { dataRoot: dataDir });
		await runtime.configStore.load();
		const bare = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.dataRoot) },
		});
		expect((await bare.request("/api/system/generations")).status).toBe(404);
		expect((await bare.request("/api/system/generations/1", { method: "DELETE" })).status).toBe(
			404,
		);
		const remove = vi.fn(async () => ({ kind: "removed", freedBytes: 5 }) as const);
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.dataRoot) },
			system: {
				ability: { can: true, how: "container" },
				startedAt: "2026-09-10T00:00:00.000Z",
				version: "0.10.1",
				restart: async () => {},
				notices: { list: async () => [], acknowledge: async () => false },
				requestGeneration: async () => {},
				zeroGenerationExists: async () => false,
				generations: { list: async () => [], remove },
			},
		});
		const list = await app.request("/api/system/generations");
		expect(list.status).toBe(200);
		expect(await list.json()).toEqual({ generations: [] });
		const del = await app.request("/api/system/generations/3", { method: "DELETE" });
		expect(await del.json()).toEqual({ freedBytes: 5 });
		expect(remove).toHaveBeenCalledWith(3);
		await runtime.dispose();
	});
});
