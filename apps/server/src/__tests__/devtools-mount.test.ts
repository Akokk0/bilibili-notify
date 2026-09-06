import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createApp } from "../app.js";
import type { BootstrapConfig } from "../config/schema.js";
import { createDevRegistry } from "../devtools/registry.js";
import { createDevRoute } from "../devtools/route.js";
import { createAppRuntime } from "../runtime/bootstrap.js";

/**
 * `/api/dev` 只在给了 devtools 时挂载。发出去的构建里 `createDevtools` 回 null、什么都不挂 ——
 * 这条钉的是「不挂 = 404」,而不是「挂着但拒绝」:后者等于向外承认有这么个口。
 */

function makeBootstrap(dataDir: string): BootstrapConfig {
	return { server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "silent" };
}

describe("devtools 挂载", () => {
	let dataDir: string;
	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-devtools-"));
	});
	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	it("没给 devtools → /api/dev 404", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		const app = createApp(runtime);
		expect((await app.request("/api/dev")).status).toBe(404);
		await runtime.dispose();
	});

	it("给了 → /api/dev 列得出场景", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		const registry = createDevRegistry([
			{ id: "a", group: "event", title: "A", params: [], run: () => ({}) },
		]);
		const app = createApp(runtime, { devtools: createDevRoute({ registry }) });
		const res = await app.request("/api/dev");
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ scenarios: [{ id: "a" }], active: [] });
		await runtime.dispose();
	});
});
