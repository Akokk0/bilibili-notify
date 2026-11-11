import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createApp, createCardSkinStore } from "../app.js";
import { createSessionCodec } from "../auth/session.js";
import { settingsSegment } from "../bilibili/settings.js";
import { BUILTIN_INTEGRATION_KEYS } from "../compose.js";
import type { BootstrapConfig } from "../config/schema.js";
import { createDevelopmentExtensions } from "../devtools/development-extensions.js";
import { createDevtoolsProviderRegistry } from "../devtools/providers.js";
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
		const runtime = createAppRuntime(
			makeBootstrap(dataDir),
			{ dataRoot: dataDir },
			{ integrationSettings: [settingsSegment] },
		);
		await runtime.configStore.load();
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.dataRoot) },
		});
		expect((await app.request("/api/dev")).status).toBe(404);
		expect((await app.request("/api/dev/extensions")).status).toBe(404);
		expect((await app.request("/api/dev/directories")).status).toBe(404);
		expect((await app.request("/api/dev/extensions", { method: "POST" })).status).toBe(404);
		await runtime.dispose();
	});

	it("开发挂载也受面板会话鉴权保护", async () => {
		const runtime = createAppRuntime(
			makeBootstrap(dataDir),
			{ dataRoot: dataDir },
			{ integrationSettings: [settingsSegment] },
		);
		await runtime.configStore.load();
		const credentials = { username: "fixture", password: "fixture-password" };
		const codec = createSessionCodec({ keyMaterial: Buffer.alloc(32, 1), creds: credentials });
		const development = createDevelopmentExtensions({
			root: join(dataDir, "extensions"),
			reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS,
			extensions: () => undefined,
		});
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.dataRoot) },
			basicAuthCredentials: credentials,
			sessionCodec: codec,
			devtools: createDevRoute({
				registry: createDevRegistry(createDevtoolsProviderRegistry([])),
				developmentExtensions: development,
			}),
		});
		try {
			expect((await app.request("/api/dev/extensions")).status).toBe(401);
			expect((await app.request("/api/dev/directories")).status).toBe(401);
			expect(
				(
					await app.request("/api/dev/directories", {
						headers: { cookie: `bn_session=${codec.sign()}` },
					})
				).status,
			).toBe(200);
			expect(
				(
					await app.request("/api/dev/extensions", {
						headers: { cookie: `bn_session=${codec.sign()}` },
					})
				).status,
			).toBe(200);
		} finally {
			await development.dispose();
			await runtime.dispose();
		}
	});

	it("给了 → /api/dev 列得出场景", async () => {
		const runtime = createAppRuntime(
			makeBootstrap(dataDir),
			{ dataRoot: dataDir },
			{ integrationSettings: [settingsSegment] },
		);
		await runtime.configStore.load();
		const registry = createDevRegistry(
			createDevtoolsProviderRegistry([
				{ id: "a", group: "event", title: "A", params: [], run: () => ok() },
			]),
		);
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.dataRoot) },
			devtools: createDevRoute({ registry }),
		});
		const res = await app.request("/api/dev");
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ scenarios: [{ id: "core.a" }], active: [] });
		await runtime.dispose();
	});
});
