import { describe, expect, it } from "vite-plus/test";
import { createSourceRegistry } from "../registry.js";
import { createSourceStatusReader } from "../source-status.js";
import { makeIntegration, makeSource, SOURCE_KEY } from "./fixtures.js";

const registerOn = async (registry: ReturnType<typeof createSourceRegistry>) =>
	// biome-ignore lint/suspicious/noExplicitAny: 只需要登记,上下文不被读
	registry.register(SOURCE_KEY, makeSource(), makeIntegration() as any);

describe("createSourceStatusReader", () => {
	it("登了 → 在跑;撤了 → 不在跑", async () => {
		const sources = createSourceRegistry();
		const reader = createSourceStatusReader({ sources });
		expect(reader.running(SOURCE_KEY)).toBe(false);
		const handle = await registerOn(sources);
		expect(reader.running(SOURCE_KEY)).toBe(true);
		handle.dispose();
		expect(reader.running(SOURCE_KEY)).toBe(false);
	});

	it("没登记的拓展键 → 不在跑", () => {
		const reader = createSourceStatusReader({ sources: createSourceRegistry() });
		expect(reader.running("ext-a")).toBe(false);
	});
});
