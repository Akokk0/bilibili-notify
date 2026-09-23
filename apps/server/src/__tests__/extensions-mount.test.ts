/**
 * 拓展那条动态挂载点在 app 上的接线。
 *
 * 两件事各钉一条:`/ext/*` 只在真装了拓展时才通(没装 = 404,而不是「挂着但空转」);
 * 以及它**刻意不在 `/api/*` 底下** —— dashboard 那道鉴权是按 `/api/*` 挂的,而拓展的
 * 对家(桥、回调)手里只有一条 URL、没有会话。
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionInstallResponse } from "@bilibili-notify/contract";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createApp, createCardSkinStore } from "../app.js";
import type { BootstrapConfig } from "../config/schema.js";
import { createExtensionMounts } from "../extensions/mount.js";
import { createAppRuntime } from "../runtime/bootstrap.js";

function makeBootstrap(dataDir: string): BootstrapConfig {
	return { server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "silent" };
}

describe("拓展挂载点接线", () => {
	let dataDir: string;
	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-ext-mount-"));
	});
	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	it("没装拓展 → /ext/* 404", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.bootstrap.dataDir) },
		});
		expect((await app.request("/ext/bridge/x")).status).toBe(404);
		await runtime.dispose();
	});

	it("装了就通,而且**不在 /api/* 底下** —— 那道会话鉴权够不着它", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		const mounts = createExtensionMounts();
		mounts.mount("bridge", async () => new Response("桥在这儿"));
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.bootstrap.dataDir) },
			extensions: {
				mounts,
				loaded: () => [],
				status: () => undefined,
				pushSource: () => undefined,
				bots: () => undefined,
			},
		});

		expect(await (await app.request("/ext/bridge/x")).text()).toBe("桥在这儿");
		// 同一条路挂到 /api 底下是不存在的 —— 万一哪天有人挪过去,这条会红。
		expect((await app.request("/api/ext/bridge/x")).status).toBe(404);
		await runtime.dispose();
	});

	it("拓展页列的就是加载器交上来的那份名单", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.bootstrap.dataDir) },
			extensions: {
				status: () => undefined,
				pushSource: () => undefined,
				bots: () => undefined,
				mounts: createExtensionMounts(),
				loaded: () => [
					{
						id: "junk",
						dir: "/data/extensions/junk",
						state: "unreadable",
						detail: "不是合法 JSON",
					},
				],
			},
		});
		const body = (await (await app.request("/api/ext")).json()) as {
			extensions: Array<{ id: string; state: string }>;
		};
		expect(body.extensions).toEqual([
			expect.objectContaining({ id: "junk", state: "unreadable", enabled: false }),
		]);
		await runtime.dispose();
	});
});

/**
 * 🔴 **接线守卫。** 拆包、落盘、`rescan()` 各自的测试全绿,证明不了「从面板传一个包上来
 * 真的装得进去」—— 少接一根线的症状就是主人报的那句「装了拓展要我重启,可我没处按」,
 * 而门禁一片绿。这条从 app 那一头真发一次 multipart。
 */
/**
 * 动作那一口的接线(ADR-0019 决策 22):面板按钮 → `/api/ext/:id/actions/:name` → 加载器。
 * 路由自己的规矩钉在 `extensions-route.test.ts`,这里只钉 `createApp` 真把那一格接上了 ——
 * 漏接的话那一口永远 404,而路由的测试照样全绿。
 */
describe("拓展动作的接线", () => {
	let dataDir: string;
	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-ext-action-"));
	});
	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	it("按钮打到 /api/ext/:id/actions/:name,落到加载器的 runAction", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		const runAction = vi.fn(async () => ({ ok: true as const }));
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.bootstrap.dataDir) },
			extensions: {
				mounts: createExtensionMounts(),
				loaded: () => [],
				status: () => undefined,
				pushSource: () => undefined,
				bots: () => undefined,
				runAction,
			},
		});
		const res = await app.request("/api/ext/douyin/actions/poll.now", { method: "POST" });
		expect(res.status).toBe(200);
		expect(runAction).toHaveBeenCalledWith("douyin", "poll.now");
		// 同一个动作挂到鉴权外的 /ext 底下是不存在的。
		expect((await app.request("/ext/douyin/actions/poll.now", { method: "POST" })).status).toBe(
			404,
		);
		await runtime.dispose();
	});
});

/**
 * 「只重载这个拓展」那一口的接线(ADR-0012 决策 47):面板按钮 → `/api/ext/:id/swap` → 加载器的
 * `swap()`。路由的规矩钉在 `extensions-route.test.ts`;漏接的话那一口永远 404,而路由的测试
 * 照样全绿。
 */
describe("只重载的接线", () => {
	let dataDir: string;
	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-ext-swap-"));
	});
	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	it("按钮打到 /api/ext/:id/swap,落到加载器的 swap", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		const swap = vi.fn(async () => {});
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.bootstrap.dataDir) },
			extensions: {
				mounts: createExtensionMounts(),
				loaded: () => [
					{
						id: "bridge",
						dir: "/data/extensions/bridge",
						state: "running",
						staged: { version: "2.0.0" },
					},
				],
				status: () => undefined,
				pushSource: () => undefined,
				bots: () => undefined,
				swap,
			},
		});
		const res = await app.request("/api/ext/bridge/swap", { method: "POST" });
		expect(res.status).toBe(200);
		expect(swap).toHaveBeenCalledWith("bridge");
		await runtime.dispose();
	});
});

describe("面板上传装拓展的接线", () => {
	let dataDir: string;
	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-ext-install-mount-"));
	});
	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	it("传上去 → 落进装载根,并且当场重扫", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		const rescan = vi.fn(async () => {});
		const root = join(dataDir, "extensions");
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.bootstrap.dataDir) },
			extensions: {
				mounts: createExtensionMounts(),
				loaded: () => [],
				status: () => undefined,
				pushSource: () => undefined,
				bots: () => undefined,
				install: {
					root,
					// 装载器那条队的替身:写完紧跟着重扫(`loader.changeDisk` 的形状)。
					changeDisk: async (write) => {
						try {
							return await write();
						} finally {
							await rescan();
						}
					},
					restartAbility: { can: true, how: "container" },
				},
			},
		});

		const zip = zipSync({
			"extension.json": strToU8(
				JSON.stringify({
					id: "douyin",
					name: "抖音订阅源",
					description: "测试用",
					version: "0.2.0",
					apiVersion: 1,
					provides: ["subscription"],
				}),
			),
			"index.mjs": strToU8("export function activate() {}"),
		});
		const body = new FormData();
		body.append("file", new File([zip], "douyin.zip"));

		const res = await app.request("/api/ext/install", { method: "POST", body });

		expect(res.status).toBe(200);
		expect((await res.json()) as ExtensionInstallResponse).toMatchObject({
			id: "douyin",
			staged: false,
		});
		expect(await readFile(join(root, "douyin", "index.mjs"), "utf8")).toContain("activate");
		expect(rescan).toHaveBeenCalledOnce();
		await runtime.dispose();
	});

	it("没接装载器的构建 → 404,而不是装进一个没人加载的目录", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.bootstrap.dataDir) },
		});
		const body = new FormData();
		body.append("file", new File([new Uint8Array()], "x.zip"));
		expect((await app.request("/api/ext/install", { method: "POST", body })).status).toBe(404);
		await runtime.dispose();
	});
});
