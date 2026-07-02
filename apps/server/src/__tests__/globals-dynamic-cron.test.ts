/**
 * 回归守护 — PATCH /api/globals 拦截无法解析的 `app.dynamicCron`。
 *
 * `dynamicCron` 是 Dashboard 里的自由文本框,此前没有任何格式校验;一条 `cron`
 * 包解析不了的表达式(如漏填字段)能被直接保存进 globals.json,下次启动时
 * `DynamicEngine.startJob()` / fans-poller 的 `new CronJob(...)` 同步抛错,把
 * 整个独立端进程崩穿(见 fix commit 33c56ea 加的运行期 try/catch 防御)。
 * 本测试守的是纵深防御的第一层:写路径直接拒绝非法值,用户在 Dashboard 保存
 * 时就能看到明确报错,而不必等到下次启动才炸。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createApp } from "../app.js";
import type { BootstrapConfig } from "../config/schema.js";
import { createAppRuntime } from "../runtime/bootstrap.js";

function makeBootstrap(dataDir: string): BootstrapConfig {
	return { server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "silent" };
}

describe("PATCH /api/globals — dynamicCron 校验", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-globals-cron-"));
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	it("无法解析的 cron 表达式 → 400,store 不落地新值", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		const before = runtime.configStore.getGlobals().app.dynamicCron;
		const app = createApp(runtime, {});

		const res = await app.request("/api/globals", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ app: { dynamicCron: "not a cron expr" } }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; message: string };
		expect(body.error).toBe("invalid_payload");
		expect(body.message).toContain("dynamicCron");
		// 拒绝的值绝不能落地。
		expect(runtime.configStore.getGlobals().app.dynamicCron).toBe(before);

		await runtime.dispose();
	});

	it("合法 cron 表达式 → 200,store 更新为新值", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		const app = createApp(runtime, {});

		const res = await app.request("/api/globals", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ app: { dynamicCron: "*/5 * * * *" } }),
		});
		expect(res.status).toBe(200);
		expect(runtime.configStore.getGlobals().app.dynamicCron).toBe("*/5 * * * *");

		await runtime.dispose();
	});

	it("patch 不涉及 dynamicCron → 不校验,正常放行", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		const app = createApp(runtime, {});

		const res = await app.request("/api/globals", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ app: { healthCheckMinutes: 45 } }),
		});
		expect(res.status).toBe(200);
		expect(runtime.configStore.getGlobals().app.healthCheckMinutes).toBe(45);

		await runtime.dispose();
	});
});
