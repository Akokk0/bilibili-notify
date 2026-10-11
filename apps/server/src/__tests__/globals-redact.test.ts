/**
 * 回归守护 — P0-3 fix(security): redact AI apiKey on GET /api/settings
 *
 * 密钥下发只有一种打码(ADR-0021 决策 44):`MaskedSecret { masked }`,哨兵字符串退役。
 *   a) GET 返回时 apiKey 非空 → `{ masked }`(不向浏览器泄漏),空串照旧是空串
 *   b) PATCH 带着 `{ masked }` → 400,store 保留原值;不带这一格 = 保留
 *      (这是最危险的回归点:写坏会把所有用户的 apiKey 静默覆盖成遮挡)
 *   c) PATCH 收到正常新 apiKey → 替换为新值;空串 → 清空
 *
 * 走的是 createApp + 真实 store 的**端到端**路径。下发那一半按 schema 标记逐桶遍历的单测在
 * `routes/__tests__/secret-view.test.ts`。
 *
 * 夹具是当代形状:新建的桶写明 `provider`(面板的 `addProfile` 也是这么建的;从前靠 schema 的 preprocess
 * 按键名盖章,那是给 0.x 老配置的,⑥c 搬进了迁移器)。
 *
 * 密钥现在住在 `ai.providers.<provider>.apiKey` —— 各家一套配置之后
 * 不再有全局那一把。这里固定用 deepseek 桶做样本。
 */

import { mkdtemp, rm } from "node:fs/promises";
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

describe("globals apiKey redact — P0-3", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-globals-redact-"));
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	it("a) GET /api/settings 返回 apiKey 时是 { masked }(且仅当原值非空)", async () => {
		const runtime = createAppRuntime(
			makeBootstrap(dataDir),
			{ dataRoot: dataDir },
			{ integrationSettings: [settingsSegment] },
		);
		await runtime.configStore.load();
		// 先写一个真实 apiKey
		await runtime.configStore.patchGlobals({
			ai: { providers: { deepseek: { provider: "deepseek", apiKey: "sk-secret-real-key" } } },
		});
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.dataRoot) },
		});

		const res = await app.request("/api/settings");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ai: { providers: Record<string, { apiKey: unknown }> };
		};
		// 正对照:真 key 确实写进了内存里的那份(下面的「不含明文」不是因为夹具被剥空)
		expect(runtime.configStore.getGlobals().ai.providers.deepseek?.apiKey).toBe(
			"sk-secret-real-key",
		);
		expect(body.ai.providers.deepseek?.apiKey).toEqual({ masked: "••••••••" });
		expect(JSON.stringify(body)).not.toContain("sk-secret-real-key");
		// 内部 store 仍持真实 key
		expect(runtime.configStore.getGlobals().ai.providers.deepseek?.apiKey).toBe(
			"sk-secret-real-key",
		);

		await runtime.dispose();
	});

	it("a') 原 apiKey 为空时 GET 返回空字符串(不返回遮挡,前端能区分'未配置')", async () => {
		const runtime = createAppRuntime(
			makeBootstrap(dataDir),
			{ dataRoot: dataDir },
			{ integrationSettings: [settingsSegment] },
		);
		await runtime.configStore.load();
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.dataRoot) },
		});

		const res = await app.request("/api/settings");
		const body = (await res.json()) as {
			ai: { providers: Record<string, { apiKey?: string } | undefined> };
		};
		// 全新配置一家都没添加,连桶都不该有 —— 更谈不上占位。
		expect(body.ai.providers).toEqual({});

		await runtime.dispose();
	});

	it("b) PATCH 带着 { masked } → 400,store 保留原 apiKey(不被破坏)", async () => {
		const runtime = createAppRuntime(
			makeBootstrap(dataDir),
			{ dataRoot: dataDir },
			{ integrationSettings: [settingsSegment] },
		);
		await runtime.configStore.load();
		await runtime.configStore.patchGlobals({
			ai: { providers: { deepseek: { provider: "deepseek", apiKey: "sk-original-key" } } },
		});
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.dataRoot) },
		});
		const patch = (body: unknown) =>
			app.request("/api/settings", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});

		const bad = await patch({
			ai: { providers: { deepseek: { apiKey: { masked: "••••••••" }, model: "gpt-4o-mini" } } },
		});
		expect(bad.status).toBe(400);
		// 话里说的是「这是遮挡、不是新值」,不是 zod 的「期望字符串」—— 后者是别的原因也会有的 400。
		expect(await bad.json()).toMatchObject({
			code: "invalid",
			message: expect.stringContaining("遮挡"),
			issues: [{ path: ["ai", "providers", "deepseek", "apiKey"] }],
		});
		const ds = () => runtime.configStore.getGlobals().ai.providers.deepseek;
		// store 内 apiKey 必须仍是原值,整发作废(model 也没落地)—— 这是 P0-3 最危险的回归点
		expect(ds()?.apiKey).toBe("sk-original-key");
		expect(ds()?.model).not.toBe("gpt-4o-mini");

		// 不带 apiKey 这一格 = 保留已存的,同桶其他字段正常落地
		const ok = await patch({
			ai: { providers: { deepseek: { model: "gpt-4o-mini" } } },
		});
		expect(ok.status).toBe(200);
		expect(ds()?.apiKey).toBe("sk-original-key");
		expect(ds()?.model).toBe("gpt-4o-mini");

		await runtime.dispose();
	});

	it("c) PATCH 带新 apiKey → store 更新为新值(不被 strip 误删)", async () => {
		const runtime = createAppRuntime(
			makeBootstrap(dataDir),
			{ dataRoot: dataDir },
			{ integrationSettings: [settingsSegment] },
		);
		await runtime.configStore.load();
		await runtime.configStore.patchGlobals({
			ai: { providers: { deepseek: { provider: "deepseek", apiKey: "sk-old-key" } } },
		});
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.dataRoot) },
		});

		const patchRes = await app.request("/api/settings", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				ai: { providers: { deepseek: { apiKey: "sk-brand-new-key" } } },
			}),
		});
		expect(patchRes.status).toBe(200);
		expect(runtime.configStore.getGlobals().ai.providers.deepseek?.apiKey).toBe("sk-brand-new-key");

		await runtime.dispose();
	});
	it("c') PATCH 带空串 → 清空这把 key(联网搜索 key 同理)", async () => {
		const runtime = createAppRuntime(
			makeBootstrap(dataDir),
			{ dataRoot: dataDir },
			{ integrationSettings: [settingsSegment] },
		);
		await runtime.configStore.load();
		await runtime.configStore.patchGlobals({
			ai: {
				providers: { deepseek: { provider: "deepseek", apiKey: "sk-old" } },
				search: { keys: { bocha: "sk-bocha" } },
			},
		});
		// 正对照:两把 key 确实写进去了,下面「清空」不是因为补丁被剥空
		expect(runtime.configStore.getGlobals().ai.providers.deepseek?.apiKey).toBe("sk-old");
		expect(runtime.configStore.getGlobals().ai.search.keys.bocha).toBe("sk-bocha");
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.dataRoot) },
		});
		const res = await app.request("/api/settings", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				ai: { providers: { deepseek: { apiKey: "" } }, search: { keys: { bocha: "" } } },
			}),
		});
		expect(res.status).toBe(200);
		const ai = runtime.configStore.getGlobals().ai;
		expect(ai.providers.deepseek?.apiKey).toBe("");
		expect(ai.search.keys.bocha).toBe("");
		await runtime.dispose();
	});

	it("d) PATCH 把某家的桶置为 null → 桶真的消失,落盘文件里那把钥匙也不再有", async () => {
		// 主人在设置页删掉一家。前端经 buildPatch 把「消失的键」编译成显式 null,
		// deepMerge 据此删键。要紧的是**加密袋**要跟着掉:writeGlobals 每次都用
		// collectAiSecrets 整袋重算,所以桶没了钥匙自然不再写入 —— 这条就是钉住
		// 「删了却没真删」的那道锁(主人明确要的是一并抹掉)。
		const runtime = createAppRuntime(
			makeBootstrap(dataDir),
			{ dataRoot: dataDir },
			{ integrationSettings: [settingsSegment] },
		);
		await runtime.configStore.load();
		await runtime.configStore.patchGlobals({
			ai: {
				activeProfile: "deepseek",
				providers: {
					deepseek: { provider: "deepseek", apiKey: "sk-going-away" },
					openrouter: { provider: "openrouter", apiKey: "sk-staying" },
				},
			},
		});
		// 正对照:两家的 key 都确实写进去了
		expect(runtime.configStore.getGlobals().ai.providers.deepseek?.apiKey).toBe("sk-going-away");
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.dataRoot) },
		});

		const patchRes = await app.request("/api/settings", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				ai: { activeProfile: "openrouter", providers: { deepseek: null } },
			}),
		});
		expect(patchRes.status).toBe(200);

		const providers = runtime.configStore.getGlobals().ai.providers;
		expect("deepseek" in providers).toBe(false);
		// 邻居毫发无伤 —— 删一家不能顺手带走别家的 key。
		expect(providers.openrouter?.apiKey).toBe("sk-staying");

		// 「密钥也一并抹掉」怎么证?落盘是密文,grep 字节证不了。改证**可观测的后果**:
		// 重新添加同一家时钥匙必须是空的 —— 袋子里若还留着旧的,hydrate 时
		// applyAiSecrets 会把它填回新桶,主人以为自己在配一张白纸,实际连着旧 key。
		await app.request("/api/settings", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				ai: { providers: { deepseek: { provider: "deepseek", model: "ds-v4" } } },
			}),
		});
		expect(runtime.configStore.getGlobals().ai.providers.deepseek?.apiKey).toBe("");

		await runtime.dispose();

		// 再从盘上冷启一次:删除与邻居的 key 都得是真落了盘,而不是只活在内存里。
		const reopened = createAppRuntime(
			makeBootstrap(dataDir),
			{ dataRoot: dataDir },
			{ integrationSettings: [settingsSegment] },
		);
		await reopened.configStore.load();
		const after = reopened.configStore.getGlobals().ai.providers;
		expect(after.deepseek?.apiKey).toBe("");
		expect(after.openrouter?.apiKey).toBe("sk-staying");
		await reopened.dispose();
	});
});
