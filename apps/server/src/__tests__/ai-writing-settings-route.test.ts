/**
 * `ai.writing`(ADR-0032)经现有的 `GET` / `PATCH /api/settings` 读写:写一条例外读得回,
 * 发 `null` 删掉那一条,`ai` 别的子格不动。跑真 app + 真 store。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createApp, createCardSkinStore } from "../app.js";
import { settingsSegment } from "../bilibili/settings.js";
import type { BootstrapConfig } from "../config/schema.js";
import { createAppRuntime } from "../runtime/bootstrap.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

function makeBootstrap(dataDir: string): BootstrapConfig {
	return { server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "silent" };
}

describe("ai.writing 经设置路由读写", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-ai-writing-route-"));
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	async function boot() {
		const runtime = createAppRuntime(
			makeBootstrap(dataDir),
			{ dataRoot: dataDir },
			{ integrationSettings: [settingsSegment] },
		);
		await runtime.configStore.load();
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.dataRoot) },
		});
		// 读写的都是核心那份(`/api/settings` 上挂在 `core` 下)。
		const patch = (core: unknown) =>
			app.request("/api/settings", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ core }),
			});
		const get = async () => {
			const res = await app.request("/api/settings");
			return (
				(await res.json()) as { core: { ai: Record<string, unknown> & { writing: unknown } } }
			).core;
		};
		return { runtime, patch, get };
	}

	it("出厂就是两份默认开、没有例外", async () => {
		const { runtime, get } = await boot();
		expect((await get()).ai.writing).toEqual({
			post: { isOnByDefault: true, byTarget: {} },
			liveSummary: { isOnByDefault: true, byTarget: {} },
		});
		await runtime.dispose();
	});

	it("PATCH 写一条例外后 GET 读得回,另一份与 ai 别的子格不变", async () => {
		const { runtime, patch, get } = await boot();
		const before = await get();
		const res = await patch({
			ai: { writing: { post: { isOnByDefault: false, byTarget: { [A]: true } } } },
		});
		expect(res.status).toBe(200);
		const after = await get();
		expect(after.ai.writing).toEqual({
			post: { isOnByDefault: false, byTarget: { [A]: true } },
			liveSummary: { isOnByDefault: true, byTarget: {} },
		});
		const { writing: _b, ...beforeRest } = before.ai;
		const { writing: _a, ...afterRest } = after.ai;
		expect(afterRest).toEqual(beforeRest);
		await runtime.dispose();
	});

	it("发 null 只删掉那一条例外,别的例外还在", async () => {
		const { runtime, patch, get } = await boot();
		await patch({ ai: { writing: { post: { byTarget: { [A]: true, [B]: false } } } } });
		const res = await patch({ ai: { writing: { post: { byTarget: { [A]: null } } } } });
		expect(res.status).toBe(200);
		expect((await get()).ai.writing).toEqual({
			post: { isOnByDefault: true, byTarget: { [B]: false } },
			liveSummary: { isOnByDefault: true, byTarget: {} },
		});
		await runtime.dispose();
	});
});
