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
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createApp, createCardSkinStore } from "../app.js";
import { settingsSegment } from "../bilibili/settings.js";
import type { BootstrapConfig } from "../config/schema.js";
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
		return { runtime, send };
	}

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
