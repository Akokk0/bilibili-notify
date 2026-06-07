import { makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { describe, expect, it } from "vitest";
import { AstrBotAiBridge, AstrBotAiRequestQueue } from "./ai-bridge.js";

describe("AstrBotAiBridge", () => {
	it("queues AI comments for the Python AstrBot Provider pump", async () => {
		const globals = makeDefaultGlobalConfig();
		const queue = new AstrBotAiRequestQueue();
		const bridge = new AstrBotAiBridge({
			providerId: "provider-1",
			getGlobals: () => globals,
			queue,
		});

		const result = bridge.comment("UP 发布了一条动态", "dynamic", [
			"https://example.invalid/a.png",
		]);
		const [request] = queue.claim({ now: 1_000 });

		expect(request).toMatchObject({
			providerId: "provider-1",
			prompt: "UP 发布了一条动态",
			model: globals.defaults.ai.model,
			temperature: globals.defaults.ai.temperature,
			imageUrls: ["https://example.invalid/a.png"],
			attempt: 1,
			leasedUntil: new Date(121_000).toISOString(),
		});
		expect(request?.systemPrompt).toContain(globals.defaults.ai.dynamicPrompt);

		queue.respond(request?.requestId ?? "", "AI 点评");
		await expect(result).resolves.toBe("AI 点评");
	});

	it("redacts provider failures before rejecting pending comments", async () => {
		const queue = new AstrBotAiRequestQueue();
		const result = queue.request({
			systemPrompt: "system",
			prompt: "prompt",
			model: "model",
		});
		const [request] = queue.claim({ now: 1_000 });

		const receipt = queue.fail(request?.requestId ?? "", "Bearer secret-token");

		expect(receipt).toMatchObject({ ok: false, err: "Bearer [REDACTED]" });
		await expect(result).rejects.toThrow("Bearer [REDACTED]");
	});
});
