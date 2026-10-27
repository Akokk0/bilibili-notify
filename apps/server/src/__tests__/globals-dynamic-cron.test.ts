/**
 * 回归守护 — PATCH /api/settings 拦截无法解析的 `bilibili.dynamicCron`。
 *
 * `dynamicCron` 是 Dashboard 里的自由文本框,此前没有任何格式校验;一条 `cron`
 * 包解析不了的表达式(如漏填字段)能被直接保存进设置文件,下次启动时
 * `DynamicPoller.startJob()` / profile-refresh 的 `new CronJob(...)` 同步抛错,把
 * 整个独立端进程崩穿(见 fix commit 33c56ea 加的运行期 try/catch 防御)。
 * 本测试守的是纵深防御的第一层:写路径直接拒绝非法值,用户在 Dashboard 保存
 * 时就能看到明确报错,而不必等到下次启动才炸。
 *
 * 这一格住在 B 站自己的设置文件(`config/settings/bilibili.json`),在 `/api/settings` 上挂在
 * `bilibili` 键下;核对写入的那道门由 B 站登记进配置仓(`bilibili/settings.ts` 的 `checkWrite`)。
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createApp, createCardSkinStore } from "../app.js";
import type { BiliSettings } from "../bilibili/settings.js";
import { settingsSegment } from "../bilibili/settings.js";
import type { BootstrapConfig } from "../config/schema.js";
import { CORE_SETTINGS_FILE, type ConfigStore, integrationSettingsFile } from "../config/store.js";
import { createAppRuntime } from "../runtime/bootstrap.js";

/** 仓里内存那一份 B 站设置。 */
const bili = (store: ConfigStore) => store.getAllIntegrationSettings().bilibili as BiliSettings;

function makeBootstrap(dataDir: string): BootstrapConfig {
	return { server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "silent" };
}

describe("PATCH /api/settings — bilibili.dynamicCron 校验", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-globals-cron-"));
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	const bilibiliFile = () => join(dataDir, ...integrationSettingsFile("bilibili"));

	function patch(app: ReturnType<typeof createApp>, body: unknown) {
		return app.request("/api/settings", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	it("无法解析的 cron 表达式 → 400,store 不落地新值", async () => {
		const runtime = createAppRuntime(
			makeBootstrap(dataDir),
			{ dataRoot: dataDir },
			{ integrationSettings: [settingsSegment] },
		);
		await runtime.configStore.load();
		const before = bili(runtime.configStore).dynamicCron;
		const fileBefore = await readFile(bilibiliFile(), "utf8");
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.dataRoot) },
		});

		const res = await patch(app, { bilibili: { dynamicCron: "not a cron expr" } });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { code: string; message: string; issues: unknown[] };
		expect(body.code).toBe("invalid");
		expect(body.message).toContain("dynamicCron");
		// 逐格原因点名那一格(路径带上集成的键),面板可以据此标红。
		expect(body.issues).toEqual([
			{ path: ["bilibili", "dynamicCron"], message: '不是合法的 cron 表达式："not a cron expr"' },
		]);
		// 拒绝的值绝不能落地:内存与盘上都是原样。
		expect(bili(runtime.configStore).dynamicCron).toBe(before);
		expect(await readFile(bilibiliFile(), "utf8")).toBe(fileBefore);

		await runtime.dispose();
	});

	it("合法 cron 表达式 → 200,store 更新为新值,GET 读回同一格", async () => {
		const runtime = createAppRuntime(
			makeBootstrap(dataDir),
			{ dataRoot: dataDir },
			{ integrationSettings: [settingsSegment] },
		);
		await runtime.configStore.load();
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.dataRoot) },
		});

		const res = await patch(app, { bilibili: { dynamicCron: "*/5 * * * *" } });
		expect(res.status).toBe(200);
		const patched = (await res.json()) as { bilibili: { dynamicCron: string } };
		expect(patched.bilibili.dynamicCron).toBe("*/5 * * * *");
		expect(bili(runtime.configStore).dynamicCron).toBe("*/5 * * * *");
		expect(JSON.parse(await readFile(bilibiliFile(), "utf8")).dynamicCron).toBe("*/5 * * * *");

		const got = (await (await app.request("/api/settings")).json()) as {
			bilibili: { dynamicCron: string };
		};
		expect(got.bilibili.dynamicCron).toBe("*/5 * * * *");

		await runtime.dispose();
	});

	it("补丁不动 dynamicCron → 照常放行,cron 保持原值", async () => {
		const runtime = createAppRuntime(
			makeBootstrap(dataDir),
			{ dataRoot: dataDir },
			{ integrationSettings: [settingsSegment] },
		);
		await runtime.configStore.load();
		const before = bili(runtime.configStore).dynamicCron;
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.dataRoot) },
		});

		const res = await patch(app, { bilibili: { healthCheckMinutes: 45 } });
		expect(res.status).toBe(200);
		expect(bili(runtime.configStore).healthCheckMinutes).toBe(45);
		expect(bili(runtime.configStore).dynamicCron).toBe(before);

		await runtime.dispose();
	});

	it("同一发里核心与 B 站的格子一起送:B 站那格被拒 → 核心那格也不落地", async () => {
		const runtime = createAppRuntime(
			makeBootstrap(dataDir),
			{ dataRoot: dataDir },
			{ integrationSettings: [settingsSegment] },
		);
		await runtime.configStore.load();
		const refreshCronBefore = runtime.configStore.getGlobals().profileRefreshCron;
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.dataRoot) },
		});

		const res = await patch(app, {
			core: { profileRefreshCron: "*/20 * * * *" },
			bilibili: { dynamicCron: "not a cron expr" },
		});
		expect(res.status).toBe(400);
		expect(runtime.configStore.getGlobals().profileRefreshCron).toBe(refreshCronBefore);

		await runtime.dispose();
	});

	it("同一发里核心与 B 站的格子一起送,都合法 → 各落各的文件", async () => {
		const runtime = createAppRuntime(
			makeBootstrap(dataDir),
			{ dataRoot: dataDir },
			{ integrationSettings: [settingsSegment] },
		);
		await runtime.configStore.load();
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.dataRoot) },
		});

		const res = await patch(app, {
			core: { profileRefreshCron: "*/20 * * * *" },
			bilibili: { healthCheckMinutes: 60 },
		});
		expect(res.status).toBe(200);
		expect(runtime.configStore.getGlobals().profileRefreshCron).toBe("*/20 * * * *");
		expect(bili(runtime.configStore).healthCheckMinutes).toBe(60);
		// 两格各回各的家:核心文件里没有 B 站的键,B 站文件里没有核心的。
		const bilibili = JSON.parse(await readFile(bilibiliFile(), "utf8"));
		expect(bilibili.healthCheckMinutes).toBe(60);
		expect(bilibili).not.toHaveProperty("profileRefreshCron");
		const core = JSON.parse(await readFile(join(dataDir, ...CORE_SETTINGS_FILE), "utf8"));
		expect(core.profileRefreshCron).toBe("*/20 * * * *");
		expect(core).not.toHaveProperty("bilibili");
		expect(core).not.toHaveProperty("app");
		expect(core.logging).not.toHaveProperty("healthCheckMinutes");

		await runtime.dispose();
	});
});
