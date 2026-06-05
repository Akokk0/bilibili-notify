import { join } from "node:path";
import { BilibiliAPI, LoginFlow, type LoginSnapshot } from "@bilibili-notify/api";
import {
	makeDefaultGlobalConfig,
	type NotificationPayload,
	type Subscription,
} from "@bilibili-notify/internal";
import { BilibiliPush } from "@bilibili-notify/push";
import { StorageManager } from "@bilibili-notify/storage";
import { createSubscriptionStore, type SubscriptionStore } from "@bilibili-notify/subscription";
import { createCallbackSink } from "./callback-sink.js";
import { createSidecarEngines, type SidecarEnginesRuntime } from "./engines.js";
import { type EventQueueSnapshot, type SidecarEvent, SidecarEventQueue } from "./event-queue.js";
import {
	createAstrBotSubscription,
	JsonSubscriptionPersistence,
	normalizeAstrBotSubscription,
	type StoredSubscriptionInput,
	type SubscriptionStoreSnapshot,
} from "./persistence.js";
import {
	createSidecarMessageBus,
	createSidecarServiceContext,
	type SidecarLogLevel,
	type SidecarServiceContext,
} from "./platform.js";

export interface BusinessRuntimeOptions {
	readonly dataDir: string;
	readonly logLevel?: SidecarLogLevel;
	readonly userAgent?: string;
	readonly cookieEncryptionKey?: string;
	readonly events?: SidecarEventQueue;
}

export interface BusinessRuntimeSnapshot {
	readonly started: boolean;
	readonly authStarted: boolean;
	readonly engines: {
		readonly dynamic: boolean;
		readonly live: boolean;
	};
	readonly subscriptions: SubscriptionStoreSnapshot;
	readonly events: EventQueueSnapshot;
	readonly login?: LoginSnapshot;
}

export interface BusinessRuntimeHandle {
	readonly dataDir: string;
	readonly serviceCtx: SidecarServiceContext;
	readonly subscriptions: SubscriptionStore;
	readonly events: SidecarEventQueue;
	start(signal?: AbortSignal): Promise<void>;
	close(reason?: string): Promise<void>;
	snapshot(): BusinessRuntimeSnapshot;
	ensureAuthStarted(): Promise<LoginSnapshot>;
	refreshLoginStatus(): Promise<LoginSnapshot>;
	beginLogin(): Promise<LoginSnapshot>;
	listSubscriptions(): Subscription[];
	upsertSubscription(input: StoredSubscriptionInput | Subscription): Promise<Subscription>;
	removeSubscription(id: string): Promise<Subscription | undefined>;
	drainEvents(afterId?: number): SidecarEvent[];
	pushTest(payload: NotificationPayload): Promise<void>;
}

export function createBusinessRuntime(options: BusinessRuntimeOptions): BusinessRuntimeHandle {
	return new DefaultBusinessRuntime(options);
}

class DefaultBusinessRuntime implements BusinessRuntimeHandle {
	readonly dataDir: string;
	readonly serviceCtx: SidecarServiceContext;
	readonly subscriptions: SubscriptionStore;
	readonly events: SidecarEventQueue;
	private readonly bus = createSidecarMessageBus();
	private readonly persistence: JsonSubscriptionPersistence;
	private readonly push: BilibiliPush;
	private readonly storage: StorageManager;
	private readonly userAgent: string | undefined;
	private api: BilibiliAPI | undefined;
	private loginFlow: LoginFlow | undefined;
	private engines: SidecarEnginesRuntime | undefined;
	private started = false;
	private closing = false;
	private authStartPromise: Promise<LoginSnapshot> | undefined;
	private closePromise: Promise<void> | undefined;

	constructor(options: BusinessRuntimeOptions) {
		this.dataDir = options.dataDir;
		this.userAgent = options.userAgent;
		this.events = options.events ?? new SidecarEventQueue();
		this.serviceCtx = createSidecarServiceContext({
			name: "astrbot-sidecar",
			level: options.logLevel ?? "info",
		});
		this.subscriptions = createSubscriptionStore(this.bus);
		this.persistence = new JsonSubscriptionPersistence(join(this.dataDir, "subscriptions.json"));
		this.storage = new StorageManager({
			serviceCtx: this.serviceCtx,
			dataDir: this.dataDir,
			encryptionKey: options.cookieEncryptionKey,
		});
		this.push = new BilibiliPush({
			sink: createCallbackSink({ events: this.events }),
			store: this.subscriptions,
			logger: this.serviceCtx.logger,
			serviceCtx: this.serviceCtx,
			defaults: () => makeDefaultGlobalConfig().defaults,
		});
		this.bus.on("engine-error", (source, message) => {
			this.events.push({ type: "engine-error", source, message });
		});
		this.bus.on("auth-lost", () => {
			this.events.push({ type: "auth-lost" });
		});
		this.bus.on("auth-restored", () => {
			this.events.push({ type: "auth-restored" });
		});
	}

	async start(signal?: AbortSignal): Promise<void> {
		await this.startBase(signal);
		throwIfAborted(signal);
		await this.ensureAuthStarted(signal);
		throwIfAborted(signal);
		if (this.closePromise) return;
		this.startEngines();
		this.serviceCtx.logger.info(
			`business runtime ready: dataDir=${this.dataDir} subscriptions=${this.subscriptions.list().length}`,
		);
	}

	async close(reason = "shutdown"): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closing = true;
		this.started = false;
		this.closePromise = (async () => {
			this.serviceCtx.logger.info(`business runtime closing: ${reason}`);
			this.engines?.dispose();
			this.engines = undefined;
			this.push.stop();
			this.loginFlow?.stop();
			this.api?.stop();
			await this.serviceCtx.dispose();
			this.started = false;
		})();
		return this.closePromise;
	}

	snapshot(): BusinessRuntimeSnapshot {
		return {
			started: this.started,
			authStarted: Boolean(this.loginFlow),
			engines: this.engines?.status() ?? { dynamic: false, live: false },
			subscriptions: this.persistence.snapshot(this.subscriptions.list().length),
			events: this.events.snapshot(),
			login: this.loginFlow?.current(),
		};
	}

	async ensureAuthStarted(signal?: AbortSignal): Promise<LoginSnapshot> {
		this.throwIfClosing();
		await this.startBase(signal);
		throwIfAborted(signal);
		this.throwIfClosing();
		if (this.loginFlow) return this.loginFlow.current();
		if (this.authStartPromise) return this.authStartPromise;
		this.authStartPromise = this.startAuthSystem(signal)
			.then((snapshot) => {
				if (this.closing || this.closePromise || !this.started) return snapshot;
				this.startEngines();
				return snapshot;
			})
			.finally(() => {
				this.authStartPromise = undefined;
			});
		return this.authStartPromise;
	}

	async refreshLoginStatus(): Promise<LoginSnapshot> {
		await this.ensureAuthStarted();
		const flow = this.requireLoginFlow();
		await flow.reportAccountInfo();
		return flow.current();
	}

	async beginLogin(): Promise<LoginSnapshot> {
		await this.ensureAuthStarted();
		const flow = this.requireLoginFlow();
		await flow.beginLogin();
		return flow.current();
	}

	listSubscriptions(): Subscription[] {
		return this.subscriptions.list();
	}

	async upsertSubscription(input: StoredSubscriptionInput | Subscription): Promise<Subscription> {
		const sub = normalizeAstrBotSubscription(
			isFullSubscription(input) ? input : createAstrBotSubscription(input),
		);
		this.subscriptions.upsert(sub);
		await this.persistence.save(this.subscriptions.list());
		return sub;
	}

	async removeSubscription(id: string): Promise<Subscription | undefined> {
		const removed = this.subscriptions.removeById(id);
		if (removed) await this.persistence.save(this.subscriptions.list());
		return removed;
	}

	drainEvents(afterId = 0): SidecarEvent[] {
		return this.events.drain(afterId);
	}

	async pushTest(payload: NotificationPayload): Promise<void> {
		await this.push.sendPrivateMsg(payload.kind === "text" ? payload.text : "AstrBot sidecar test");
	}

	private async startBase(signal?: AbortSignal): Promise<void> {
		this.throwIfClosing();
		if (this.started) return;
		await this.storage.init();
		throwIfAborted(signal);
		this.throwIfClosing();
		const loaded = await this.persistence.load();
		this.subscriptions.replaceAll(loaded.map(normalizeAstrBotSubscription));
		throwIfAborted(signal);
		this.throwIfClosing();
		this.push.start();
		this.started = true;
	}

	private startEngines(): void {
		if (this.engines || !this.api || this.closing || this.closePromise || !this.started) return;
		this.engines = createSidecarEngines({
			serviceCtx: this.serviceCtx,
			bus: this.bus,
			api: this.api,
			push: this.push,
			subscriptions: this.subscriptions,
		});
		this.engines.start();
	}

	private async startAuthSystem(signal?: AbortSignal): Promise<LoginSnapshot> {
		this.serviceCtx.logger.info("starting bilibili auth runtime");
		let api: BilibiliAPI | undefined;
		let flow: LoginFlow | undefined;
		try {
			this.throwIfClosing();
			api = new BilibiliAPI({
				serviceCtx: this.serviceCtx,
				config: { userAgent: this.userAgent },
				callbacks: {
					onCookiesRefreshed: async (data) => {
						await this.storage.cookieStore.save(data);
						this.bus.emit("cookies-refreshed", data);
					},
					onAuthLost: () => {
						void flow?.handleAuthLost();
					},
				},
			});
			await api.start();
			throwIfAborted(signal);
			this.throwIfClosing();
			this.api = api;
			const storedCookies = await this.storage.cookieStore.load();
			throwIfAborted(signal);
			this.throwIfClosing();
			if (storedCookies) {
				await api.loadCookies(storedCookies);
			}
			throwIfAborted(signal);
			this.throwIfClosing();
			flow = new LoginFlow({
				serviceCtx: this.serviceCtx,
				api,
				bus: this.bus,
				healthCheckMs: 30 * 60_000,
				saveCookies: (data) => this.storage.cookieStore.save(data),
			});
			this.loginFlow = flow;
			await flow.start();
			throwIfAborted(signal);
			this.throwIfClosing();
			await flow.reportAccountInfo();
			throwIfAborted(signal);
			this.throwIfClosing();
			return flow.current();
		} catch (error) {
			if (this.loginFlow === flow) this.loginFlow = undefined;
			if (this.api === api) this.api = undefined;
			try {
				flow?.stop();
			} catch (stopError) {
				this.serviceCtx.logger.warn(`[astrbot] login flow cleanup failed: ${String(stopError)}`);
			}
			try {
				api?.stop();
			} catch (stopError) {
				this.serviceCtx.logger.warn(`[astrbot] api cleanup failed: ${String(stopError)}`);
			}
			throw error;
		}
	}

	private throwIfClosing(): void {
		if (this.closing) throwAbortError("business runtime closing");
	}

	private requireLoginFlow(): LoginFlow {
		if (!this.loginFlow) throw new Error("login flow is not started");
		return this.loginFlow;
	}
}

function isFullSubscription(value: StoredSubscriptionInput | Subscription): value is Subscription {
	return "routing" in value && "overrides" in value && "atAll" in value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		const reason = signal.reason;
		throwAbortError(
			typeof reason === "string" && reason.length > 0 ? reason : "business runtime aborted",
		);
	}
}

function throwAbortError(message: string): never {
	const error = new Error(message);
	error.name = "AbortError";
	throw error;
}
