/**
 * `createApp` 把 `statsOverview` 接到统计路由上 —— 面板的 `/api/stats/overview` 与手动锐评走的是
 * `index.ts` 建好、同时交给定时锐评的那一个取数函数,三处才吃同一份 30 秒缓存。
 *
 * 路由自己的接线(注入的函数被 `/overview` 与两处锐评直接调)在 `routes/__tests__/stats-route.test.ts`;
 * 这里钉的是**再往上一跳**:`createApp` 收到的 `statsOverview` 真的进了路由。把 `app.ts` 里那根线剪断
 * (不再把它交给 `createStatsRoute`),路由就自建一个、缓存不再共用,类型与构建都全绿 —— 只有这条会红。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createApp, createCardSkinStore } from "../app.js";
import { settingsSegment } from "../bilibili/settings.js";
import type { BootstrapConfig } from "../config/schema.js";
import { createAppRuntime } from "../runtime/bootstrap.js";

function makeBootstrap(dataDir: string): BootstrapConfig {
	return { server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "silent" };
}

describe("createApp → 统计路由的取数函数", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-stats-overview-wiring-"));
		const staticDir = join(dataDir, "web-dist");
		await mkdir(staticDir, { recursive: true });
		await writeFile(join(staticDir, "index.html"), "<!doctype html><title>bn</title>");
	});
	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	async function makeApp(statsOverview: Parameters<typeof createApp>[1]["statsOverview"]) {
		const runtime = createAppRuntime(
			makeBootstrap(dataDir),
			{ dataRoot: dataDir },
			{ integrationSettings: [settingsSegment] },
		);
		await runtime.configStore.load();
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.dataRoot) },
			...(statsOverview ? { statsOverview } : {}),
		});
		return { app, runtime };
	}

	it("GET /api/stats/overview 回的是传给 createApp 的那个取数函数给的,入参是路由校验过的值", async () => {
		const statsOverview = vi.fn(async (days: number, _tz: number) => ({ days, rows: [] }));
		const { app, runtime } = await makeApp(statsOverview);

		const res = await app.request("/api/stats/overview?days=7&tz=-480");

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ days: 7, rows: [] });
		expect(statsOverview).toHaveBeenCalledWith(7, -480);
		await runtime.dispose();
	});

	it("取数函数抛错:经全局出错处理回标准的失败体,原话进错误日志、不外泄", async () => {
		const boom = new Error("盘挂了");
		const { app, runtime } = await makeApp(async () => {
			throw boom;
		});
		const logError = vi.spyOn(runtime.serviceCtx.logger, "error");

		const res = await app.request("/api/stats/overview?days=7&tz=0");
		const text = await res.text();

		expect(res.status).toBe(503);
		expect(JSON.parse(text)).toEqual({
			code: "unavailable",
			message: "服务端出错了，详情在日志里",
		});
		expect(text).not.toContain("盘挂了");
		expect(logError).toHaveBeenCalledWith(expect.any(String), boom);
		await runtime.dispose();
	});
});
