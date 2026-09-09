/**
 * 拓展那条动态挂载点在 app 上的接线。
 *
 * 两件事各钉一条:`/ext/*` 只在真装了拓展时才通(没装 = 404,而不是「挂着但空转」);
 * 以及它**刻意不在 `/api/*` 底下** —— dashboard 那道鉴权是按 `/api/*` 挂的,而拓展的
 * 对家(桥、回调)手里只有一条 URL、没有会话。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createApp } from "../app.js";
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
		const app = createApp(runtime);
		expect((await app.request("/ext/bridge/x")).status).toBe(404);
		await runtime.dispose();
	});

	it("装了就通,而且**不在 /api/* 底下** —— 那道会话鉴权够不着它", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		const mounts = createExtensionMounts();
		mounts.mount("bridge", async () => new Response("桥在这儿"));
		const app = createApp(runtime, { extensions: { mounts, loaded: () => [] } });

		expect(await (await app.request("/ext/bridge/x")).text()).toBe("桥在这儿");
		// 同一条路挂到 /api 底下是不存在的 —— 万一哪天有人挪过去,这条会红。
		expect((await app.request("/api/ext/bridge/x")).status).toBe(404);
		await runtime.dispose();
	});

	it("拓展页列的就是加载器交上来的那份名单", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		const app = createApp(runtime, {
			extensions: {
				mounts: createExtensionMounts(),
				loaded: () => [
					{ id: "junk", origin: "data", state: "unreadable", detail: "不是合法 JSON" },
				],
			},
		});
		const body = (await (await app.request("/api/extensions")).json()) as {
			extensions: Array<{ id: string; state: string }>;
		};
		expect(body.extensions).toEqual([
			expect.objectContaining({ id: "junk", state: "unreadable", enabled: false }),
		]);
		await runtime.dispose();
	});
});
