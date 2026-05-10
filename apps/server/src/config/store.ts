import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	type ConfigScope,
	type Disposable,
	type GlobalConfig,
	GlobalConfigSchema,
	type MessageBus,
	makeDefaultGlobalConfig,
	type PushTarget,
	PushTargetSchema,
	type ServiceContext,
	type Subscription,
	SubscriptionSchema,
} from "@bilibili-notify/internal";
import type { BootstrapConfig } from "./schema.js";

/**
 * ConfigStore — central runtime config holder for the standalone end.
 *
 * Stage 2.2: implements the runtime-write layer for globals / subscriptions /
 * targets, persisted as JSON under `<dataDir>/state/` with atomic-rename writes.
 * Every successful write emits `'config-changed'` on the MessageBus carrying the
 * affected scope. A per-scope FIFO queue serializes concurrent writes so two
 * PATCHes on the same scope can never interleave their read-modify-write pair.
 *
 * TODO (stage 2.3+): the secrets layer (cookie / WBI / AI apiKey AES-GCM under
 * `<dataDir>/secrets/*.enc`) is intentionally NOT implemented here. Cookie storage
 * for now stays inside `@bilibili-notify/storage` keyed off `bootstrap.cookieEncryptionKey`.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Recursive partial. We use this for `patchGlobals` so callers can send a
 * deeply-nested subset of GlobalConfig and we merge it onto the current state.
 */
export type DeepPartial<T> =
	T extends Array<infer _U> ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

/** Per-scope metadata exposed via `/api/health/details`. */
export interface ConfigScopeMeta {
	exists: boolean;
	lastUpdatedAt: string | null;
}

export interface ConfigStore {
	readonly bootstrap: BootstrapConfig;

	/** Subscribe to scope-level change notifications. Backed by MessageBus 'config-changed'. */
	onChange(handler: (scope: ConfigScope) => void): Disposable;

	// --- lifecycle --------------------------------------------------------
	load(): Promise<void>;

	// --- reads ------------------------------------------------------------
	getGlobals(): GlobalConfig;
	getSubscriptions(): Subscription[];
	getTargets(): PushTarget[];

	getGlobalsMeta(): ConfigScopeMeta;
	getSubscriptionsMeta(): ConfigScopeMeta;
	getTargetsMeta(): ConfigScopeMeta;

	// --- writes -----------------------------------------------------------
	setGlobals(next: GlobalConfig): Promise<void>;
	patchGlobals(patch: DeepPartial<GlobalConfig>): Promise<GlobalConfig>;
	upsertSubscription(sub: Subscription): Promise<void>;
	patchSubscription(id: string, patch: DeepPartial<Subscription>): Promise<Subscription>;
	deleteSubscription(id: string): Promise<boolean>;
	upsertTarget(target: PushTarget): Promise<void>;
	patchTarget(id: string, patch: DeepPartial<PushTarget>): Promise<PushTarget>;
	deleteTarget(id: string): Promise<boolean>;
}

export interface CreateConfigStoreOptions {
	bootstrap: BootstrapConfig;
	bus: MessageBus;
	serviceCtx: ServiceContext;
	/** Where globals/subs/targets JSON files live. Defaults to `<bootstrap.dataDir>/state`. */
	stateDir?: string;
}

/** Thrown when an incoming write fails Zod validation. Routes catch and map to 400. */
export class ConfigValidationError extends Error {
	readonly scope: ConfigScope;
	readonly issues: unknown;
	constructor(scope: ConfigScope, issues: unknown, message?: string) {
		super(message ?? `config validation failed (scope=${scope})`);
		this.name = "ConfigValidationError";
		this.scope = scope;
		this.issues = issues;
	}
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ScopeMetaInternal {
	exists: boolean;
	lastUpdatedAt: string | null;
}

/** A FIFO queue per scope so concurrent writes to the same scope serialize. */
type Queue = Promise<unknown>;

function deepClone<T>(value: T): T {
	// structuredClone is in node 20+; falls back to JSON for stubborn shapes.
	if (typeof structuredClone === "function") return structuredClone(value);
	return JSON.parse(JSON.stringify(value)) as T;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Recursively merge `patch` onto `base`. Arrays in `patch` replace wholesale. */
function deepMerge<T>(base: T, patch: unknown): T {
	if (!isPlainObject(base) || !isPlainObject(patch)) {
		// scalar / array / mismatched: patch wins if defined, else base
		return (patch === undefined ? base : (patch as T)) as T;
	}
	const out: Record<string, unknown> = { ...base };
	for (const [k, v] of Object.entries(patch)) {
		if (v === undefined) continue;
		const prev = out[k];
		if (isPlainObject(prev) && isPlainObject(v)) {
			out[k] = deepMerge(prev, v);
		} else {
			out[k] = v;
		}
	}
	return out as T;
}

async function atomicWriteJson(absPath: string, value: unknown): Promise<void> {
	await mkdir(dirname(absPath), { recursive: true });
	const suffix = `${process.pid}.${randomBytes(6).toString("hex")}`;
	const tmp = `${absPath}.tmp.${suffix}`;
	const body = `${JSON.stringify(value, null, 2)}\n`;
	await writeFile(tmp, body, { encoding: "utf8" });
	await rename(tmp, absPath);
}

async function readJsonOrInit<T>(
	absPath: string,
	makeDefault: () => T,
): Promise<{ value: T; existed: boolean }> {
	try {
		const raw = await readFile(absPath, "utf8");
		return { value: JSON.parse(raw) as T, existed: true };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			const fresh = makeDefault();
			await atomicWriteJson(absPath, fresh);
			return { value: fresh, existed: false };
		}
		throw err;
	}
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class NodeConfigStore implements ConfigStore {
	readonly bootstrap: BootstrapConfig;
	private readonly bus: MessageBus;
	private readonly serviceCtx: ServiceContext;
	private readonly stateDir: string;

	private globals: GlobalConfig;
	private subscriptions: Subscription[];
	private targets: PushTarget[];

	private readonly meta: Record<ConfigScope, ScopeMetaInternal> = {
		globals: { exists: false, lastUpdatedAt: null },
		subscriptions: { exists: false, lastUpdatedAt: null },
		targets: { exists: false, lastUpdatedAt: null },
		secrets: { exists: false, lastUpdatedAt: null },
	};

	private readonly queues: Record<ConfigScope, Queue> = {
		globals: Promise.resolve(),
		subscriptions: Promise.resolve(),
		targets: Promise.resolve(),
		secrets: Promise.resolve(),
	};

	private loaded = false;

	constructor(opts: CreateConfigStoreOptions) {
		this.bootstrap = opts.bootstrap;
		this.bus = opts.bus;
		this.serviceCtx = opts.serviceCtx;
		this.stateDir = opts.stateDir ?? join(opts.bootstrap.dataDir, "state");
		// Initialize with safe defaults; `load()` overwrites.
		this.globals = makeDefaultGlobalConfig();
		this.subscriptions = [];
		this.targets = [];
	}

	private path(scope: ConfigScope): string {
		switch (scope) {
			case "globals":
				return join(this.stateDir, "globals.json");
			case "subscriptions":
				return join(this.stateDir, "subscriptions.json");
			case "targets":
				return join(this.stateDir, "targets.json");
			case "secrets":
				// reserved; not implemented in stage 2.2
				return join(this.stateDir, "secrets.json");
		}
	}

	// ---- lifecycle ------------------------------------------------------

	async load(): Promise<void> {
		if (this.loaded) return;
		await mkdir(this.stateDir, { recursive: true });

		// globals
		{
			const { value, existed } = await readJsonOrInit<unknown>(
				this.path("globals"),
				makeDefaultGlobalConfig,
			);
			const parsed = GlobalConfigSchema.safeParse(value);
			if (!parsed.success) {
				throw new ConfigValidationError(
					"globals",
					parsed.error.issues,
					`globals.json on disk failed schema validation`,
				);
			}
			this.globals = parsed.data;
			this.meta.globals.exists = true;
			this.meta.globals.lastUpdatedAt = existed ? null : new Date().toISOString();

			// Backfill default AI presets for globals files written before any
			// presets shipped (presets used to default to []). Only triggered
			// when the user has never configured presets — once they have at
			// least one entry we leave them alone, including subsequent
			// edits/deletions, so the user can fully manage the list.
			if (existed && this.globals.defaults.ai.presets.length === 0) {
				const fresh = makeDefaultGlobalConfig();
				if (fresh.defaults.ai.presets.length > 0) {
					this.globals = {
						...this.globals,
						defaults: {
							...this.globals.defaults,
							ai: {
								...this.globals.defaults.ai,
								presets: fresh.defaults.ai.presets,
							},
						},
					};
					await atomicWriteJson(this.path("globals"), this.globals);
					this.touch("globals");
				}
			}
		}

		// subscriptions
		{
			const { value, existed } = await readJsonOrInit<unknown[]>(
				this.path("subscriptions"),
				() => [] as Subscription[],
			);
			if (!Array.isArray(value)) {
				throw new ConfigValidationError(
					"subscriptions",
					{ message: "subscriptions.json must be an array" },
					"subscriptions.json on disk is not an array",
				);
			}
			const parsed: Subscription[] = [];
			for (const [idx, raw] of value.entries()) {
				const r = SubscriptionSchema.safeParse(raw);
				if (!r.success) {
					throw new ConfigValidationError(
						"subscriptions",
						{ index: idx, issues: r.error.issues },
						`subscriptions.json[${idx}] failed schema validation`,
					);
				}
				parsed.push(r.data);
			}
			this.subscriptions = parsed;
			this.meta.subscriptions.exists = true;
			this.meta.subscriptions.lastUpdatedAt = existed ? null : new Date().toISOString();
		}

		// targets
		{
			const { value, existed } = await readJsonOrInit<unknown[]>(
				this.path("targets"),
				() => [] as PushTarget[],
			);
			if (!Array.isArray(value)) {
				throw new ConfigValidationError(
					"targets",
					{ message: "targets.json must be an array" },
					"targets.json on disk is not an array",
				);
			}
			const parsed: PushTarget[] = [];
			for (const [idx, raw] of value.entries()) {
				const r = PushTargetSchema.safeParse(raw);
				if (!r.success) {
					throw new ConfigValidationError(
						"targets",
						{ index: idx, issues: r.error.issues },
						`targets.json[${idx}] failed schema validation`,
					);
				}
				parsed.push(r.data);
			}
			this.targets = parsed;
			this.meta.targets.exists = true;
			this.meta.targets.lastUpdatedAt = existed ? null : new Date().toISOString();
		}

		this.loaded = true;
		this.serviceCtx.logger.info(
			`config-store loaded (stateDir=${this.stateDir} subs=${this.subscriptions.length} targets=${this.targets.length})`,
		);
	}

	// ---- read accessors -------------------------------------------------

	onChange(handler: (scope: ConfigScope) => void): Disposable {
		return this.bus.on("config-changed", handler);
	}

	getGlobals(): GlobalConfig {
		return deepClone(this.globals);
	}

	getSubscriptions(): Subscription[] {
		return deepClone(this.subscriptions);
	}

	getTargets(): PushTarget[] {
		return deepClone(this.targets);
	}

	getGlobalsMeta(): ConfigScopeMeta {
		return { ...this.meta.globals };
	}

	getSubscriptionsMeta(): ConfigScopeMeta {
		return { ...this.meta.subscriptions };
	}

	getTargetsMeta(): ConfigScopeMeta {
		return { ...this.meta.targets };
	}

	// ---- write surface --------------------------------------------------

	async setGlobals(next: GlobalConfig): Promise<void> {
		await this.runScoped("globals", async () => {
			const parsed = GlobalConfigSchema.safeParse(next);
			if (!parsed.success) {
				throw new ConfigValidationError("globals", parsed.error.issues);
			}
			await atomicWriteJson(this.path("globals"), parsed.data);
			this.globals = parsed.data;
			this.touch("globals");
		});
		this.bus.emit("config-changed", "globals");
	}

	async patchGlobals(patch: DeepPartial<GlobalConfig>): Promise<GlobalConfig> {
		const result = await this.runScoped("globals", async () => {
			const merged = deepMerge(this.globals, patch);
			const parsed = GlobalConfigSchema.safeParse(merged);
			if (!parsed.success) {
				throw new ConfigValidationError("globals", parsed.error.issues);
			}
			await atomicWriteJson(this.path("globals"), parsed.data);
			this.globals = parsed.data;
			this.touch("globals");
			return parsed.data;
		});
		this.bus.emit("config-changed", "globals");
		return deepClone(result);
	}

	async upsertSubscription(sub: Subscription): Promise<void> {
		await this.runScoped("subscriptions", async () => {
			const parsed = SubscriptionSchema.safeParse(sub);
			if (!parsed.success) {
				throw new ConfigValidationError("subscriptions", parsed.error.issues);
			}
			const next = upsertById(this.subscriptions, parsed.data);
			await atomicWriteJson(this.path("subscriptions"), next);
			this.subscriptions = next;
			this.touch("subscriptions");
		});
		this.bus.emit("config-changed", "subscriptions");
	}

	async patchSubscription(id: string, patch: DeepPartial<Subscription>): Promise<Subscription> {
		const result = await this.runScoped("subscriptions", async () => {
			const idx = this.subscriptions.findIndex((s) => s.id === id);
			if (idx < 0) {
				throw new ConfigValidationError(
					"subscriptions",
					{ id, message: "subscription not found" },
					`subscription ${id} not found`,
				);
			}
			const current = this.subscriptions[idx] as Subscription;
			const merged = deepMerge(current, { ...patch, id });
			const parsed = SubscriptionSchema.safeParse(merged);
			if (!parsed.success) {
				throw new ConfigValidationError("subscriptions", parsed.error.issues);
			}
			const next = [...this.subscriptions];
			next[idx] = parsed.data;
			await atomicWriteJson(this.path("subscriptions"), next);
			this.subscriptions = next;
			this.touch("subscriptions");
			return parsed.data;
		});
		this.bus.emit("config-changed", "subscriptions");
		return deepClone(result);
	}

	async deleteSubscription(id: string): Promise<boolean> {
		const removed = await this.runScoped("subscriptions", async () => {
			const idx = this.subscriptions.findIndex((s) => s.id === id);
			if (idx < 0) return false;
			const next = this.subscriptions.filter((_, i) => i !== idx);
			await atomicWriteJson(this.path("subscriptions"), next);
			this.subscriptions = next;
			this.touch("subscriptions");
			return true;
		});
		if (removed) this.bus.emit("config-changed", "subscriptions");
		return removed;
	}

	async upsertTarget(target: PushTarget): Promise<void> {
		await this.runScoped("targets", async () => {
			const parsed = PushTargetSchema.safeParse(target);
			if (!parsed.success) {
				throw new ConfigValidationError("targets", parsed.error.issues);
			}
			const next = upsertById(this.targets, parsed.data);
			await atomicWriteJson(this.path("targets"), next);
			this.targets = next;
			this.touch("targets");
		});
		this.bus.emit("config-changed", "targets");
	}

	async patchTarget(id: string, patch: DeepPartial<PushTarget>): Promise<PushTarget> {
		const result = await this.runScoped("targets", async () => {
			const idx = this.targets.findIndex((t) => t.id === id);
			if (idx < 0) {
				throw new ConfigValidationError(
					"targets",
					{ id, message: "target not found" },
					`target ${id} not found`,
				);
			}
			const current = this.targets[idx] as PushTarget;
			const merged = deepMerge(current, { ...patch, id });
			const parsed = PushTargetSchema.safeParse(merged);
			if (!parsed.success) {
				throw new ConfigValidationError("targets", parsed.error.issues);
			}
			const next = [...this.targets];
			next[idx] = parsed.data;
			await atomicWriteJson(this.path("targets"), next);
			this.targets = next;
			this.touch("targets");
			return parsed.data;
		});
		this.bus.emit("config-changed", "targets");
		return deepClone(result);
	}

	async deleteTarget(id: string): Promise<boolean> {
		const removed = await this.runScoped("targets", async () => {
			const idx = this.targets.findIndex((t) => t.id === id);
			if (idx < 0) return false;
			const next = this.targets.filter((_, i) => i !== idx);
			await atomicWriteJson(this.path("targets"), next);
			this.targets = next;
			this.touch("targets");
			return true;
		});
		if (removed) this.bus.emit("config-changed", "targets");
		return removed;
	}

	// ---- internals ------------------------------------------------------

	private touch(scope: ConfigScope): void {
		this.meta[scope].exists = true;
		this.meta[scope].lastUpdatedAt = new Date().toISOString();
	}

	/**
	 * Per-scope FIFO queue. We chain `task` onto `this.queues[scope]` so that
	 * concurrent writes on the same scope serialize. Different scopes proceed
	 * in parallel. Errors propagate to the caller without poisoning the queue.
	 */
	private runScoped<T>(scope: ConfigScope, task: () => Promise<T>): Promise<T> {
		const prev = this.queues[scope];
		const next = prev.then(task, task);
		// Keep the queue alive even if the task threw — swallow on the chain root.
		this.queues[scope] = next.catch(() => undefined);
		return next;
	}
}

function upsertById<T extends { id: string }>(arr: readonly T[], item: T): T[] {
	const idx = arr.findIndex((x) => x.id === item.id);
	if (idx < 0) return [...arr, item];
	const next = [...arr];
	next[idx] = item;
	return next;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createConfigStore(opts: CreateConfigStoreOptions): ConfigStore {
	return new NodeConfigStore(opts);
}
