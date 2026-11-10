import type { InvalidSettingsResponse } from "@bilibili-notify/contract";
/**
 * `/api/settings` 的线上形状(第 4 期 4-08):核心那份挂在 `core` 下,各集成的设置挂在自己的键下,GET 与 PATCH
 * 同一个形状。PATCH 顶层只认 `core` 与登记过的集成键 —— 老面板(核心平铺在顶层)整份写回会被拒,不会被当成
 * 「没登记的集成」悄悄吞掉。逐格原因的路径与请求体对得上(核心的带 `core`)。
 *
 * 跑真 app + 真 store。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createApp, createCardSkinStore } from "../app.js";
import { BUILTIN_INTEGRATION_SETTINGS } from "../compose.js";
import type { BootstrapConfig } from "../config/schema.js";
import { CORE_SETTINGS_FILE } from "../config/store.js";
import { i18n } from "../i18n/index.js";
import { createAppRuntime } from "../runtime/bootstrap.js";

type SettingsBody = { core: Record<string, unknown> } & Record<string, unknown>;

function makeBootstrap(dataDir: string): BootstrapConfig {
	return { server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "silent" };
}

describe("/api/settings 的形状", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-settings-shape-"));
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	async function boot() {
		const runtime = createAppRuntime(
			makeBootstrap(dataDir),
			{ dataRoot: dataDir },
			{ integrationSettings: BUILTIN_INTEGRATION_SETTINGS },
		);
		await runtime.configStore.load();
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.dataRoot) },
		});
		const patch = (body: unknown) =>
			app.request("/api/settings", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
		return { runtime, app, patch };
	}

	it.each([
		[
			"en",
			"core must be an object containing the core settings patch.",
			"The owner's push target does not exist. Select another private-message target.",
		],
		[
			"ja",
			"coreには、コア設定の変更内容をオブジェクトで指定してください。",
			"管理者の送信先が存在しません。別の個人チャットの送信先を選択してください。",
		],
		[
			"zh-TW",
			"core 必須是包含核心設定變更的物件。",
			"主人的推播目標不存在，請重新選擇一個私訊目標。",
		],
	] as const)(
		"localizes rejected settings patches in %s without changing state or issue paths",
		async (locale, shapeMessage, masterMessage) => {
			const { runtime, patch } = await boot();
			const previous = i18n.state();
			const before = runtime.configStore.getGlobals();
			try {
				i18n.set({ locale, voice: "plain" });
				const shape = await patch({ core: "original invalid input" });
				expect(shape.status).toBe(400);
				expect(await shape.json()).toMatchObject({ code: "invalid", message: shapeMessage });
				const master = await patch({
					core: { master: { targetId: "cbd744bc-3fe8-4b72-b038-f606f3b162c7" } },
				});
				expect(master.status).toBe(400);
				expect(await master.json()).toMatchObject({
					code: "invalid",
					message: masterMessage,
					issues: [{ path: ["core", "master", "targetId"] }],
				});
				expect(runtime.configStore.getGlobals()).toEqual(before);
			} finally {
				i18n.set(previous);
				await runtime.dispose();
			}
		},
	);

	const coreFile = () => join(dataDir, ...CORE_SETTINGS_FILE);

	it("仓库来源经设置写口保存后，读取的是可直接获取的固定 HTTPS 索引", async () => {
		const { runtime, app, patch } = await boot();
		try {
			const response = await patch({
				core: { marketplace: { sources: [{ id: "repo", url: "Alice/Tools" }] } },
			});
			expect(response.status).toBe(200);
			expect(await (await app.request("/api/settings")).json()).toMatchObject({
				core: {
					marketplace: {
						sources: [
							{
								id: "repo",
								url: "https://github.com/alice/tools/releases/download/bn-marketplace/marketplace.json",
							},
						],
					},
				},
			});
			const rejected = await patch({
				core: { marketplace: { sources: [{ id: "repo", url: "Alice/.." }] } },
			});
			expect(rejected.status).toBe(400);
			expect(await (await app.request("/api/settings")).json()).toMatchObject({
				core: {
					marketplace: {
						sources: [
							{
								id: "repo",
								url: "https://github.com/alice/tools/releases/download/bn-marketplace/marketplace.json",
							},
						],
					},
				},
			});
		} finally {
			await runtime.dispose();
		}
	});

	it("GET invalid exposes prefixed public raw cells with no-store", async () => {
		await mkdir(join(coreFile(), ".."), { recursive: true });
		await writeFile(coreFile(), JSON.stringify({ history: { retentionDays: 45 } }));
		const { runtime, app } = await boot();
		try {
			const response = await app.request("/api/settings/invalid");
			expect(response.status).toBe(200);
			expect(response.headers.get("cache-control")).toBe("no-store");
			expect(((await response.json()) as InvalidSettingsResponse).entries).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						path: ["core", "history"],
						secret: false,
						raw: { retentionDays: 45 },
					}),
				]),
			);
		} finally {
			await runtime.dispose();
		}
	});

	it("GET:顶层只有 `core` 与各集成的键,核心的键都在 `core` 下", async () => {
		const { runtime, app } = await boot();
		const res = await app.request("/api/settings");
		expect(res.status).toBe(200);
		const body = (await res.json()) as SettingsBody;
		expect(Object.keys(body).sort()).toEqual(
			["bilibili", "core", "onebot", "qq-official", "webhook"].sort(),
		);
		expect(body.core.profileRefreshCron).toBe(runtime.configStore.getGlobals().profileRefreshCron);
		expect(body.core).toHaveProperty("logging");
		await runtime.dispose();
	});

	it("PATCH { core: {...} } → 200,核心那份写进去,回的是同一个形状", async () => {
		const { runtime, patch } = await boot();
		const res = await patch({ core: { profileRefreshCron: "0 5 * * *" } });
		expect(res.status).toBe(200);
		const body = (await res.json()) as SettingsBody;
		expect(body.core.profileRefreshCron).toBe("0 5 * * *");
		expect(body).not.toHaveProperty("profileRefreshCron");
		expect(body).toHaveProperty("bilibili");
		expect(runtime.configStore.getGlobals().profileRefreshCron).toBe("0 5 * * *");
		await runtime.dispose();
	});

	it("PATCH 顶层带核心的键(老面板平铺的写法)→ 400 invalid,点名那个键,一个字都不写", async () => {
		const { runtime, patch } = await boot();
		const before = runtime.configStore.getGlobals();
		const bytes = await readFile(coreFile(), "utf8");
		const res = await patch({ profileRefreshCron: "0 5 * * *", bilibili: {} });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { code: string; message: string };
		expect(body.code).toBe("invalid");
		expect(body.message).toContain("profileRefreshCron");
		expect(runtime.configStore.getGlobals()).toEqual(before);
		expect(await readFile(coreFile(), "utf8")).toBe(bytes);
		await runtime.dispose();
	});

	it("PATCH 的 `core` 不是对象 → 400 invalid", async () => {
		const { runtime, patch } = await boot();
		for (const core of [null, 5, "x", [1]]) {
			const res = await patch({ core });
			expect(res.status, JSON.stringify(core)).toBe(400);
			expect(((await res.json()) as { code: string }).code).toBe("invalid");
		}
		await runtime.dispose();
	});

	it("核心校验不过 → 逐格原因的路径带 `core`(与请求体对得上)", async () => {
		const { runtime, patch } = await boot();
		const res = await patch({ core: { master: { targetId: 123 } } });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { issues: Array<{ path: unknown[] }> };
		expect(body.issues).toEqual([
			expect.objectContaining({ path: ["core", "master", "targetId"] }),
		]);
		await runtime.dispose();
	});

	it("主人目标指向不存在的目标 → 路径同样带 `core`", async () => {
		const { runtime, patch } = await boot();
		const res = await patch({ core: { master: { targetId: "nope" } } });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { issues: Array<{ path: unknown[] }> };
		expect(body.issues).toEqual([
			expect.objectContaining({ path: ["core", "master", "targetId"] }),
		]);
		await runtime.dispose();
	});
});
