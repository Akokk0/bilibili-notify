/**
 * `/api/globals` 不再带、也不再收拓展设置(ADR-0019 决策 35)。
 *
 * 拓展设置有了自己的读写口 `/api/ext/:id/settings`:按项写、带版本号、密钥下发时换成头尾。
 * 存储仍在 globals 的 `extensions.<id>.settings`,所以 globals 这条老路得**两头都堵上**:
 * - 读:GET(与 PATCH 的回应)照旧整份下发的话,密钥明文就从这一口出门 —— 新口的遮挡白做。
 * - 写:整份写回会把两发交错的那一发丢掉、把 `id` 与密钥占位一起盖掉。老面板在应用内更新的
 *   那几秒里可能还这么发,拒掉时得说清去哪儿写。
 *
 * 拨开关(`extensions.<id>.enabled`)照旧走 globals —— 它不是设置。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionManifest } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createApp, createCardSkinStore } from "../app.js";
import type { BootstrapConfig } from "../config/schema.js";
import type { ExtensionEntry } from "../extensions/loader.js";
import { createExtensionMounts } from "../extensions/mount.js";
import { createAppRuntime } from "../runtime/bootstrap.js";

const V2: ExtensionManifest = {
	id: "douyin",
	name: "抖音订阅",
	description: "测试用",
	version: "0.1.0",
	apiVersion: 2,
	settings: {
		fields: [
			{ key: "cookie", type: "string", label: "Cookie", required: true, secret: true },
			{ key: "interval", type: "number", label: "间隔", min: 30, max: 600 },
		],
	},
	contributes: {
		subscription: {
			display: { label: "抖音", shortLabel: "抖", color: "#fe2c55" },
			events: ["post"],
		},
	},
};

const COOKIE = "sessionid=0123456789abcdef0123456789abcdef";

function entry(manifest: ExtensionManifest, state: ExtensionEntry["state"]): ExtensionEntry {
	return { id: manifest.id, dir: `/data/extensions/${manifest.id}`, state, manifest };
}

function makeBootstrap(dataDir: string): BootstrapConfig {
	return { server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "silent" };
}

describe("/api/globals —— 拓展设置不走这里了", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-globals-ext-settings-"));
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	/** 起一个真 app;拓展那一格先按 `seed` 摆进 globals(存储仍在那儿)。 */
	async function boot(seed?: Record<string, { enabled: boolean; settings?: unknown }>) {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		if (seed) {
			await runtime.configStore.updateGlobals((globals) => ({ ...globals, extensions: seed }));
		}
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.bootstrap.dataDir) },
			extensions: {
				mounts: createExtensionMounts(),
				loaded: () => [entry(V2, "running")],
				status: () => undefined,
				pushSource: () => undefined,
				bots: () => undefined,
			},
		});
		const get = () => app.request("/api/globals");
		const patch = (body: unknown) =>
			app.request("/api/globals", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
		const stored = (id: string) => runtime.configStore.getGlobals().extensions[id];
		return { runtime, get, patch, stored };
	}

	/** 🔴 密钥明文从这一口出门,新口的遮挡就白做了 —— 整格设置都不下发,开关照旧。 */
	it("GET:每个拓展只剩开关,设置那一格抹掉", async () => {
		const { runtime, get } = await boot({
			douyin: { enabled: true, settings: { cookie: COOKIE, interval: 90 } },
			bridge: { enabled: false, settings: { links: [{ id: "c1", name: "家里那台" }] } },
		});
		const res = await get();
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).not.toContain(COOKIE);
		const body = JSON.parse(text) as { extensions: Record<string, unknown> };
		expect(body.extensions).toEqual({ douyin: { enabled: true }, bridge: { enabled: false } });
		await runtime.dispose();
	});

	it("PATCH 的回应同样不带设置", async () => {
		const { runtime, patch } = await boot({
			douyin: { enabled: false, settings: { cookie: COOKIE } },
		});
		const res = await patch({ extensions: { douyin: { enabled: true } } });
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).not.toContain(COOKIE);
		expect((JSON.parse(text) as { extensions: unknown }).extensions).toEqual({
			douyin: { enabled: true },
		});
		await runtime.dispose();
	});

	/**
	 * 老面板(应用内更新那几秒里还开着的那一页)还会这么发 —— 拒掉,并说清去哪儿写。一个字都不落盘:
	 * 整份写回会把 `id` 与别人刚写的那一条一起盖掉。
	 */
	it("PATCH 带了设置 → 400,点名新口,一个字都不落盘", async () => {
		const { runtime, patch, stored } = await boot({
			douyin: { enabled: false, settings: { cookie: COOKIE, interval: 90 } },
		});
		const res = await patch({ extensions: { douyin: { settings: { interval: 120 } } } });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; message: string };
		expect(body.error).toBe("extension_settings_moved");
		expect(body.message).toContain("/api/ext/douyin/settings");
		expect(stored("douyin")).toEqual({
			enabled: false,
			settings: { cookie: COOKIE, interval: 90 },
		});
		await runtime.dispose();
	});

	/** 顺带拨开关也不行:一发里只要带了设置就整发拒掉,不挑着写一半。 */
	it("开关与设置一起带 → 整发 400,开关也不动", async () => {
		const { runtime, patch, stored } = await boot({
			douyin: { enabled: false, settings: { interval: 90 } },
		});
		const res = await patch({ extensions: { douyin: { enabled: true, settings: {} } } });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toBe("extension_settings_moved");
		expect(stored("douyin")).toEqual({ enabled: false, settings: { interval: 90 } });
		await runtime.dispose();
	});

	/**
	 * 整格清掉(`null`)等于连设置一起抹掉 —— 同样不收。卸载有自己的口(`DELETE /api/ext/:id`),
	 * 面板从来不这么发。
	 */
	it.each([
		["那个拓展整格", { extensions: { douyin: null } }],
		["整张拓展表", { extensions: null }],
	])("PATCH 把%s清掉 → 400,设置还在", async (_what, body) => {
		const { runtime, patch, stored } = await boot({
			douyin: { enabled: true, settings: { interval: 90 } },
		});
		const res = await patch(body);
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toBe("extension_settings_moved");
		expect(stored("douyin")).toEqual({ enabled: true, settings: { interval: 90 } });
		await runtime.dispose();
	});

	it("只拨开关 → 200,存着的设置原样不动", async () => {
		const { runtime, patch, stored } = await boot({
			douyin: { enabled: false, settings: { cookie: COOKIE, interval: 90 } },
		});
		const res = await patch({ extensions: { douyin: { enabled: true } } });
		expect(res.status).toBe(200);
		expect(stored("douyin")).toEqual({
			enabled: true,
			settings: { cookie: COOKIE, interval: 90 },
		});
		await runtime.dispose();
	});
});
