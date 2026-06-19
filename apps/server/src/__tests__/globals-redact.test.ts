/**
 * 回归守护 — P0-3 fix(security): redact AI apiKey on GET /api/globals
 *
 * 三件事:
 *   a) GET 返回时 apiKey 非空 → __BN_REDACTED__ 占位(不向浏览器泄漏)
 *   b) PATCH 收到 apiKey === __BN_REDACTED__ → 删除该字段,store 保留原值
 *      (这是最危险的回归点:写坏会把所有用户的 apiKey 静默覆盖为占位字符串)
 *   c) PATCH 收到正常新 apiKey → 替换为新值
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createApp } from "../app.js";
import type { BootstrapConfig } from "../config/schema.js";
import { createAppRuntime } from "../runtime/bootstrap.js";

const REDACTED = "__BN_REDACTED__";

function makeBootstrap(dataDir: string): BootstrapConfig {
	return { server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "silent" };
}

describe("globals apiKey redact — P0-3", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-globals-redact-"));
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	it("a) GET /api/globals 返回 apiKey 时是 __BN_REDACTED__ 占位(且仅当原值非空)", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		// 先写一个真实 apiKey
		await runtime.configStore.patchGlobals({
			defaults: { ai: { apiKey: "sk-secret-real-key" } },
		});
		const app = createApp(runtime, {});

		const res = await app.request("/api/globals");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			defaults: { ai: { apiKey: string } };
		};
		expect(body.defaults.ai.apiKey).toBe(REDACTED);
		// 内部 store 仍持真实 key
		expect(runtime.configStore.getGlobals().defaults.ai.apiKey).toBe("sk-secret-real-key");

		await runtime.dispose();
	});

	it("a') 原 apiKey 为空时 GET 返回空字符串(不返回 redact 占位,前端能区分'未配置')", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		const app = createApp(runtime, {});

		const res = await app.request("/api/globals");
		const body = (await res.json()) as { defaults: { ai: { apiKey?: string } } };
		// schema default 是 "" 或 undefined,这里宽松断言:不是 REDACTED 占位即可
		expect(body.defaults.ai.apiKey ?? "").not.toBe(REDACTED);

		await runtime.dispose();
	});

	it("b) PATCH 回传 REDACTED 占位 → store 保留原 apiKey(不被破坏)", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		await runtime.configStore.patchGlobals({
			defaults: { ai: { apiKey: "sk-original-key" } },
		});
		const app = createApp(runtime, {});

		const patchRes = await app.request("/api/globals", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				defaults: { ai: { apiKey: REDACTED, model: "gpt-4o-mini" } },
			}),
		});
		expect(patchRes.status).toBe(200);
		// store 内 apiKey 必须仍是原值 — 这是 P0-3 最危险的回归点
		expect(runtime.configStore.getGlobals().defaults.ai.apiKey).toBe("sk-original-key");
		// 其他字段(model)应正常落地
		expect(runtime.configStore.getGlobals().defaults.ai.model).toBe("gpt-4o-mini");

		await runtime.dispose();
	});

	it("c) PATCH 带新 apiKey → store 更新为新值(不被 strip 误删)", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		await runtime.configStore.patchGlobals({
			defaults: { ai: { apiKey: "sk-old-key" } },
		});
		const app = createApp(runtime, {});

		const patchRes = await app.request("/api/globals", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				defaults: { ai: { apiKey: "sk-brand-new-key" } },
			}),
		});
		expect(patchRes.status).toBe(200);
		expect(runtime.configStore.getGlobals().defaults.ai.apiKey).toBe("sk-brand-new-key");

		await runtime.dispose();
	});
});
