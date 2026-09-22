/**
 * PATCH /api/globals —— 拓展设置照清单声明校验(ADR-0019 决策 17)。
 *
 * 拓展那一格在 globals 里是 `z.unknown()`:核心不认识拓展设置的形状。v2 拓展把设置项写进了
 * 清单,BN 就能在**落盘之前**照声明拦一道 —— 写坏了的话,拓展读到的是一份它自己的 zod 解不出
 * 的设置,按「没设过」算(桥:接入名单变空,所有 token 当场失效),而面板上一切正常。
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

const V1: ExtensionManifest = {
	id: "bridge",
	name: "桥",
	description: "测试用",
	version: "0.0.1",
	apiVersion: 1,
	provides: ["push"],
};

function entry(manifest: ExtensionManifest, state: ExtensionEntry["state"]): ExtensionEntry {
	return { id: manifest.id, dir: `/data/extensions/${manifest.id}`, state, manifest };
}

function makeBootstrap(dataDir: string): BootstrapConfig {
	return { server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "silent" };
}

describe("PATCH /api/globals —— 拓展设置照清单校验", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-globals-ext-settings-"));
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	async function boot(entries: ExtensionEntry[]) {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.bootstrap.dataDir) },
			extensions: {
				mounts: createExtensionMounts(),
				loaded: () => entries,
				status: () => undefined,
				pushSource: () => undefined,
				bots: () => undefined,
			},
		});
		const patch = (body: unknown) =>
			app.request("/api/globals", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
		const settingsOf = (id: string) => runtime.configStore.getGlobals().extensions[id]?.settings;
		return { runtime, patch, settingsOf };
	}

	it("照声明写坏了 —— 400,点名那一格,一个字都不落盘", async () => {
		const { runtime, patch, settingsOf } = await boot([entry(V2, "running")]);
		const res = await patch({ extensions: { douyin: { settings: { cookie: "", interval: 10 } } } });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; issues: Array<{ path: unknown[] }> };
		expect(body.error).toBe("validation_failed");
		const paths = body.issues.map((issue) => issue.path.join("."));
		expect(paths).toContain("extensions.douyin.settings.cookie");
		expect(paths).toContain("extensions.douyin.settings.interval");
		expect(settingsOf("douyin")).toBeUndefined();
		await runtime.dispose();
	});

	it("写对了 —— 200,落盘", async () => {
		const { runtime, patch, settingsOf } = await boot([entry(V2, "running")]);
		const res = await patch({
			extensions: { douyin: { settings: { cookie: "c", interval: 90 } } },
		});
		expect(res.status).toBe(200);
		expect(settingsOf("douyin")).toEqual({ cookie: "c", interval: 90 });
		await runtime.dispose();
	});

	/** 「装好 → 填 cookie → 启用」:没启用的拓展也要能先把设置填好,也照样要拦写坏的。 */
	it("拓展关着也照样校验 —— 声明在清单里,不等代码跑起来", async () => {
		const { runtime, patch } = await boot([entry(V2, "disabled")]);
		const bad = await patch({ extensions: { douyin: { settings: { cookie: "" } } } });
		expect(bad.status).toBe(400);
		const good = await patch({ extensions: { douyin: { settings: { cookie: "c" } } } });
		expect(good.status).toBe(200);
		await runtime.dispose();
	});

	it("只拨开关、没碰设置 —— 不校验(存量的设置是坏的也不该挡住开关)", async () => {
		const { runtime, patch } = await boot([entry(V2, "running")]);
		const res = await patch({ extensions: { douyin: { enabled: true } } });
		expect(res.status).toBe(200);
		await runtime.dispose();
	});

	it("v1 拓展的设置清单里没声明 —— 不校验(桥的名单还是手写页在写)", async () => {
		const { runtime, patch, settingsOf } = await boot([entry(V1, "running")]);
		const res = await patch({ extensions: { bridge: { settings: { links: "随便什么" } } } });
		expect(res.status).toBe(200);
		expect(settingsOf("bridge")).toEqual({ links: "随便什么" });
		await runtime.dispose();
	});
});
