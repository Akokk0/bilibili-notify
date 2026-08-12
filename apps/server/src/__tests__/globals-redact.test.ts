/**
 * 回归守护 — P0-3 fix(security): redact AI apiKey on GET /api/globals
 *
 * 三件事:
 *   a) GET 返回时 apiKey 非空 → __BN_REDACTED__ 占位(不向浏览器泄漏)
 *   b) PATCH 收到 apiKey === __BN_REDACTED__ → 删除该字段,store 保留原值
 *      (这是最危险的回归点:写坏会把所有用户的 apiKey 静默覆盖为占位字符串)
 *   c) PATCH 收到正常新 apiKey → 替换为新值
 *
 * 走的是 createApp + 真实 store 的**端到端**路径。两个纯函数
 * (redactGlobals / stripRedactedSecrets)自己的单测在 `routes/__tests__/
 * globals-redact-fns.test.ts`,那边按「每家一桶、每桶两把」逐一遍历。
 *
 * 密钥现在住在 `defaults.ai.providers.<provider>.apiKey` —— 各家一套配置之后
 * 不再有全局那一把。这里固定用 deepseek 桶做样本。
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
			defaults: { ai: { providers: { deepseek: { apiKey: "sk-secret-real-key" } } } },
		});
		const app = createApp(runtime, {});

		const res = await app.request("/api/globals");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			defaults: { ai: { providers: Record<string, { apiKey: string }> } };
		};
		expect(body.defaults.ai.providers.deepseek?.apiKey).toBe(REDACTED);
		// 内部 store 仍持真实 key
		expect(runtime.configStore.getGlobals().defaults.ai.providers.deepseek?.apiKey).toBe(
			"sk-secret-real-key",
		);

		await runtime.dispose();
	});

	it("a') 原 apiKey 为空时 GET 返回空字符串(不返回 redact 占位,前端能区分'未配置')", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		const app = createApp(runtime, {});

		const res = await app.request("/api/globals");
		const body = (await res.json()) as {
			defaults: { ai: { providers: Record<string, { apiKey?: string } | undefined> } };
		};
		// 全新配置一家都没添加,连桶都不该有 —— 更谈不上占位。
		expect(body.defaults.ai.providers).toEqual({});

		await runtime.dispose();
	});

	it("b) PATCH 回传 REDACTED 占位 → store 保留原 apiKey(不被破坏)", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		await runtime.configStore.patchGlobals({
			defaults: { ai: { providers: { deepseek: { apiKey: "sk-original-key" } } } },
		});
		const app = createApp(runtime, {});

		const patchRes = await app.request("/api/globals", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				defaults: { ai: { providers: { deepseek: { apiKey: REDACTED, model: "gpt-4o-mini" } } } },
			}),
		});
		expect(patchRes.status).toBe(200);
		// store 内 apiKey 必须仍是原值 — 这是 P0-3 最危险的回归点
		const ds = () => runtime.configStore.getGlobals().defaults.ai.providers.deepseek;
		expect(ds()?.apiKey).toBe("sk-original-key");
		// 同桶其他字段(model)应正常落地
		expect(ds()?.model).toBe("gpt-4o-mini");

		await runtime.dispose();
	});

	it("c) PATCH 带新 apiKey → store 更新为新值(不被 strip 误删)", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		await runtime.configStore.patchGlobals({
			defaults: { ai: { providers: { deepseek: { apiKey: "sk-old-key" } } } },
		});
		const app = createApp(runtime, {});

		const patchRes = await app.request("/api/globals", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				defaults: { ai: { providers: { deepseek: { apiKey: "sk-brand-new-key" } } } },
			}),
		});
		expect(patchRes.status).toBe(200);
		expect(runtime.configStore.getGlobals().defaults.ai.providers.deepseek?.apiKey).toBe(
			"sk-brand-new-key",
		);

		await runtime.dispose();
	});
	it("d) PATCH 把某家的桶置为 null → 桶真的消失,落盘文件里那把钥匙也不再有", async () => {
		// 主人在设置页删掉一家。前端经 buildPatch 把「消失的键」编译成显式 null,
		// deepMerge 据此删键。要紧的是**加密袋**要跟着掉:writeGlobals 每次都用
		// collectAiSecrets 整袋重算,所以桶没了钥匙自然不再写入 —— 这条就是钉住
		// 「删了却没真删」的那道锁(主人明确要的是一并抹掉)。
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		await runtime.configStore.patchGlobals({
			defaults: {
				ai: {
					activeProfile: "deepseek",
					providers: {
						deepseek: { apiKey: "sk-going-away" },
						openrouter: { apiKey: "sk-staying" },
					},
				},
			},
		});
		const app = createApp(runtime, {});

		const patchRes = await app.request("/api/globals", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				defaults: { ai: { provider: "openrouter", providers: { deepseek: null } } },
			}),
		});
		expect(patchRes.status).toBe(200);

		const providers = runtime.configStore.getGlobals().defaults.ai.providers;
		expect("deepseek" in providers).toBe(false);
		// 邻居毫发无伤 —— 删一家不能顺手带走别家的 key。
		expect(providers.openrouter?.apiKey).toBe("sk-staying");

		// 「密钥也一并抹掉」怎么证?落盘是密文,grep 字节证不了。改证**可观测的后果**:
		// 重新添加同一家时钥匙必须是空的 —— 袋子里若还留着旧的,hydrate 时
		// applyAiSecrets 会把它填回新桶,主人以为自己在配一张白纸,实际连着旧 key。
		await app.request("/api/globals", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ defaults: { ai: { providers: { deepseek: { model: "ds-v4" } } } } }),
		});
		expect(runtime.configStore.getGlobals().defaults.ai.providers.deepseek?.apiKey).toBe("");

		await runtime.dispose();

		// 再从盘上冷启一次:删除与邻居的 key 都得是真落了盘,而不是只活在内存里。
		const reopened = createAppRuntime(makeBootstrap(dataDir));
		await reopened.configStore.load();
		const after = reopened.configStore.getGlobals().defaults.ai.providers;
		expect(after.deepseek?.apiKey).toBe("");
		expect(after.openrouter?.apiKey).toBe("sk-staying");
		await reopened.dispose();
	});
});
