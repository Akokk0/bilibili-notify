import { DICTS as BILI_DICTS } from "../bilibili/i18n.js";
/**
 * 自定义 UA 删了(浏览器身份一律由 `packages/http` 生成,UA 与 `sec-ch-ua` 永远配套,ADR-0025 决策 7)。
 *
 * B 站设置的格式不是 strict:老面板 / 老脚本往 `PATCH /api/settings` 的 `bilibili` 里塞 `userAgent`,不该换来一个 400 ——
 * 同一次补丁里别的格照常保存,这一格被剥掉,既不落盘、也不在 GET 回出去的快照里。
 *
 * 跑真 app + 真 store(与 `globals-failures.test.ts` 同一套起法):剥掉发生在配置仓按登记的格式解析那一步,
 * 路由只管把 `bilibili` 键拆出来递过去,这条接线只有走完整条路才看得见。
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IntegrationSettingsDescriptorsResponse } from "@bilibili-notify/contract";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createApp, createCardSkinStore } from "../app.js";
import { settingsSegment } from "../bilibili/settings.js";
import type { BootstrapConfig } from "../config/schema.js";
import { i18n } from "../i18n/index.js";
import { createAppRuntime } from "../runtime/bootstrap.js";

function makeBootstrap(dataDir: string): BootstrapConfig {
	return { server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "silent" };
}

describe("PATCH /api/settings × bilibili.userAgent(已删的一格)", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-settings-bilibili-ua-"));
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	async function boot() {
		const runtime = createAppRuntime(
			makeBootstrap(dataDir),
			{ dataRoot: dataDir },
			{ integrationSettings: [settingsSegment] },
		);
		await runtime.configStore.load();
		const app = createApp(runtime, { cardSkins: { store: createCardSkinStore(runtime.dataRoot) } });
		const send = (method: "GET" | "PATCH", body?: unknown) =>
			app.request("/api/settings", {
				method,
				headers: { "Content-Type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		return { runtime, send, app };
	}

	it.each([
		[
			"ja",
			[
				"ご主人様、このCron式に従って新しい投稿を確認します。保存すると確認時刻を調整しますね。",
				"ご主人様、ログイン状態を定期的に確認します。保存すると反映されますよ。",
			],
			[
				"Cron式に従って新しい投稿を確認します。保存すると確認スケジュールを自動で調整します。",
				"ログイン状態を定期的に確認します。保存すると変更が反映されます。",
			],
		],
		[
			"zh-TW",
			[
				"主人，女僕會依這份 Cron 表達式檢查新作品，儲存後就調整檢查時間喔。",
				"主人，女僕會定期檢查登入狀態，儲存後就生效喔。",
			],
			["依 Cron 表達式檢查新作品，儲存後會自動調整檢查時間。", "定期檢查登入狀態，儲存後生效。"],
		],
	] as const)("%s：已有设置描述按当前口吻下发，字段规则与设置不变", async (locale, maid, plain) => {
		const { runtime, app } = await boot();
		const previous = i18n.state();
		const saved = structuredClone(runtime.configStore.getAllIntegrationSettings());
		try {
			i18n.set({ locale, voice: "maid" });
			const firstResponse = await app.request("/api/settings/integrations");
			expect(firstResponse.status).toBe(200);
			const first = (await firstResponse.json()) as IntegrationSettingsDescriptorsResponse;
			expect(first.integrations[0]?.fields.map((field) => field.description)).toEqual(maid);
			i18n.set({ voice: "plain" });
			const secondResponse = await app.request("/api/settings/integrations");
			expect(secondResponse.status).toBe(200);
			const second = (await secondResponse.json()) as IntegrationSettingsDescriptorsResponse;
			expect(second.integrations[0]?.fields.map((field) => field.description)).toEqual(plain);
			const withoutDescriptions = (
				fields: IntegrationSettingsDescriptorsResponse["integrations"][number]["fields"],
			) => fields.map(({ description: _, ...field }) => field);
			expect(withoutDescriptions(first.integrations[0]?.fields ?? [])).toEqual(
				withoutDescriptions(second.integrations[0]?.fields ?? []),
			);
			expect(first.integrations[0]?.fields.map((field) => field.description)).toEqual(maid);
			expect(runtime.configStore.getAllIntegrationSettings()).toEqual(saved);
		} finally {
			i18n.set({ locale: previous.locale, voice: previous.voice });
			await runtime.dispose();
		}
	});

	it("经设置读口下发规则导出的两格，登录心跳上下限与写入规则一致", async () => {
		const { runtime, app } = await boot();
		try {
			const response = await app.request("/api/settings/integrations");
			expect(response.status).toBe(200);
			const body = (await response.json()) as IntegrationSettingsDescriptorsResponse;
			expect(body.integrations).toEqual([
				expect.objectContaining({
					key: "bilibili",
					fields: [
						expect.objectContaining({ key: "dynamicCron", type: "string" }),
						expect.objectContaining({
							key: "healthCheckMinutes",
							type: "number",
							min: 5,
							max: 180,
						}),
					],
				}),
			]);
		} finally {
			await runtime.dispose();
		}
	});

	it("描述在请求时读取当前语言，已有规则与设置不重建", async () => {
		const { runtime, app } = await boot();
		const state = i18n.state();
		const key = "bilibili.source.dynamicCell";
		const english = BILI_DICTS.en.plain as Record<string, string>;
		const japanese = BILI_DICTS.ja.plain as Record<string, string>;
		const previousEn = english[key];
		const previousJa = japanese[key];
		english[key] = "First label";
		japanese[key] = "Changed label";
		i18n.set({ locale: "en", voice: "plain" });
		try {
			const first = (await (
				await app.request("/api/settings/integrations")
			).json()) as IntegrationSettingsDescriptorsResponse;
			expect(first.integrations[0]?.fields[0]?.label).toBe("First label");
			i18n.set({ locale: "ja" });
			const second = (await (
				await app.request("/api/settings/integrations")
			).json()) as IntegrationSettingsDescriptorsResponse;
			expect(second.integrations[0]?.fields[0]?.label).toBe("Changed label");
		} finally {
			if (previousEn === undefined) delete english[key];
			else english[key] = previousEn;
			if (previousJa === undefined) delete japanese[key];
			else japanese[key] = previousJa;
			i18n.set({ locale: state.locale, voice: state.voice });
			await runtime.dispose();
		}
	});
	it("带 userAgent 的补丁:200,别的格照常保存;回出去的快照与盘上都没有 userAgent", async () => {
		const { runtime, send } = await boot();

		const res = await send("PATCH", { bilibili: { userAgent: "UA/2", healthCheckMinutes: 45 } });

		expect(res.status).toBe(200);
		const patched = (await res.json()) as { bilibili: Record<string, unknown> };
		expect(patched.bilibili.healthCheckMinutes).toBe(45);
		expect(patched.bilibili).not.toHaveProperty("userAgent");
		const got = (await (await send("GET")).json()) as { bilibili: Record<string, unknown> };
		expect(got.bilibili.healthCheckMinutes).toBe(45);
		expect(got.bilibili).not.toHaveProperty("userAgent");
		const onDisk = JSON.parse(
			await readFile(join(dataDir, "config", "settings", "bilibili.json"), "utf8"),
		) as Record<string, unknown>;
		expect(onDisk.healthCheckMinutes).toBe(45);
		expect(onDisk).not.toHaveProperty("userAgent");
		await runtime.dispose();
	});

	it("`userAgent: null`(老面板清空这一格时发的删除哨兵)也不报错", async () => {
		const { runtime, send } = await boot();

		const res = await send("PATCH", { bilibili: { userAgent: null } });

		expect(res.status).toBe(200);
		expect(
			((await res.json()) as { bilibili: Record<string, unknown> }).bilibili,
		).not.toHaveProperty("userAgent");
		await runtime.dispose();
	});
});
