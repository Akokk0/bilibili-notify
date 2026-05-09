import type { MessageBus } from "@bilibili-notify/internal";
import type { BootstrapConfig } from "../config/schema.js";
import { type ConfigStore, createConfigStore } from "../config/store.js";
import { createHistoryStore, type HistoryStore } from "../history/store.js";
import type { EnginesRuntime } from "./engines.js";
import { createNodeMessageBus } from "./message-bus.js";
import { createNodeServiceContext, type NodeServiceContext } from "./service-context.js";

export interface AppRuntime {
	bootstrap: BootstrapConfig;
	serviceCtx: NodeServiceContext;
	bus: MessageBus;
	configStore: ConfigStore;
	historyStore: HistoryStore;
	/**
	 * Engine layer: BilibiliPush + DynamicEngine + LiveEngine + Sink.
	 *
	 * `null` until {@link attachEngines} is called. The auth system has to come
	 * up first (engines need a started BilibiliAPI), so the bootstrap split is:
	 *
	 *   1. createAppRuntime(bootstrap) — produces ConfigStore + HistoryStore
	 *   2. configStore.load()
	 *   3. createAuthSystem(...) — produces BilibiliAPI
	 *   4. attachEngines(runtime, { api, adapters }) — fills `engines`
	 *   5. createApp(runtime, ...) — mounts routes
	 */
	engines: EnginesRuntime | null;
	attachEngines(engines: EnginesRuntime): void;
	/** Tear down everything (timers, onDispose hooks). Idempotent. */
	dispose(): Promise<void>;
}

/**
 * Glues a parsed bootstrap config + a fresh NodeServiceContext + NodeMessageBus + ConfigStore
 * into a single object. Higher layers (Hono routes, engines, sinks) consume this.
 *
 * Stage 2.1 keeps this minimal — no engines, no API client, no sink. Those wire in stage 2.2+.
 */
export function createAppRuntime(bootstrap: BootstrapConfig): AppRuntime {
	const serviceCtx = createNodeServiceContext({
		name: "bilibili-notify",
		level: bootstrap.logLevel,
	});
	const bus = createNodeMessageBus();
	const configStore = createConfigStore({ bootstrap, bus, serviceCtx });
	const historyStore = createHistoryStore({
		dataDir: bootstrap.dataDir,
		bus,
		logger: serviceCtx.logger,
	});

	let engines: EnginesRuntime | null = null;

	return {
		bootstrap,
		serviceCtx,
		bus,
		configStore,
		historyStore,
		get engines() {
			return engines;
		},
		attachEngines(next: EnginesRuntime) {
			engines = next;
		},
		dispose: () => serviceCtx.dispose(),
	};
}
