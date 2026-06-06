import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	type ConfigScope,
	type Disposable,
	deterministicUuid,
	type GlobalConfig,
	GlobalConfigSchema,
	type MessageBus,
	makeDefaultGlobalConfig,
	type PushAdapter,
	PushAdapterSchema,
	type PushTarget,
	PushTargetSchema,
	type ServiceContext,
	type Subscription,
	SubscriptionSchema,
} from "@bilibili-notify/internal";
import type { BootstrapConfig } from "./schema.js";
import type { ConfigSecrets, SecretStore } from "./secret-store.js";

/**
 * ConfigStore — central runtime config holder for the standalone end.
 *
 * Stage 2.2: implements the runtime-write layer for globals / subscriptions /
 * targets, persisted as JSON under `<dataDir>/state/` with atomic-rename writes.
 * Every successful write emits `'config-changed'` on the MessageBus carrying the
 * affected scope. A per-scope FIFO queue serializes concurrent writes so two
 * PATCHes on the same scope can never interleave their read-modify-write pair.
 *
 * Secrets layer: when a `SecretStore` is injected, the AI apiKey is lifted out
 * of `globals.json` into `<dataDir>/secrets/config-secrets.enc` (AES-256-GCM via
 * the shared `KeyProvider`) on first `load()`; the on-disk globals are scrubbed
 * while `this.globals` keeps the real value so engines/routes see it unchanged.
 * Cookie/WBI secrets stay inside `@bilibili-notify/storage`, sharing the same
 * `KeyProvider` (one passphrase, one salt). With no `SecretStore` the legacy
 * plaintext-in-globals path is preserved for tests/back-compat.
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
	getAdapters(): PushAdapter[];
	getTargets(): PushTarget[];

	getGlobalsMeta(): ConfigScopeMeta;
	getSubscriptionsMeta(): ConfigScopeMeta;
	getAdaptersMeta(): ConfigScopeMeta;
	getTargetsMeta(): ConfigScopeMeta;

	// --- writes -----------------------------------------------------------
	setGlobals(next: GlobalConfig): Promise<void>;
	patchGlobals(patch: DeepPartial<GlobalConfig>): Promise<GlobalConfig>;
	upsertSubscription(sub: Subscription): Promise<void>;
	patchSubscription(id: string, patch: DeepPartial<Subscription>): Promise<Subscription>;
	deleteSubscription(id: string): Promise<boolean>;
	upsertAdapter(adapter: PushAdapter): Promise<void>;
	patchAdapter(id: string, patch: DeepPartial<PushAdapter>): Promise<PushAdapter>;
	deleteAdapter(id: string): Promise<boolean>;
	upsertTarget(target: PushTarget): Promise<void>;
	patchTarget(id: string, patch: DeepPartial<PushTarget>): Promise<PushTarget>;
	recordTargetTestStatus(id: string, status: PushTarget["testStatus"]): Promise<PushTarget>;
	deleteTarget(id: string): Promise<boolean>;
}

export interface CreateConfigStoreOptions {
	bootstrap: BootstrapConfig;
	bus: MessageBus;
	serviceCtx: ServiceContext;
	/** Where globals/subs/targets JSON files live. Defaults to `<bootstrap.dataDir>/state`. */
	stateDir?: string;
	/**
	 * Encrypted bag for secret fields (currently `defaults.ai.apiKey`). When
	 * given, the apiKey is moved out of plaintext `globals.json` into this store
	 * (and a one-time lift migrates an existing plaintext key). When omitted the
	 * legacy behaviour (apiKey stays in globals.json) is preserved — used by
	 * tests and any non-secret-aware caller.
	 */
	secretStore?: SecretStore;
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
	// SY1:显式 `null` = 清除该字段。`JSON.stringify` 会丢 `undefined`,前端
	// 无法用 undefined 经线表达"清空一个可选字段"(键直接消失,旧逻辑当作
	// 未改 → master.targetId / app.userAgent 等永远清不掉)。约定 null 表清除:
	// 标量位 → 回落 base 的缺省;对象键 → 删除该键(变回 undefined,Zod
	// `.optional()` 仍合法)。`undefined` 维持"本字段不改"。
	if (patch === null) return undefined as T;
	if (!isPlainObject(base) || !isPlainObject(patch)) {
		// scalar / array / mismatched: patch wins if defined, else base
		return (patch === undefined ? base : (patch as T)) as T;
	}
	const out: Record<string, unknown> = { ...base };
	for (const [k, v] of Object.entries(patch)) {
		if (v === undefined) continue;
		if (v === null) {
			delete out[k];
			continue;
		}
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

/**
 * Returns a deep clone of `g` with `defaults.ai.apiKey` removed — the form
 * persisted to `globals.json` when a SecretStore owns the apiKey. The live
 * in-memory `this.globals` keeps the real value (engines read it via
 * getGlobals); only the on-disk copy is stripped.
 */
function stripApiKeyForDisk(g: GlobalConfig): GlobalConfig {
	const clone = deepClone(g);
	if (clone.defaults?.ai && "apiKey" in clone.defaults.ai) {
		delete (clone.defaults.ai as { apiKey?: string }).apiKey;
	}
	return clone;
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

async function fileExists(absPath: string): Promise<boolean> {
	try {
		await readFile(absPath, "utf8");
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw err;
	}
}

/**
 * Splits the legacy `PushTarget` shape (config bundled connection + session)
 * into the new (PushAdapter, PushTarget) pair. Targets with the same platform
 * and connection params share an adapter so the user doesn't end up with N
 * identical NapCat connection entries after migrating N groups.
 */
interface LegacyPushTarget {
	id: string;
	name: string;
	platform: string;
	scope: "group" | "private" | "channel";
	enabled: boolean;
	config: Record<string, unknown>;
}

function migrateLegacyTargets(raw: unknown[]): {
	adapters: PushAdapter[];
	targets: PushTarget[];
} {
	const adapters: PushAdapter[] = [];
	const targets: PushTarget[] = [];
	// connection-key → adapterId, so duplicate connections collapse.
	const adapterIdByKey = new Map<string, string>();

	for (const item of raw) {
		const legacy = item as LegacyPushTarget;
		if (legacy.platform === "onebot") {
			const cfg = legacy.config as {
				baseUrl?: string;
				accessToken?: string;
				groupId?: string;
				userId?: string;
				protocolVersion?: "v11";
			};
			const baseUrl = cfg.baseUrl ?? "";
			const accessToken = cfg.accessToken ?? "";
			const key = `onebot|${baseUrl}|${accessToken}`;
			let adapterId = adapterIdByKey.get(key);
			if (!adapterId) {
				adapterId = randomUUID();
				adapterIdByKey.set(key, adapterId);
				adapters.push({
					id: adapterId,
					name: deriveAdapterName(legacy.name, baseUrl),
					enabled: true,
					platform: "onebot",
					config: {
						transport: "http",
						baseUrl,
						accessToken: accessToken || undefined,
						protocolVersion: cfg.protocolVersion ?? "v11",
						headers: {},
						timeoutMs: 15_000,
						retryTimes: 0,
						retryIntervalMs: 1_000,
					},
				});
			}
			targets.push({
				id: legacy.id,
				name: legacy.name,
				adapterId,
				platform: "onebot",
				scope: legacy.scope,
				enabled: legacy.enabled,
				session: { groupId: cfg.groupId, userId: cfg.userId },
			});
		} else if (legacy.platform === "webhook") {
			const cfg = legacy.config as {
				url?: string;
				secret?: string;
				headers?: Record<string, string>;
			};
			const url = cfg.url ?? "";
			const key = `webhook|${url}|${cfg.secret ?? ""}`;
			let adapterId = adapterIdByKey.get(key);
			if (!adapterId) {
				adapterId = randomUUID();
				adapterIdByKey.set(key, adapterId);
				adapters.push({
					id: adapterId,
					name: deriveAdapterName(legacy.name, url),
					enabled: true,
					platform: "webhook",
					config: {
						url,
						provider: "generic",
						secret: cfg.secret || undefined,
						headers: cfg.headers ?? {},
					},
				});
			}
			targets.push({
				id: legacy.id,
				name: legacy.name,
				adapterId,
				platform: "webhook",
				scope: legacy.scope,
				enabled: legacy.enabled,
				session: {},
			});
		} else if (legacy.platform === "web-dashboard") {
			// 旧版 legacy `config.dashboardUser` 已无路由意义(WS server 单用户,无 per-user
			// 过滤),迁移时直接丢弃,target session 留空对象。
			const key = "web-dashboard";
			let adapterId = adapterIdByKey.get(key);
			if (!adapterId) {
				adapterId = randomUUID();
				adapterIdByKey.set(key, adapterId);
				adapters.push({
					id: adapterId,
					name: "Dashboard 通知中心",
					enabled: true,
					platform: "web-dashboard",
					config: {},
				});
			}
			targets.push({
				id: legacy.id,
				name: legacy.name,
				adapterId,
				platform: "web-dashboard",
				scope: legacy.scope,
				enabled: legacy.enabled,
				session: {},
			});
		}
		// Unknown legacy platform — drop silently; the user will see the target
		// disappear and can re-create it under a supported platform.
	}

	return { adapters, targets };
}

function deriveAdapterName(targetName: string, addr: string): string {
	if (addr) {
		try {
			const u = new URL(addr);
			return `${targetName} · ${u.host}`;
		} catch {
			/* fall through */
		}
	}
	return targetName || "默认连接";
}

type WebhookAdapter = Extract<PushAdapter, { platform: "webhook" }>;

function managedWebhookTargetId(adapterId: string): string {
	return deterministicUuid(`push-target:webhook-adapter:${adapterId}`);
}

function makeManagedWebhookTarget(adapter: WebhookAdapter, existing?: PushTarget): PushTarget {
	return {
		id: existing?.id ?? managedWebhookTargetId(adapter.id),
		name: adapter.name || "Webhook",
		adapterId: adapter.id,
		platform: "webhook",
		scope: "channel",
		enabled: adapter.enabled,
		managedBy: "adapter",
		testStatus: existing?.testStatus,
		session: {},
	};
}

function syncManagedWebhookTarget(
	adapter: WebhookAdapter,
	targets: readonly PushTarget[],
): { next: PushTarget[]; changed: boolean; aliases: Map<string, string> } {
	const owned = targets.filter((t) => t.platform === "webhook" && t.adapterId === adapter.id);
	const existing = owned.find((t) => t.managedBy === "adapter") ?? owned[0];
	const desired = makeManagedWebhookTarget(adapter, existing);
	if (!existing) return { next: [...targets, desired], changed: true, aliases: new Map() };

	const aliases = new Map<string, string>();
	for (const target of owned) {
		if (target.id !== desired.id) aliases.set(target.id, desired.id);
	}
	const next = targets
		.filter((t) => !(t.platform === "webhook" && t.adapterId === adapter.id && t.id !== desired.id))
		.map((t) => (t.id === desired.id ? desired : t));
	const changed =
		aliases.size > 0 ||
		existing.name !== desired.name ||
		existing.adapterId !== desired.adapterId ||
		existing.platform !== desired.platform ||
		existing.scope !== desired.scope ||
		existing.enabled !== desired.enabled ||
		existing.managedBy !== desired.managedBy ||
		Object.keys(existing.session).length !== 0;
	return { next, changed, aliases };
}

function syncManagedWebhookTargets(
	adapters: readonly PushAdapter[],
	targets: readonly PushTarget[],
): { next: PushTarget[]; changed: boolean; aliases: Map<string, string> } {
	let next = [...targets];
	let changed = false;
	const aliases = new Map<string, string>();
	for (const adapter of adapters) {
		if (adapter.platform !== "webhook") continue;
		const r = syncManagedWebhookTarget(adapter, next);
		next = r.next;
		changed ||= r.changed;
		for (const [from, to] of r.aliases) aliases.set(from, to);
	}
	return { next, changed, aliases };
}

function removeTargetIdsFromSubscriptions(
	subscriptions: readonly Subscription[],
	targetIds: readonly string[],
): { next: Subscription[]; changed: boolean } {
	if (targetIds.length === 0) return { next: [...subscriptions], changed: false };
	const ids = new Set(targetIds);
	let changed = false;
	const next = subscriptions.map((sub) => {
		let subChanged = false;
		const routing = { ...sub.routing };
		for (const key of Object.keys(routing) as Array<keyof Subscription["routing"]>) {
			const before = routing[key];
			const after = before.filter((id) => !ids.has(id));
			if (after.length !== before.length) {
				routing[key] = after;
				subChanged = true;
			}
		}

		const atAll = {
			dynamic: { ...sub.atAll.dynamic },
			live: { ...sub.atAll.live },
		};
		for (const key of Object.keys(atAll.dynamic)) {
			if (ids.has(key)) {
				delete atAll.dynamic[key];
				subChanged = true;
			}
		}
		for (const key of Object.keys(atAll.live)) {
			if (ids.has(key)) {
				delete atAll.live[key];
				subChanged = true;
			}
		}
		if (!subChanged) return sub;
		changed = true;
		return { ...sub, routing, atAll };
	});
	return { next, changed };
}

function replaceTargetIdsInSubscriptions(
	subscriptions: readonly Subscription[],
	aliases: ReadonlyMap<string, string>,
): { next: Subscription[]; changed: boolean } {
	if (aliases.size === 0) return { next: [...subscriptions], changed: false };
	let changed = false;
	const next = subscriptions.map((sub) => {
		let subChanged = false;
		const routing = { ...sub.routing };
		for (const key of Object.keys(routing) as Array<keyof Subscription["routing"]>) {
			const before = routing[key];
			const seen = new Set<string>();
			const after: string[] = [];
			for (const id of before) {
				const mapped = aliases.get(id) ?? id;
				if (mapped !== id) subChanged = true;
				if (!seen.has(mapped)) {
					seen.add(mapped);
					after.push(mapped);
				}
			}
			if (after.length !== before.length || subChanged) routing[key] = after;
		}

		const atAll = {
			dynamic: { ...sub.atAll.dynamic },
			live: { ...sub.atAll.live },
		};
		for (const group of [atAll.dynamic, atAll.live]) {
			for (const [from, to] of aliases) {
				if (!(from in group)) continue;
				const value = group[from];
				if (!(to in group) && value !== undefined) group[to] = value;
				delete group[from];
				subChanged = true;
			}
		}
		if (!subChanged) return sub;
		changed = true;
		return { ...sub, routing, atAll };
	});
	return { next, changed };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class NodeConfigStore implements ConfigStore {
	readonly bootstrap: BootstrapConfig;
	private readonly bus: MessageBus;
	private readonly serviceCtx: ServiceContext;
	private readonly stateDir: string;
	private readonly secretStore?: SecretStore;
	private secretBag: ConfigSecrets = {};
	/** P2:明文 apiKey 告警只打一次(避免每次写盘刷屏)。 */
	private plaintextApiKeyWarned = false;

	private globals: GlobalConfig;
	private subscriptions: Subscription[];
	private adapters: PushAdapter[];
	private targets: PushTarget[];

	private readonly meta: Record<ConfigScope, ScopeMetaInternal> = {
		globals: { exists: false, lastUpdatedAt: null },
		subscriptions: { exists: false, lastUpdatedAt: null },
		adapters: { exists: false, lastUpdatedAt: null },
		targets: { exists: false, lastUpdatedAt: null },
		secrets: { exists: false, lastUpdatedAt: null },
	};

	private readonly queues: Record<ConfigScope, Queue> = {
		globals: Promise.resolve(),
		subscriptions: Promise.resolve(),
		adapters: Promise.resolve(),
		targets: Promise.resolve(),
		secrets: Promise.resolve(),
	};

	private loaded = false;

	constructor(opts: CreateConfigStoreOptions) {
		this.bootstrap = opts.bootstrap;
		this.bus = opts.bus;
		this.serviceCtx = opts.serviceCtx;
		this.stateDir = opts.stateDir ?? join(opts.bootstrap.dataDir, "state");
		this.secretStore = opts.secretStore;
		// Initialize with safe defaults; `load()` overwrites.
		this.globals = makeDefaultGlobalConfig();
		this.subscriptions = [];
		this.adapters = [];
		this.targets = [];
	}

	private path(scope: ConfigScope): string {
		switch (scope) {
			case "globals":
				return join(this.stateDir, "globals.json");
			case "subscriptions":
				return join(this.stateDir, "subscriptions.json");
			case "adapters":
				return join(this.stateDir, "adapters.json");
			case "targets":
				return join(this.stateDir, "targets.json");
			case "secrets":
				// Unreachable: secrets are owned by SecretStore (config-secrets.enc),
				// never the plain JSON scope-write path. Branch kept for ConfigScope
				// exhaustiveness only.
				return join(this.stateDir, "secrets.json");
		}
	}

	/** Write globals.json. When a SecretStore owns the apiKey, the on-disk copy is stripped. */
	private async persistGlobals(g: GlobalConfig): Promise<void> {
		// P2:无 SecretStore 的 legacy 路径,apiKey 明文落 globals.json。这是
		// 既有兼容回退(非缺陷),但此前无任何提示 —— 运维不知密钥在盘上明文。
		// 首次遇到非空 apiKey 时高可见告警一次(建议配置 passphrase 启用加密)。
		if (!this.secretStore && !this.plaintextApiKeyWarned && g.defaults?.ai?.apiKey) {
			this.plaintextApiKeyWarned = true;
			this.serviceCtx.logger.warn(
				"[secret] AI apiKey 以明文写入 globals.json(未配置加密密钥)。建议设置 passphrase 启用 SecretStore 加密。",
			);
		}
		await atomicWriteJson(this.path("globals"), this.secretStore ? stripApiKeyForDisk(g) : g);
	}

	/**
	 * Move `defaults.ai.apiKey` out of plaintext globals.json into the encrypted
	 * SecretStore, then hydrate the in-memory value back so engines/routes see
	 * it unchanged. One-time lift: an existing plaintext key on disk is migrated
	 * into the secret bag and scrubbed from globals.json. No-op without a
	 * SecretStore (legacy behaviour preserved for tests / non-secret callers).
	 */
	private async hydrateSecrets(): Promise<void> {
		if (!this.secretStore) return;
		this.secretBag = await this.secretStore.load();
		const diskKey = this.globals.defaults.ai.apiKey;
		const hadPlaintext = typeof diskKey === "string" && diskKey.length > 0;
		if (hadPlaintext && !this.secretBag.aiApiKey) {
			this.secretBag = { ...this.secretBag, aiApiKey: diskKey };
			await this.secretStore.save(this.secretBag);
			this.serviceCtx.logger.info(
				"[secrets] 已把明文 apiKey 从 globals.json 迁移进加密 secrets 文件",
			);
		}
		// Hydrate in-memory (engines/routes keep reading defaults.ai.apiKey).
		this.globals = {
			...this.globals,
			defaults: {
				...this.globals.defaults,
				ai: { ...this.globals.defaults.ai, apiKey: this.secretBag.aiApiKey ?? "" },
			},
		};
		// Scrub disk if it ever held the plaintext.
		if (hadPlaintext) await this.persistGlobals(this.globals);
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
					await this.persistGlobals(this.globals);
					this.touch("globals");
				}
			}

			// 一次性迁移:占位符语法统一前(alpha.x)写入的 globals.json,直播消息模板
			// 用了渲染器并不提供的 {title}/{duration},上舰文案用了旧变量名
			// {user}/{mastername} —— 这些「旧默认原值」不会被正确渲染,且与「自定义关闭
			// 时实际推送的内建文案」不一致。检测到用户从未改过(值 == 旧默认)时一次性
			// 改写成当前默认;用户自定义过的值(≠旧默认)原样保留。
			if (existed) {
				const tpl = this.globals.defaults.templates;
				const fresh = makeDefaultGlobalConfig().defaults.templates;
				let tplMigrated = false;
				const OLD_LIVE = {
					liveStart: "{name} 开播了！\n直播间标题：{title}\n直播间链接：{link}",
					liveOngoing: "{name} 仍在直播中（已直播 {duration}）\n标题：{title}\n看过：{watched}",
					liveEnd: "{name} 下播了，直播时长 {duration}",
				} as const;
				for (const k of ["liveStart", "liveOngoing", "liveEnd"] as const) {
					if (tpl[k] === OLD_LIVE[k]) {
						tpl[k] = fresh[k];
						tplMigrated = true;
					}
				}
				const OLD_GUARD = {
					captain: "{user} 成为了 {mastername} 的舰长！",
					commander: "{user} 成为了 {mastername} 的提督！",
					governor: "{user} 成为了 {mastername} 的总督！",
				} as const;
				for (const role of ["captain", "commander", "governor"] as const) {
					if (tpl.guardBuy[role].template === OLD_GUARD[role]) {
						tpl.guardBuy[role].template = fresh.guardBuy[role].template;
						tplMigrated = true;
					}
				}
				if (tplMigrated) {
					await this.persistGlobals(this.globals);
					this.touch("globals");
				}
			}

			// Move apiKey out of plaintext globals.json into encrypted secrets
			// (+ one-time lift), then hydrate it back in memory.
			await this.hydrateSecrets();
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

		// adapters + targets (with one-time migration from the legacy single-file
		// targets.json that bundled connection+session into `config`)
		await this.loadAdaptersAndTargets();

		this.loaded = true;
		this.serviceCtx.logger.info(
			`config-store loaded (stateDir=${this.stateDir} subs=${this.subscriptions.length} adapters=${this.adapters.length} targets=${this.targets.length})`,
		);
	}

	/**
	 * Loads adapters.json + targets.json. If adapters.json is missing AND the
	 * existing targets.json is in the legacy single-blob format (config field
	 * holding both connection and session params), runs a one-shot migration
	 * that extracts adapters and rewrites targets to reference them.
	 */
	private async loadAdaptersAndTargets(): Promise<void> {
		const adaptersExist = await fileExists(this.path("adapters"));

		// New-format path: adapters.json is already present.
		if (adaptersExist) {
			const adaptersRaw = JSON.parse(await readFile(this.path("adapters"), "utf8"));
			if (!Array.isArray(adaptersRaw)) {
				throw new ConfigValidationError(
					"adapters",
					{ message: "adapters.json must be an array" },
					"adapters.json on disk is not an array",
				);
			}
			const adapters: PushAdapter[] = [];
			for (const [idx, raw] of adaptersRaw.entries()) {
				const r = PushAdapterSchema.safeParse(raw);
				if (!r.success) {
					throw new ConfigValidationError(
						"adapters",
						{ index: idx, issues: r.error.issues },
						`adapters.json[${idx}] failed schema validation`,
					);
				}
				adapters.push(r.data);
			}
			this.adapters = adapters;
			this.meta.adapters.exists = true;

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
			const targets: PushTarget[] = [];
			for (const [idx, raw] of value.entries()) {
				const r = PushTargetSchema.safeParse(raw);
				if (!r.success) {
					throw new ConfigValidationError(
						"targets",
						{ index: idx, issues: r.error.issues },
						`targets.json[${idx}] failed schema validation`,
					);
				}
				targets.push(r.data);
			}
			const synced = syncManagedWebhookTargets(this.adapters, targets);
			this.targets = synced.next;
			this.meta.targets.exists = true;
			this.meta.targets.lastUpdatedAt = existed ? null : new Date().toISOString();
			if (synced.changed) {
				await atomicWriteJson(this.path("targets"), this.targets);
				this.touch("targets");
			}
			const replaced = replaceTargetIdsInSubscriptions(this.subscriptions, synced.aliases);
			if (replaced.changed) {
				await atomicWriteJson(this.path("subscriptions"), replaced.next);
				this.subscriptions = replaced.next;
				this.touch("subscriptions");
			}
			return;
		}

		// Legacy migration path: adapters.json missing. Inspect targets.json.
		const targetsExist = await fileExists(this.path("targets"));
		if (!targetsExist) {
			// Brand-new install: write empty files and continue.
			await atomicWriteJson(this.path("adapters"), []);
			await atomicWriteJson(this.path("targets"), []);
			this.adapters = [];
			this.targets = [];
			this.meta.adapters.exists = true;
			this.meta.adapters.lastUpdatedAt = new Date().toISOString();
			this.meta.targets.exists = true;
			this.meta.targets.lastUpdatedAt = new Date().toISOString();
			return;
		}

		const targetsRaw = JSON.parse(await readFile(this.path("targets"), "utf8"));
		if (!Array.isArray(targetsRaw)) {
			throw new ConfigValidationError(
				"targets",
				{ message: "targets.json must be an array" },
				"targets.json on disk is not an array",
			);
		}

		// Two possibilities: (a) already-new shape but the user manually deleted
		// adapters.json — try parsing each entry against the new schema first.
		const tryNew = targetsRaw.every((t) => PushTargetSchema.safeParse(t).success);
		if (tryNew && targetsRaw.length > 0) {
			// New shape but no adapters file → bail with an explicit error so the
			// user notices something is off rather than us silently inventing data.
			throw new ConfigValidationError(
				"adapters",
				{ message: "adapters.json missing but targets.json is in new format" },
				"adapters.json missing but targets.json already in new format; cannot rebuild adapters automatically",
			);
		}

		// Run migration: targetsRaw is the legacy shape.
		this.serviceCtx.logger.info(
			`config-store migrating ${targetsRaw.length} legacy push target(s) → adapter + target split`,
		);
		const { adapters, targets } = migrateLegacyTargets(targetsRaw);
		const synced = syncManagedWebhookTargets(adapters, targets);
		const replaced = replaceTargetIdsInSubscriptions(this.subscriptions, synced.aliases);
		this.adapters = adapters;
		this.targets = synced.next;
		if (replaced.changed) this.subscriptions = replaced.next;
		await atomicWriteJson(this.path("adapters"), adapters);
		await atomicWriteJson(this.path("targets"), this.targets);
		if (replaced.changed) {
			await atomicWriteJson(this.path("subscriptions"), this.subscriptions);
			this.touch("subscriptions");
		}
		this.meta.adapters.exists = true;
		this.meta.adapters.lastUpdatedAt = new Date().toISOString();
		this.meta.targets.exists = true;
		this.meta.targets.lastUpdatedAt = new Date().toISOString();
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

	getAdapters(): PushAdapter[] {
		return deepClone(this.adapters);
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

	getAdaptersMeta(): ConfigScopeMeta {
		return { ...this.meta.adapters };
	}

	getTargetsMeta(): ConfigScopeMeta {
		return { ...this.meta.targets };
	}

	// ---- write surface --------------------------------------------------

	/**
	 * Persist a validated GlobalConfig. With a SecretStore the apiKey is routed
	 * into the encrypted bag and scrubbed from the on-disk globals.json; the
	 * in-memory copy keeps the real value so engines/routes are unaffected.
	 */
	private async writeGlobals(g: GlobalConfig): Promise<void> {
		if (this.secretStore) {
			// P2:此前 save 成功后 persistGlobals 抛错 → 密钥袋已存新 apiKey 但
			// globals.json/in-memory 仍旧值 → 重启后两边分叉。失败即回滚密钥袋,
			// 两端始终一致(全旧或全新);in-memory 仅在双写都成功后更新。
			const prevBag = this.secretBag;
			const apiKey = g.defaults.ai.apiKey;
			const nextBag = {
				...this.secretBag,
				aiApiKey: apiKey && apiKey.length > 0 ? apiKey : undefined,
			};
			await this.secretStore.save(nextBag);
			try {
				await this.persistGlobals(g);
			} catch (e) {
				this.secretBag = prevBag;
				await this.secretStore.save(prevBag).catch(() => {});
				throw e;
			}
			this.secretBag = nextBag;
		} else {
			await this.persistGlobals(g);
		}
		this.globals = g;
	}

	async setGlobals(next: GlobalConfig): Promise<void> {
		await this.runScoped("globals", async () => {
			const parsed = GlobalConfigSchema.safeParse(next);
			if (!parsed.success) {
				throw new ConfigValidationError("globals", parsed.error.issues);
			}
			await this.writeGlobals(parsed.data);
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
			await this.writeGlobals(parsed.data);
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

	async upsertAdapter(adapter: PushAdapter): Promise<void> {
		const saved = await this.runScoped("adapters", async () => {
			const parsed = PushAdapterSchema.safeParse(adapter);
			if (!parsed.success) {
				throw new ConfigValidationError("adapters", parsed.error.issues);
			}
			const existing = this.adapters.find((a) => a.id === parsed.data.id);
			if (existing && existing.platform !== parsed.data.platform) {
				throw new ConfigValidationError(
					"adapters",
					{
						id: parsed.data.id,
						from: existing.platform,
						to: parsed.data.platform,
						message: "adapter platform cannot be changed",
					},
					`adapter ${parsed.data.id} platform cannot be changed`,
				);
			}
			const next = upsertById(this.adapters, parsed.data);
			await atomicWriteJson(this.path("adapters"), next);
			this.adapters = next;
			this.touch("adapters");
			return parsed.data;
		});
		let targetAliases = new Map<string, string>();
		const targetsChanged =
			saved.platform === "webhook"
				? await this.runScoped("targets", async () => {
						const synced = syncManagedWebhookTarget(saved, this.targets);
						targetAliases = synced.aliases;
						if (!synced.changed) return false;
						await atomicWriteJson(this.path("targets"), synced.next);
						this.targets = synced.next;
						this.touch("targets");
						return true;
					})
				: false;
		const subscriptionsChanged = await this.replaceSubscriptionTargetAliases(targetAliases);
		this.bus.emit("config-changed", "adapters");
		if (targetsChanged) this.bus.emit("config-changed", "targets");
		if (subscriptionsChanged) this.bus.emit("config-changed", "subscriptions");
	}

	async patchAdapter(id: string, patch: DeepPartial<PushAdapter>): Promise<PushAdapter> {
		const result = await this.runScoped("adapters", async () => {
			const idx = this.adapters.findIndex((a) => a.id === id);
			if (idx < 0) {
				throw new ConfigValidationError(
					"adapters",
					{ id, message: "adapter not found" },
					`adapter ${id} not found`,
				);
			}
			const current = this.adapters[idx] as PushAdapter;
			const merged = deepMerge(current, { ...patch, id });
			const parsed = PushAdapterSchema.safeParse(merged);
			if (!parsed.success) {
				throw new ConfigValidationError("adapters", parsed.error.issues);
			}
			if (current.platform !== parsed.data.platform) {
				throw new ConfigValidationError(
					"adapters",
					{
						id,
						from: current.platform,
						to: parsed.data.platform,
						message: "adapter platform cannot be changed",
					},
					`adapter ${id} platform cannot be changed`,
				);
			}
			const next = [...this.adapters];
			next[idx] = parsed.data;
			await atomicWriteJson(this.path("adapters"), next);
			this.adapters = next;
			this.touch("adapters");
			return parsed.data;
		});
		let targetAliases = new Map<string, string>();
		const targetsChanged =
			result.platform === "webhook"
				? await this.runScoped("targets", async () => {
						const synced = syncManagedWebhookTarget(result, this.targets);
						targetAliases = synced.aliases;
						if (!synced.changed) return false;
						await atomicWriteJson(this.path("targets"), synced.next);
						this.targets = synced.next;
						this.touch("targets");
						return true;
					})
				: false;
		const subscriptionsChanged = await this.replaceSubscriptionTargetAliases(targetAliases);
		this.bus.emit("config-changed", "adapters");
		if (targetsChanged) this.bus.emit("config-changed", "targets");
		if (subscriptionsChanged) this.bus.emit("config-changed", "subscriptions");
		return deepClone(result);
	}

	async deleteAdapter(id: string): Promise<boolean> {
		const removedAdapter = await this.runScoped("adapters", async () => {
			const idx = this.adapters.findIndex((a) => a.id === id);
			if (idx < 0) return undefined;
			const adapter = this.adapters[idx] as PushAdapter;
			// 引用检查必须在任务体内(执行期)对 this.targets 求值,而非 enqueue
			// 时 —— 在 scope 外同步检查会与并行 targets 队列竞态:check 通过后、
			// 删除执行前一个 upsertTarget 引用该 adapter 即产生孤儿 target。
			// (互补:upsertTarget 侧 assertAdapterMatches 也校验 adapter 存在。)
			const referencing = this.targets.filter((t) => t.adapterId === id).map((t) => t.id);
			if (adapter.platform !== "webhook" && referencing.length > 0) {
				throw new ConfigValidationError(
					"adapters",
					{ id, targetIds: referencing, message: "adapter still in use" },
					`adapter ${id} is still referenced by ${referencing.length} target(s)`,
				);
			}
			const next = this.adapters.filter((_, i) => i !== idx);
			await atomicWriteJson(this.path("adapters"), next);
			this.adapters = next;
			this.touch("adapters");
			return adapter;
		});
		if (!removedAdapter) return false;

		let targetsChanged = false;
		let subscriptionsChanged = false;
		if (removedAdapter.platform === "webhook") {
			let removedTargetIds: string[] = [];
			targetsChanged = await this.runScoped("targets", async () => {
				removedTargetIds = this.targets.filter((t) => t.adapterId === id).map((t) => t.id);
				const next = this.targets.filter((t) => t.adapterId !== id);
				if (next.length === this.targets.length) return false;
				await atomicWriteJson(this.path("targets"), next);
				this.targets = next;
				this.touch("targets");
				return true;
			});
			subscriptionsChanged = await this.runScoped("subscriptions", async () => {
				const cleaned = removeTargetIdsFromSubscriptions(this.subscriptions, removedTargetIds);
				if (!cleaned.changed) return false;
				await atomicWriteJson(this.path("subscriptions"), cleaned.next);
				this.subscriptions = cleaned.next;
				this.touch("subscriptions");
				return true;
			});
		}

		this.bus.emit("config-changed", "adapters");
		if (targetsChanged) this.bus.emit("config-changed", "targets");
		if (subscriptionsChanged) this.bus.emit("config-changed", "subscriptions");
		return true;
	}

	async upsertTarget(target: PushTarget): Promise<void> {
		await this.runScoped("targets", async () => {
			const parsed = PushTargetSchema.safeParse(target);
			if (!parsed.success) {
				throw new ConfigValidationError("targets", parsed.error.issues);
			}
			this.assertAdapterMatches(parsed.data);
			if (parsed.data.platform === "webhook") {
				throw new ConfigValidationError(
					"targets",
					{ message: "webhook target is managed by adapter" },
					"webhook targets are created from webhook adapters automatically",
				);
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
			if (current.platform === "webhook" && current.managedBy === "adapter") {
				throw new ConfigValidationError(
					"targets",
					{
						id,
						keys: Object.keys(patch as Record<string, unknown>),
						message: "managed target cannot be edited directly",
					},
					`target ${id} is managed by adapter and cannot be edited directly`,
				);
			}
			const merged = deepMerge(current, { ...patch, id });
			const parsed = PushTargetSchema.safeParse(merged);
			if (!parsed.success) {
				throw new ConfigValidationError("targets", parsed.error.issues);
			}
			this.assertAdapterMatches(parsed.data);
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

	async recordTargetTestStatus(id: string, status: PushTarget["testStatus"]): Promise<PushTarget> {
		const result = await this.runScoped("targets", async () => {
			const idx = this.targets.findIndex((t) => t.id === id);
			if (idx < 0) {
				throw new ConfigValidationError(
					"targets",
					{ id, message: "target not found" },
					`target ${id} not found`,
				);
			}
			const next = [...this.targets];
			next[idx] = { ...(this.targets[idx] as PushTarget), testStatus: status };
			await atomicWriteJson(this.path("targets"), next);
			this.targets = next;
			this.touch("targets");
			return next[idx] as PushTarget;
		});
		this.bus.emit("config-changed", "targets");
		return deepClone(result);
	}

	private assertAdapterMatches(target: PushTarget): void {
		const adapter = this.adapters.find((a) => a.id === target.adapterId);
		if (!adapter) {
			throw new ConfigValidationError(
				"targets",
				{ adapterId: target.adapterId, message: "adapter not found" },
				`target.adapterId ${target.adapterId} does not match any adapter`,
			);
		}
		if (adapter.platform !== target.platform) {
			throw new ConfigValidationError(
				"targets",
				{
					adapterPlatform: adapter.platform,
					targetPlatform: target.platform,
					message: "platform mismatch",
				},
				`target.platform (${target.platform}) ≠ adapter.platform (${adapter.platform})`,
			);
		}
	}

	async deleteTarget(id: string): Promise<boolean> {
		const removed = await this.runScoped("targets", async () => {
			const idx = this.targets.findIndex((t) => t.id === id);
			if (idx < 0) return false;
			const target = this.targets[idx] as PushTarget;
			if (target.managedBy === "adapter") {
				throw new ConfigValidationError(
					"targets",
					{ id, message: "managed target cannot be deleted directly" },
					`target ${id} is managed by adapter and cannot be deleted directly`,
				);
			}
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

	private async replaceSubscriptionTargetAliases(
		aliases: ReadonlyMap<string, string>,
	): Promise<boolean> {
		return this.runScoped("subscriptions", async () => {
			const replaced = replaceTargetIdsInSubscriptions(this.subscriptions, aliases);
			if (!replaced.changed) return false;
			await atomicWriteJson(this.path("subscriptions"), replaced.next);
			this.subscriptions = replaced.next;
			this.touch("subscriptions");
			return true;
		});
	}

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
