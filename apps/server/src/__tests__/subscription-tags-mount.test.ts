/**
 * 接线守卫:`/api/subscriptions/tags` 真的挂在 app 上了吗(ADR-0034)。
 *
 * 路由自己那几条测试全绿,证明不了它被挂进来。少这一行的症状是面板上标签永远读不出来、新建不了(404),
 * 而订阅照常能存 —— 不报错。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createApp, createCardSkinStore } from "../app.js";
import { settingsSegment } from "../bilibili/settings.js";
import { createAppRuntime } from "../runtime/bootstrap.js";

let dataDir: string;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-subscription-tags-mount-"));
});

afterEach(async () => {
	await rm(dataDir, { recursive: true, force: true });
});

describe("/api/subscriptions/tags 挂载", () => {
	it("PUT 存下、GET 读回,走的是配置仓里那张表", async () => {
		const runtime = createAppRuntime(
			{ server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "silent" },
			{ dataRoot: dataDir },
			{ integrationSettings: [settingsSegment] },
		);
		await runtime.configStore.load();
		const app = createApp(runtime, { cardSkins: { store: createCardSkinStore(runtime.dataRoot) } });
		const tag = { id: "11111111-1111-4111-8111-111111111111", name: "游戏" };

		const put = await app.request("/api/subscriptions/tags", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify([tag]),
		});
		expect(put.status).toBe(200);
		const get = await app.request("/api/subscriptions/tags");
		expect(get.status).toBe(200);
		expect(await get.json()).toEqual([tag]);
		expect(runtime.configStore.getSubscriptionTags()).toEqual([tag]);
		await runtime.dispose();
	});
});
