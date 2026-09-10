/**
 * 接线守卫:`/api/system` 真的挂在 app 上了吗。
 *
 * 🔴 路由自己那几条测试全绿,证明不了它被挂进来。少这一行的症状是**面板上永远没有
 * 那个按钮**(GET 404 → 前端当这台机器不支持重启),而两边都不报错。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SystemInfoResponse } from "@bilibili-notify/contract";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createApp } from "../app.js";
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

	it("没给 → 404,面板当这台机器没有重启这回事", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		const app = createApp(runtime);
		expect((await app.request("/api/system")).status).toBe(404);
		await runtime.dispose();
	});

	it("给了 → 判据交得出来", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		const app = createApp(runtime, {
			system: {
				ability: { can: true, how: "container" },
				startedAt: "2026-09-10T00:00:00.000Z",
				version: "0.10.1",
				restart: async () => {},
			},
		});
		const res = await app.request("/api/system");
		expect(res.status).toBe(200);
		expect((await res.json()) as SystemInfoResponse).toEqual({
			restart: { can: true, how: "container" },
		});
		await runtime.dispose();
	});
});
