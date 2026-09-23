/**
 * 拓展那条动态挂载点在 app 上的接线。
 *
 * 两件事各钉一条:`/ext/*` 只在真装了拓展时才通(没装 = 404,而不是「挂着但空转」);
 * 以及它**刻意不在 `/api/*` 底下** —— dashboard 那道鉴权是按 `/api/*` 挂的,而拓展的
 * 对家(桥、回调)手里只有一条 URL、没有会话。
 */

import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionInstallResponse } from "@bilibili-notify/contract";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createApp, createCardSkinStore } from "../app.js";
import { createSessionCodec } from "../auth/session.js";
import type { BootstrapConfig } from "../config/schema.js";
import type { LookupOutcome } from "../extensions/context.js";
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
/**
 * 解析门的接线(ADR-0019 决策 11 / 52):新建订阅的输入框 → `/api/ext/:id/lookup?q=` → 加载器的
 * `lookup()`。路由自己的规矩钉在 `extensions-route.test.ts`;这里钉 `createApp` 真把那一格接上了
 * (漏接的话那一口永远 404,路由的测试照样全绿),以及它**在会话鉴权里面** —— 拓展拿它去问平台用的
 * 是主人的 cookie,鉴权外够得着就是谁都能借主人的号查人。
 */
describe("解析门的接线", () => {
	let dataDir: string;
	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-ext-lookup-"));
	});
	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	const CANDIDATE = { id: "MS4wLjABAAAA-x", name: "抖音作者" };

	function extensionsWith(
		lookup: (id: string, query: string) => Promise<LookupOutcome | undefined>,
	) {
		return {
			mounts: createExtensionMounts(),
			loaded: () => [],
			status: () => undefined,
			pushSource: () => undefined,
			bots: () => undefined,
			lookup,
		};
	}

	it("打到 /api/ext/:id/lookup,落到加载器的 lookup;鉴权外的 /ext 底下没有这一口", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		const lookup = vi.fn(
			async (_id: string, _query: string): Promise<LookupOutcome> => ({
				ok: true,
				candidates: [CANDIDATE],
			}),
		);
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.bootstrap.dataDir) },
			extensions: extensionsWith(lookup),
		});
		const res = await app.request("/api/ext/douyin/lookup?q=%E6%8A%96%E9%9F%B3");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ candidates: [CANDIDATE] });
		expect(lookup).toHaveBeenCalledWith("douyin", "抖音");
		expect((await app.request("/ext/douyin/lookup?q=x")).status).toBe(404);
		await runtime.dispose();
	});

	it("配了面板密码、没带会话 → 401,解析门一次都没被问", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		const creds = { username: "admin", password: "s3cret" };
		const lookup = vi.fn(
			async (_id: string, _query: string): Promise<LookupOutcome> => ({
				ok: true,
				candidates: [CANDIDATE],
			}),
		);
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.bootstrap.dataDir) },
			basicAuthCredentials: creds,
			sessionCodec: createSessionCodec({
				keyMaterial: Buffer.from("test-key-material-32-bytes-long!!", "utf8"),
				creds,
			}),
			extensions: extensionsWith(lookup),
		});
		const res = await app.request("/api/ext/douyin/lookup?q=x");
		expect(res.status).toBe(401);
		expect(lookup).not.toHaveBeenCalled();
		await runtime.dispose();
	});
});

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
