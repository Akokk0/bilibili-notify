import { makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { AstrBotAiBridge, AstrBotAiRequestQueue, SCENE_TASK_PROMPTS } from "./ai-bridge.js";

describe("AstrBotAiBridge", () => {
	it("queues a persona-neutral scene task and carries the global persona id", async () => {
		const globals = makeDefaultGlobalConfig();
		const queue = new AstrBotAiRequestQueue();
		const bridge = new AstrBotAiBridge({
			providerId: "provider-1",
			personaId: "凛子",
			queue,
		});

		const result = bridge.comment("UP 发布了一条动态", "dynamic", [
			"https://example.invalid/a.png",
		]);
		const [request] = queue.claim({ now: 1_000 });

		expect(request).toMatchObject({
			providerId: "provider-1",
			personaId: "凛子",
			prompt: "UP 发布了一条动态",
			imageUrls: ["https://example.invalid/a.png"],
			attempt: 1,
			leasedUntil: new Date(121_000).toISOString(),
		});
		// systemPrompt = 人格中立的场景任务指令(人格声线交给 AstrBot persona_manager,不在此拼)
		expect(request?.systemPrompt).toBe(SCENE_TASK_PROMPTS.dynamic);
		// 不再泄漏 bilibili-notify 自己的人格文本 / 任务模板
		expect(request?.systemPrompt).not.toContain(globals.defaults.ai.persona.name);
		expect(request?.systemPrompt).not.toContain(globals.defaults.ai.dynamicPrompt);
		// Q4:model / temperature 交给 AstrBot provider,请求不再携带
		expect(request).not.toHaveProperty("model");
		expect(request).not.toHaveProperty("temperature");

		queue.respond(request?.requestId ?? "", "AI 点评");
		await expect(result).resolves.toBe("AI 点评");
	});

	it("lets a per-UP override.personaId win over the global persona id and switches scene task", () => {
		const queue = new AstrBotAiRequestQueue();
		const bridge = new AstrBotAiBridge({
			providerId: "provider-1",
			personaId: "global-persona",
			queue,
		});

		bridge.comment("一场直播", "liveSummary", undefined, { personaId: "per-up-persona" });
		const [request] = queue.claim();

		expect(request?.personaId).toBe("per-up-persona");
		expect(request?.systemPrompt).toBe(SCENE_TASK_PROMPTS.liveSummary);
	});

	it("leaves persona id unset when neither global nor per-UP supplies one", () => {
		const queue = new AstrBotAiRequestQueue();
		const bridge = new AstrBotAiBridge({ queue });

		bridge.comment("内容", "dynamic");
		const [request] = queue.claim();

		// undefined → Python 兜底到 AstrBot 当前默认人格
		expect(request?.personaId).toBeUndefined();
	});

	it("redacts provider failures before rejecting pending comments", async () => {
		const queue = new AstrBotAiRequestQueue();
		const result = queue.request({
			systemPrompt: "system",
			prompt: "prompt",
		});
		const [request] = queue.claim({ now: 1_000 });

		const receipt = queue.fail(request?.requestId ?? "", "Bearer secret-token");

		expect(receipt).toMatchObject({ ok: false, err: "Bearer [REDACTED]" });
		await expect(result).rejects.toThrow("Bearer [REDACTED]");
	});
});
