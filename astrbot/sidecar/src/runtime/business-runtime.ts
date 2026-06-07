import { BilibiliAPI, BiliLoginStatus, LoginFlow, type LoginSnapshot } from "@bilibili-notify/api";
import {
	type AstrBotAdapter,
	type AstrBotPushTarget,
	type DeliveryResult,
	type GlobalConfig,
	makeDefaultGlobalConfig,
	type NotificationPayload,
	type Subscription,
} from "@bilibili-notify/internal";
import { BilibiliPush } from "@bilibili-notify/push";
import { StorageManager } from "@bilibili-notify/storage";
import { createSubscriptionStore, type SubscriptionStore } from "@bilibili-notify/subscription";
import { ASTRBOT_PUSH_TARGET, ASTRBOT_TARGET_ID, createCallbackSink } from "./callback-sink.js";
import {
	type AstrBotConfigSnapshot,
	type AstrBotConfigStore,
	createAstrBotConfigStore,
} from "./config-store.js";
import { createSidecarEngines, type SidecarEnginesRuntime } from "./engines.js";
import { type EventQueueSnapshot, type SidecarEvent, SidecarEventQueue } from "./event-queue.js";
import { createAstrBotSubscription, type StoredSubscriptionInput } from "./persistence.js";
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
	readonly subscriptions: AstrBotConfigSnapshot["subscriptions"];
	readonly config: AstrBotConfigSnapshot;
	readonly events: EventQueueSnapshot;
	readonly login?: LoginSnapshot;
}

export interface UserLookupResult {
	readonly uid: string;
	readonly name: string;
	readonly avatar: string;
	readonly sign: string;
	readonly fans: number;
}

export interface UserSearchResult {
	readonly results: UserLookupResult[];
	readonly page: number;
	readonly pageSize: number;
	readonly total: number;
}

export class SidecarUpstreamError extends Error {
	readonly statusCode: number;
	readonly error: "api_not_ready" | "not_found" | "upstream_failed";
	readonly upstreamCode?: number;

	constructor(
		statusCode: number,
		error: SidecarUpstreamError["error"],
		message: string,
		upstreamCode?: number,
	) {
		super(message);
		this.name = "SidecarUpstreamError";
		this.statusCode = statusCode;
		this.error = error;
		this.upstreamCode = upstreamCode;
	}
}

export interface BusinessRuntimeHandle {
	readonly dataDir: string;
	readonly serviceCtx: SidecarServiceContext;
	readonly configStore: AstrBotConfigStore;
	readonly subscriptions: SubscriptionStore;
	readonly events: SidecarEventQueue;
	start(signal?: AbortSignal): Promise<void>;
	close(reason?: string): Promise<void>;
	snapshot(): BusinessRuntimeSnapshot;
	ensureAuthStarted(): Promise<LoginSnapshot>;
	refreshLoginStatus(): Promise<LoginSnapshot>;
	beginLogin(): Promise<LoginSnapshot>;
	logout(): Promise<LoginSnapshot>;
	getGlobals(): GlobalConfig;
	setGlobals(next: GlobalConfig): Promise<GlobalConfig>;
	resetGlobals(): Promise<GlobalConfig>;
	listSubscriptions(): Subscription[];
	listAdapters(): AstrBotAdapter[];
	listTargets(): AstrBotPushTarget[];
	upsertSubscription(input: StoredSubscriptionInput | Subscription): Promise<Subscription>;
	patchSubscription(id: string, patch: Record<string, unknown>): Promise<Subscription>;
	removeSubscription(id: string): Promise<Subscription | undefined>;
	upsertTarget(target: AstrBotPushTarget): Promise<AstrBotPushTarget>;
	patchTarget(id: string, patch: Record<string, unknown>): Promise<AstrBotPushTarget>;
	removeTarget(id: string): Promise<AstrBotPushTarget | undefined>;
	clearSubscriptions(): Promise<Subscription[]>;
	clearTargets(): Promise<AstrBotPushTarget[]>;
	clearSubscriptionOverrides(): Promise<Subscription[]>;
	lookupUser(uid: string): Promise<UserLookupResult>;
	searchUsers(query: string, page?: number): Promise<UserSearchResult>;
	drainEvents(afterId?: number): SidecarEvent[];
	pushTest(targetId: string, payload: NotificationPayload): Promise<DeliveryResult>;
}

export function createBusinessRuntime(options: BusinessRuntimeOptions): BusinessRuntimeHandle {
	return new DefaultBusinessRuntime(options);
}

class DefaultBusinessRuntime implements BusinessRuntimeHandle {
	readonly dataDir: string;
	readonly serviceCtx: SidecarServiceContext;
	readonly configStore: AstrBotConfigStore;
	readonly subscriptions: SubscriptionStore;
	readonly events: SidecarEventQueue;
	private readonly bus = createSidecarMessageBus();
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
		this.configStore = createAstrBotConfigStore({ dataDir: this.dataDir, bus: this.bus });
		this.subscriptions = createSubscriptionStore(this.bus);
		this.storage = new StorageManager({
			serviceCtx: this.serviceCtx,
			dataDir: this.dataDir,
			encryptionKey: options.cookieEncryptionKey,
		});
		this.push = new BilibiliPush({
			sink: createCallbackSink({
				events: this.events,
				targets: () => {
					const targets = this.configStore.getTargets();
					return targets.length > 0 ? targets : [ASTRBOT_PUSH_TARGET];
				},
			}),
			store: this.subscriptions,
			logger: this.serviceCtx.logger,
			serviceCtx: this.serviceCtx,
			defaults: () => this.configStore.getGlobals().defaults,
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
		const config = this.configStore.snapshot();
		return {
			started: this.started,
			authStarted: Boolean(this.loginFlow),
			engines: this.engines?.status() ?? { dynamic: false, live: false },
			subscriptions: config.subscriptions,
			config,
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

	async logout(): Promise<LoginSnapshot> {
		await this.startBase();
		await this.storage.cookieStore.clear();
		await this.api?.clearCookies();
		this.loginFlow?.reportLoggedOut("notLogin");
		return (
			this.loginFlow?.current() ?? {
				status: BiliLoginStatus.NOT_LOGIN,
				msg: "账号未登录，请点击「扫码登录」",
			}
		);
	}

	getGlobals(): GlobalConfig {
		return this.configStore.getGlobals();
	}

	async setGlobals(next: GlobalConfig): Promise<GlobalConfig> {
		const saved = await this.configStore.setGlobals(next);
		this.applyGlobals(saved);
		return saved;
	}

	async resetGlobals(): Promise<GlobalConfig> {
		return this.setGlobals(makeDefaultGlobalConfig());
	}

	listSubscriptions(): Subscription[] {
		return this.subscriptions.list();
	}

	listAdapters(): AstrBotAdapter[] {
		return this.configStore.getAdapters();
	}

	listTargets(): AstrBotPushTarget[] {
		return this.configStore.getTargets();
	}

	async upsertSubscription(input: StoredSubscriptionInput | Subscription): Promise<Subscription> {
		const sub = isFullSubscription(input) ? input : createAstrBotSubscription(input);
		const saved = await this.configStore.upsertSubscription(sub);
		this.subscriptions.upsert(saved);
		return saved;
	}

	async patchSubscription(id: string, patch: Record<string, unknown>): Promise<Subscription> {
		const current = this.subscriptions.list().find((entry) => entry.id === id);
		if (!current) throw new Error(`subscription not found: ${id}`);
		return this.upsertSubscription({ ...(deepMerge(current, patch) as Subscription), id });
	}

	async removeSubscription(id: string): Promise<Subscription | undefined> {
		const removed = await this.configStore.deleteSubscription(id);
		if (removed) this.subscriptions.removeById(id);
		return removed;
	}

	async upsertTarget(target: AstrBotPushTarget): Promise<AstrBotPushTarget> {
		return this.configStore.upsertTarget(target);
	}

	async patchTarget(id: string, patch: Record<string, unknown>): Promise<AstrBotPushTarget> {
		const current = this.configStore.getTargets().find((entry) => entry.id === id);
		if (!current) throw new Error(`target not found: ${id}`);
		return this.upsertTarget({ ...(deepMerge(current, patch) as AstrBotPushTarget), id });
	}

	async removeTarget(id: string): Promise<AstrBotPushTarget | undefined> {
		return this.configStore.deleteTarget(id);
	}

	async clearSubscriptions(): Promise<Subscription[]> {
		for (const sub of this.configStore.getSubscriptions()) {
			await this.configStore.deleteSubscription(sub.id);
			this.subscriptions.removeById(sub.id);
		}
		return this.listSubscriptions();
	}

	async clearTargets(): Promise<AstrBotPushTarget[]> {
		for (const target of this.configStore.getTargets()) {
			await this.configStore.deleteTarget(target.id);
		}
		return this.listTargets();
	}

	async clearSubscriptionOverrides(): Promise<Subscription[]> {
		for (const sub of this.subscriptions.list()) {
			await this.upsertSubscription({
				...sub,
				atAll: { dynamic: {}, live: {} },
				overrides: {},
				specialUsers: [],
			});
		}
		return this.listSubscriptions();
	}

	async lookupUser(uid: string): Promise<UserLookupResult> {
		await this.ensureAuthStarted();
		const api = this.requireApi();
		const res = await api.getUserCardInfo(uid);
		if (res.code !== 0 || !res.data?.card) {
			throw new SidecarUpstreamError(
				404,
				"not_found",
				(res as { message?: string }).message ?? "未找到该 UP 主",
				res.code,
			);
		}
		return userCardToLookupResult(res.data.card);
	}

	async searchUsers(query: string, page = 1): Promise<UserSearchResult> {
		await this.ensureAuthStarted();
		const api = this.requireApi();
		const safePage = Number.isFinite(page) && page >= 1 ? Math.min(Math.floor(page), 200) : 1;
		const res = (await api.searchByType("bili_user", query, {
			page: safePage,
			pageSize: 5,
		})) as {
			code?: number;
			message?: string;
			data?: { result?: unknown[]; numResults?: number } | null;
		};
		if (!res || res.code !== 0) {
			throw new SidecarUpstreamError(502, "upstream_failed", res?.message ?? "搜索失败", res?.code);
		}
		const raw = Array.isArray(res.data?.result) ? res.data.result : [];
		const results = raw.slice(0, 5).map(searchResultToLookupResult);
		return {
			results,
			page: safePage,
			pageSize: 5,
			total: typeof res.data?.numResults === "number" ? res.data.numResults : results.length,
		};
	}

	drainEvents(afterId = 0): SidecarEvent[] {
		return this.events.drain(afterId);
	}

	async pushTest(targetId: string, payload: NotificationPayload): Promise<DeliveryResult> {
		const storedTarget = this.configStore.getTargets().find((target) => target.id === targetId);
		const target =
			storedTarget ?? (targetId === ASTRBOT_TARGET_ID ? ASTRBOT_PUSH_TARGET : undefined);
		if (!target) return { ok: false, latencyMs: 0, err: "target not found" };
		if (!target.enabled) return { ok: false, latencyMs: 0, err: "target disabled" };
		const result = await this.push.sendToTarget(target.id, payload);
		if (storedTarget) {
			await this.configStore.upsertTarget({
				...storedTarget,
				testStatus: {
					ok: result.ok,
					lastCheckedAt: new Date().toISOString(),
					latencyMs: result.latencyMs,
					err: result.err,
				},
			});
		}
		return result;
	}

	private async startBase(signal?: AbortSignal): Promise<void> {
		this.throwIfClosing();
		if (this.started) return;
		await this.storage.init();
		throwIfAborted(signal);
		this.throwIfClosing();
		await this.configStore.load();
		this.applyGlobals(this.configStore.getGlobals());
		this.subscriptions.replaceAll(this.configStore.getSubscriptions());
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
			getGlobals: () => this.configStore.getGlobals(),
		});
		this.engines.start();
	}

	private async startAuthSystem(signal?: AbortSignal): Promise<LoginSnapshot> {
		this.serviceCtx.logger.info("starting bilibili auth runtime");
		let api: BilibiliAPI | undefined;
		let flow: LoginFlow | undefined;
		try {
			this.throwIfClosing();
			const globals = this.configStore.getGlobals();
			api = new BilibiliAPI({
				serviceCtx: this.serviceCtx,
				config: { userAgent: globals.app.userAgent ?? this.userAgent },
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
				healthCheckMs: globals.app.healthCheckMinutes * 60_000,
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

	private applyGlobals(globals: GlobalConfig): void {
		this.serviceCtx.setLevel(globals.app.logLevel);
		this.api?.setUserAgent(globals.app.userAgent ?? this.userAgent);
		this.loginFlow?.setHealthCheckMs(globals.app.healthCheckMinutes * 60_000);
		this.engines?.updateGlobals(globals);
	}

	private throwIfClosing(): void {
		if (this.closing) throwAbortError("business runtime closing");
	}

	private requireApi(): BilibiliAPI {
		if (!this.api) {
			throw new SidecarUpstreamError(503, "api_not_ready", "B 站 API 尚未就绪");
		}
		return this.api;
	}

	private requireLoginFlow(): LoginFlow {
		if (!this.loginFlow) throw new Error("login flow is not started");
		return this.loginFlow;
	}
}

function isFullSubscription(value: StoredSubscriptionInput | Subscription): value is Subscription {
	return "routing" in value && "overrides" in value && "atAll" in value;
}

function deepMerge(base: unknown, patch: unknown): unknown {
	if (!isPlainRecord(base) || !isPlainRecord(patch)) return patch;
	const out: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) continue;
		if (value === null) {
			delete out[key];
			continue;
		}
		out[key] = deepMerge(out[key], value);
	}
	return out;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function userCardToLookupResult(card: {
	mid?: unknown;
	name?: unknown;
	face?: unknown;
	sign?: unknown;
	fans?: unknown;
}): UserLookupResult {
	return {
		uid: String(card.mid ?? ""),
		name: typeof card.name === "string" ? card.name : String(card.mid ?? ""),
		avatar: typeof card.face === "string" ? card.face : "",
		sign: typeof card.sign === "string" ? card.sign : "",
		fans: typeof card.fans === "number" && card.fans >= 0 ? card.fans : 0,
	};
}

function searchResultToLookupResult(entry: unknown): UserLookupResult {
	const value = isPlainRecord(entry) ? entry : {};
	return {
		uid: String(value.mid ?? ""),
		name: stripHtmlTags(String(value.uname ?? "")),
		avatar: normaliseAvatarUrl(value.upic),
		sign: typeof value.usign === "string" ? value.usign : "",
		fans: typeof value.fans === "number" && value.fans >= 0 ? value.fans : 0,
	};
}

function stripHtmlTags(value: string): string {
	return value.replace(/<[^>]+>/g, "");
}

function normaliseAvatarUrl(raw: unknown): string {
	if (typeof raw !== "string" || !raw) return "";
	if (raw.startsWith("//")) return `https:${raw}`;
	return raw;
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
