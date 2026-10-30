/**
 * PATCH /api/settings 的失败一律是平铺的 `{ code, message }`(ADR-0026),状态码从码推:
 * - 体不成形 / store 校验不过 → `invalid` 400(顶上一句中文,逐格原因进 `issues`,不再带 `scope`)。
 * - 指令别名撞名 → `conflict` 409。
 * - 启用前置条件没满足(没配 Chrome / key 是空的 / 审批没有可用的私聊通道)→ `not_configured` 409。
 *
 * 跑真 app + 真 store,失败的码来自各处自己的判定,不是测试替身编的。守卫「错误体」在收尾对一遍回出去的体。
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

describe("PATCH /api/settings 的失败", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-globals-failures-"));
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	async function boot(
		commands?: Array<{ name: string; aliases?: string[] }>,
		puppeteer?: { page: () => Promise<{ close: () => Promise<void> }> },
	) {
		const runtime = createAppRuntime(
			makeBootstrap(dataDir),
			{ dataRoot: dataDir },
			{ integrationSettings: [settingsSegment] },
		);
		await runtime.configStore.load();
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.dataRoot) },
			commands: commands as never,
			puppeteer: puppeteer as never,
		});
		const patch = (body: unknown) =>
			app.request("/api/settings", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: typeof body === "string" ? body : JSON.stringify(body),
			});
		/** 改核心设置(`/api/settings` 上挂在 `core` 下)。 */
		const patchCore = (core: unknown) => patch({ core });
		return { runtime, patch, patchCore };
	}

	it("体不是合法 JSON → 400 invalid", async () => {
		const { runtime, patch } = await boot();
		const res = await patch("{oops");
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ code: "invalid", message: "请求体不是合法的 JSON" });
		await runtime.dispose();
	});

	it("体是数组 → 400 invalid", async () => {
		const { runtime, patch } = await boot();
		const res = await patch([1, 2]);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			code: "invalid",
			message: "请求体要是一个 JSON 对象，不能是数组或单个值",
		});
		await runtime.dispose();
	});

	it("store 校验不过 → 400 invalid,顶上一句中文 + 逐格 issues,没有 scope", async () => {
		const { runtime, patchCore } = await boot();
		const res = await patchCore({ master: { targetId: 123 } });
		expect(res.status).toBe(400);
		const body = (await res.json()) as {
			code: string;
			message: string;
			issues: Array<{ path: unknown[]; message: string }>;
		};
		expect(body.code).toBe("invalid");
		expect(body.message).toMatch(/^全局设置有 \d+ 格不合法：master\.targetId：/);
		// 路径与请求体对得上:核心那份挂在 `core` 下。
		expect(body.issues).toEqual([
			expect.objectContaining({ path: ["core", "master", "targetId"] }),
		]);
		expect(body).not.toHaveProperty("scope");
		await runtime.dispose();
	});

	it("指令别名撞名 → 409 conflict,话里点名跟谁撞", async () => {
		const { runtime, patchCore } = await boot([{ name: "帮助" }, { name: "静音" }]);
		const res = await patchCore({ commands: { aliases: { 帮助: ["静音"] } } });
		expect(res.status).toBe(409);
		const body = (await res.json()) as { code: string; message: string };
		expect(body.code).toBe("conflict");
		expect(body.message).toContain("静音");
		await runtime.dispose();
	});

	it("启用卡片渲染但没配 Chrome → 409 not_configured,话里指路(BN_CHROME_PATH)", async () => {
		const { runtime, patchCore } = await boot();
		const before = runtime.configStore.getGlobals();
		const res = await patchCore({ defaults: { cards: { enabled: true } } });
		expect(res.status).toBe(409);
		const body = (await res.json()) as { code: string; message: string };
		expect(body.code).toBe("not_configured");
		expect(body.message).toContain("BN_CHROME_PATH");
		// 前置条件没满足,这一发整个不落盘。
		expect(runtime.configStore.getGlobals()).toEqual(before);
		await runtime.dispose();
	});

	it("启用卡片渲染、Chrome 配了但起不来 → 503 unavailable,话里带底层的原因", async () => {
		const { runtime, patchCore } = await boot(undefined, {
			page: async () => {
				throw new Error("spawn /opt/chrome ENOENT");
			},
		});
		const before = runtime.configStore.getGlobals();
		const res = await patchCore({ defaults: { cards: { enabled: true } } });
		expect(res.status).toBe(503);
		const body = (await res.json()) as { code: string; message: string };
		expect(body.code).toBe("unavailable");
		expect(body.message).toContain("主人，puppeteer 没能启动：spawn /opt/chrome ENOENT");
		expect(runtime.configStore.getGlobals()).toEqual(before);
		await runtime.dispose();
	});

	it("启用卡片渲染、Chrome 起得来 → 放行(200)", async () => {
		const { runtime, patchCore } = await boot(undefined, {
			page: async () => ({ close: async () => {} }),
		});
		const res = await patchCore({ defaults: { cards: { enabled: true } } });
		expect(res.status).toBe(200);
		await runtime.dispose();
	});

	it("启用 AI 但 key 是空的 → 409 not_configured", async () => {
		const { runtime, patchCore } = await boot();
		const res = await patchCore({ ai: { enabled: true } });
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({
			code: "not_configured",
			message: "apiKey 字段为空，启用 AI 前请先填写。",
		});
		await runtime.dispose();
	});

	it("打开审批但没配主人私聊目标 → 409 not_configured", async () => {
		const { runtime, patchCore } = await boot();
		const res = await patchCore({ roastSchedule: { approval: true } });
		expect(res.status).toBe(409);
		const body = (await res.json()) as { code: string; message: string };
		expect(body.code).toBe("not_configured");
		expect(body.message).toContain("主人私聊目标");
		await runtime.dispose();
	});
});
