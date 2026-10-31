import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlatformAdapter } from "@bilibili-notify/internal";
import { expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { ignoredProblems } from "../../__tests__/support/ignored-problems.js";
import { inertSettings } from "../../__tests__/support/inert-settings.js";
import { integrationIo } from "../../__tests__/support/integration-io.js";
import { memoryStores } from "../../__tests__/support/memory-key-value-store.js";
import { createAiToolProviderRegistry } from "../../ai/tool-provider-registry.js";
import { createConfigStore } from "../../config/store.js";
import { createLinkResolverRegistry } from "../../link-preview/registry.js";
import { createPlatformAdapterContext } from "../../push/adapter-context.js";
import { createPlatformAdapterRegistry } from "../../push/registry.js";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import { makeLogger, makeWorld } from "../../subscriptions/__tests__/fixtures.js";
import { createSourceContext } from "../../subscriptions/source-context.js";
import { createIntegrationContext } from "../context.js";
import { timezoneReaderOf } from "../timezone-reader.js";

it.each(["source", "adapter"] as const)(
	"%s真实上下文的async通知拒绝被接住,其他监听照常且设置保存成功",
	async (layer) => {
		const dataRoot = await mkdtemp(join(tmpdir(), "bn-timezone-layer-"));
		const logger = makeLogger();
		const bus = createNodeMessageBus();
		const store = createConfigStore({
			bootstrap: { server: { host: "127.0.0.1", port: 8787 }, dataDir: dataRoot, logLevel: "info" },
			dataRoot,
			bus,
			serviceCtx: {
				logger,
				signal: new AbortController().signal,
				setInterval: () => ({ dispose() {} }),
				setTimeout: () => ({ dispose() {} }),
				onDispose() {},
				track() {},
			},
			integrationSettings: [],
		});
		await store.load();
		await store.patchGlobals({ timezone: "UTC" });
		const parent = createIntegrationContext({
			...integrationIo(),
			...memoryStores(),
			timezoneReader: timezoneReaderOf(store),
			logger,
			stopReason: "test stopped",
			problems: ignoredProblems,
			reporter: "timezone-layer",
			label: () => "timezone-layer",
			rejectedProblemLevel: "error",
			redactValues() {},
			settings: inertSettings(),
		});
		const unhandled: unknown[] = [];
		const hearUnhandled = (error: unknown) => {
			unhandled.push(error);
		};
		process.on("unhandledRejection", hearUnhandled);
		let stop: () => void = () => {};
		try {
			const world = makeWorld([]);
			const source = createSourceContext({
				integration: parent.ctx,
				sourceKey: "timezone-layer",
				descriptor: { label: "timezone-layer", supportedFeatures: [] },
				subscriptions: world.store,
				defaults: () => store.getGlobals().defaults,
				bus,
				logger,
				enqueue() {},
				liveSignals() {},
				liveInteractions() {},
				profiles() {},
				problems: ignoredProblems,
				linkResolvers: createLinkResolverRegistry(),
				aiToolProviders: createAiToolProviderRegistry(),
			});
			const seen = vi.fn();
			const listen = (ctx: Pick<typeof parent.ctx, "onTimezoneChanged">) => {
				ctx.onTimezoneChanged(async () => {
					await Promise.resolve();
					throw new Error(`async timezone ${layer}`);
				});
				ctx.onTimezoneChanged(seen);
			};
			if (layer === "source") {
				listen(source.ctx);
				stop = () => source.dispose();
			} else {
				source.dispose();
				const adapterCtx = createPlatformAdapterContext({
					integration: parent.ctx,
					adapterKey: "timezone-layer",
					label: () => "timezone-layer",
					settingsSchema: z.object({}),
					connections: () => [],
					inbound: {},
					onConnectionsChanged: () => ({ dispose() {} }),
					problems: ignoredProblems,
					rejectedProblemLevel: "error",
				});
				const registration = await createPlatformAdapterRegistry().register(
					{
						adapterKey: "timezone-layer",
						settingsSchema: z.object({}),
						descriptor: () => ({ label: "timezone-layer", settingsFields: [] }),
						start: listen,
						stop() {},
						isAvailable: () => true,
						send: async () => ({ ok: true, latencyMs: 0 }),
					} as unknown as PlatformAdapter,
					adapterCtx,
				);
				stop = () => registration.dispose();
			}
			const saved = await store.patchGlobals({ timezone: "Asia/Kathmandu" });
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(saved.timezone).toBe("Asia/Kathmandu");
			expect(seen).toHaveBeenCalledTimes(1);
			expect(unhandled).toEqual([]);
			expect(logger.error.mock.calls.flat().join("\n")).toContain(`async timezone ${layer}`);
		} finally {
			process.off("unhandledRejection", hearUnhandled);
			stop();
			await parent.dispose();
			await rm(dataRoot, { recursive: true, force: true });
		}
	},
);
