import { randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	CONFIG_SCHEMA_VERSION,
	type ConfigScope,
	type Connection,
	ConnectionPlatformSchema,
	ConnectionSchema,
	DEFAULT_CARD_LAYOUT,
	DEFAULT_MESSAGE_LAYOUT,
	type Disposable,
	deterministicUuid,
	type GlobalConfig,
	GlobalConfigSchema,
	isDirectConnection,
	isWebhookConnection,
	type MessageBus,
	makeDefaultGlobalConfig,
	migrateConfigSections,
	normalizeCardLayout,
	normalizeMessageLayout,
	type PushTarget,
	PushTargetSchema,
	type ServiceContext,
	type Subscription,
	SubscriptionSchema,
} from "@bilibili-notify/internal";
import {
	ONEBOT_FORWARD_MIN_TIMEOUT_MS,
	ONEBOT_IMAGE_MIN_TIMEOUT_MS,
} from "@bilibili-notify/internal/constants";
import { applyAiSecrets, collectAiSecrets, stripAiSecrets } from "./ai-secrets.js";
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
type DeepPartial<T> =
	T extends Array<infer _U> ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

/** Per-scope metadata exposed via `/api/health/details`. */
export interface ConfigScopeMeta {
	exists: boolean;
	lastUpdatedAt: string | null;
}

/**
 * 一次整体替换要写进去的分区。缺席的分区保持不动 —— 「不给」和「给一个空数组」
 * 是两回事:后者是真的清空。
 */
export interface ConfigSections {
	globals?: GlobalConfig;
	subscriptions?: Subscription[];
	connections?: Connection[];
	targets?: PushTarget[];
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
	getConnections(): Connection[];
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
	upsertConnection(connection: Connection): Promise<void>;
	patchConnection(id: string, patch: DeepPartial<Connection>): Promise<Connection>;
	deleteConnection(id: string): Promise<boolean>;
	upsertTarget(target: PushTarget): Promise<void>;
	patchTarget(id: string, patch: DeepPartial<PushTarget>): Promise<PushTarget>;
	recordTargetTestStatus(id: string, status: PushTarget["testStatus"]): Promise<PushTarget>;
	deleteTarget(id: string): Promise<boolean>;

	/**
	 * 整体替换若干分区(恢复备份 / 一次性迁移)。先全量校验再落盘,失败不留半新半旧。
	 * 详见实现处的注释。
	 */
	replaceSections(next: ConfigSections): Promise<ConfigScope[]>;
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
/**
 * 落盘前抠掉全部 AI 密钥(每家两把)。`state/globals.json` **不加密**,漏掉任何
 * 一把就是明文躺在盘上。具体规则见 `./ai-secrets.ts#stripAiSecrets`。
 */
function stripApiKeyForDisk(g: GlobalConfig): GlobalConfig {
	return stripAiSecrets(deepClone(g));
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
 * into the new (Connection, PushTarget) pair. Targets with the same platform
 * and connection params share a connection so the user doesn't end up with N
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
	connections: Connection[];
	targets: PushTarget[];
} {
	const connections: Connection[] = [];
	const targets: PushTarget[] = [];
	// connection-key → connectionId, so duplicate connections collapse.
	const connectionIdByKey = new Map<string, string>();

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
			let connectionId = connectionIdByKey.get(key);
			if (!connectionId) {
				connectionId = randomUUID();
				connectionIdByKey.set(key, connectionId);
				connections.push({
					id: connectionId,
					name: deriveConnectionName(legacy.name, baseUrl),
					enabled: true,
					kind: "direct",
					connector: "http",
					platform: "onebot",
					config: {
						transport: "http",
						baseUrl,
						accessToken: accessToken || undefined,
						protocolVersion: cfg.protocolVersion ?? "v11",
						headers: {},
						timeoutMs: 15_000,
						imageMinTimeoutMs: ONEBOT_IMAGE_MIN_TIMEOUT_MS,
						forwardMinTimeoutMs: ONEBOT_FORWARD_MIN_TIMEOUT_MS,
						retryTimes: 0,
						retryIntervalMs: 1_000,
					},
				});
			}
			targets.push({
				id: legacy.id,
				name: legacy.name,
				connectionId,
				kind: "session",
				platform: "onebot",
				scope: legacy.scope,
				enabled: legacy.enabled,
				address: (legacy.scope === "private" ? cfg.userId : cfg.groupId) ?? "",
			});
		} else if (legacy.platform === "webhook") {
			const cfg = legacy.config as {
				url?: string;
				secret?: string;
				headers?: Record<string, string>;
			};
			const url = cfg.url ?? "";
			const key = `webhook|${url}|${cfg.secret ?? ""}`;
			let connectionId = connectionIdByKey.get(key);
			if (!connectionId) {
				connectionId = randomUUID();
				connectionIdByKey.set(key, connectionId);
				connections.push({
					id: connectionId,
					name: deriveConnectionName(legacy.name, url),
					enabled: true,
					kind: "direct",
					connector: "webhook",
					// 这条遗留路径来自「webhook 是一个平台」那一代,当时连 provider 都还没有
					// (它是后来才加进 config 的)—— 所以一律落 generic。
					platform: "generic",
					config: {
						url,
						secret: cfg.secret || undefined,
						headers: cfg.headers ?? {},
					},
				});
			}
			targets.push({
				id: legacy.id,
				name: legacy.name,
				connectionId,
				kind: "endpoint",
				platform: "generic",
				scope: legacy.scope,
				enabled: legacy.enabled,
			});
		}
		// Unknown legacy platform (incl. the removed web-dashboard) — drop silently;
		// the user sees the target disappear and can re-create it under a supported platform.
	}

	return { connections, targets };
}

/**
 * 盘上这一行是不是「已撤下平台留下的存量」—— 该静默丢掉的那种。连接与目标同一条判据。
 *
 * 判据是:**我们认得的平台必须能 parse;认不得的平台又 parse 不过,才是存量。**
 * 所以它**只在 parse 失败之后**才问,永远不跑在 parse 之前。
 *
 * ⚠️ **别再把它挪回 parse 之前。** 拿原始 JSON 用闭集问「这个平台认得吗」,等于
 * 「词表里没有 = 不存在」:桥接入根本没有 `platform` 那一格,拓展带来的连接平台也不在
 * 闭集里 —— 两者都会在**开机时被静默丢光**,而且下一次任何写入都会把这个丢弃**写实到
 * 盘上**。主人看到的是配置自己消失,没有一行报错。换成「parse 得过就留下」之后,以后
 * 新增哪一支都不必回来改这里。
 *
 * - `koishi-bot` 的老条目:词表外 + 老形状 parse 不过 → 丢弃(与从前同样的行为)
 * - 桥接入 / 桥驮来的 telegram 目标:parse 得过 → 走不到这里
 * - onebot 的坏条目:词表内 → 照旧 throw,不许静默吃掉真正的损坏
 */
function isRetiredPlatformRecord(raw: unknown): boolean {
	return !ConnectionPlatformSchema.safeParse((raw as { platform?: unknown })?.platform).success;
}

/**
 * 连接的**身份轴**不许改 —— 换 `kind` 或换 `platform` 都等于换了另一条连接,而目标还
 * 挂在原来那个 id 上。允许改的话,「onebot 群目标」会一夜之间挂在一条飞书连接下面。
 *
 * 桥接入那一支只有 `kind` 一根身份轴(它没有 platform),所以两条判断分开写:
 * 先比 kind,同为直连时再比 platform。
 */
function assertConnectionIdentityStable(current: Connection, next: Connection): void {
	if (current.kind !== next.kind) {
		throw new ConfigValidationError(
			"connections",
			{
				id: next.id,
				from: current.kind,
				to: next.kind,
				message: "connection kind cannot be changed",
			},
			`connection ${next.id} kind cannot be changed`,
		);
	}
	if (!isDirectConnection(current) || !isDirectConnection(next)) return;
	if (current.platform !== next.platform) {
		throw new ConfigValidationError(
			"connections",
			{
				id: next.id,
				from: current.platform,
				to: next.platform,
				message: "connection platform cannot be changed",
			},
			`connection ${next.id} platform cannot be changed`,
		);
	}
}

/**
 * 目标与它挂着的那条连接对不对得上 —— 连接存在,且平台是同一个。
 *
 * 逐条 upsert 与整体 replaceSections 都走这一份:同一条不变式抄两遍,总有一天只改了
 * 一边(而那两条路上「半新半旧的配置」代价完全一样)。
 *
 * 桥接入那一支**没有 platform**(平台是桥握手时报的、是运行时知识),所以这里只校验
 * 「连接存在」。「这个平台真的挂在那条桥上吗」得等桥报了名单才答得出,那是投递层的事 ——
 * 在存储期拒绝等于要求「先连上桥才能配目标」,而目标本来就允许先建壳后填。
 */
function assertTargetOwner(target: PushTarget, connections: readonly Connection[]): void {
	const owner = connections.find((a) => a.id === target.connectionId);
	if (!owner) {
		throw new ConfigValidationError(
			"targets",
			{ id: target.id, connectionId: target.connectionId, message: "connection not found" },
			`target ${target.id} references unknown connection ${target.connectionId}`,
		);
	}
	if (!isDirectConnection(owner)) return;
	if (owner.platform !== target.platform) {
		throw new ConfigValidationError(
			"targets",
			{
				id: target.id,
				connectionPlatform: owner.platform,
				targetPlatform: target.platform,
				message: "platform mismatch",
			},
			`target ${target.id} platform ${target.platform} does not match connection ${owner.platform}`,
		);
	}
}

function deriveConnectionName(targetName: string, addr: string): string {
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

/** 靠 webhook 连的那族连接 —— 判据是**连接器**,平台是飞书 / 钉钉 / 企微 / 未指明中的一个。 */
type WebhookConnection = Extract<Connection, { connector: "webhook" }>;

/**
 * 托管目标的 id。**种子里那个 `adapter` 是冻住的**,别顺着改名一起改:它算出来的 uuid
 * 已经落在主人盘上,订阅的路由表按 id 引用着它 —— 换种子等于给每条 webhook 连接凭空
 * 换一张目标,主人配好的路由指向一个不存在的 id,而且不报错。
 */
function managedWebhookTargetId(connectionId: string): string {
	return deterministicUuid(`push-target:webhook-adapter:${connectionId}`);
}

function makeManagedWebhookTarget(
	connection: WebhookConnection,
	existing?: PushTarget,
): PushTarget {
	return {
		id: existing?.id ?? managedWebhookTargetId(connection.id),
		name: connection.name || "Webhook",
		connectionId: connection.id,
		kind: "endpoint",
		// 托管目标的平台跟着连接走 —— 连接改成钉钉,这里下一次同步就跟着改。
		platform: connection.platform,
		scope: "channel",
		enabled: connection.enabled,
		managedBy: "connection",
		testStatus: existing?.testStatus,
	};
}

function syncManagedWebhookTarget(
	connection: WebhookConnection,
	targets: readonly PushTarget[],
): { next: PushTarget[]; changed: boolean; aliases: Map<string, string> } {
	const owned = targets.filter((t) => t.kind === "endpoint" && t.connectionId === connection.id);
	const existing = owned.find((t) => t.managedBy === "connection") ?? owned[0];
	const desired = makeManagedWebhookTarget(connection, existing);
	if (!existing) return { next: [...targets, desired], changed: true, aliases: new Map() };

	const aliases = new Map<string, string>();
	for (const target of owned) {
		if (target.id !== desired.id) aliases.set(target.id, desired.id);
	}
	const next = targets
		.filter(
			(t) => !(t.kind === "endpoint" && t.connectionId === connection.id && t.id !== desired.id),
		)
		.map((t) => (t.id === desired.id ? desired : t));
	const changed =
		aliases.size > 0 ||
		existing.name !== desired.name ||
		existing.connectionId !== desired.connectionId ||
		existing.kind !== desired.kind ||
		existing.platform !== desired.platform ||
		existing.scope !== desired.scope ||
		existing.enabled !== desired.enabled ||
		existing.managedBy !== desired.managedBy;
	return { next, changed, aliases };
}

function syncManagedWebhookTargets(
	connections: readonly Connection[],
	targets: readonly PushTarget[],
): { next: PushTarget[]; changed: boolean; aliases: Map<string, string> } {
	let next = [...targets];
	let changed = false;
	const aliases = new Map<string, string>();
	for (const connection of connections) {
		if (!isWebhookConnection(connection)) continue;
		const r = syncManagedWebhookTarget(connection, next);
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
	private connections: Connection[];
	private targets: PushTarget[];

	private readonly meta: Record<ConfigScope, ScopeMetaInternal> = {
		globals: { exists: false, lastUpdatedAt: null },
		subscriptions: { exists: false, lastUpdatedAt: null },
		connections: { exists: false, lastUpdatedAt: null },
		targets: { exists: false, lastUpdatedAt: null },
		secrets: { exists: false, lastUpdatedAt: null },
	};

	private readonly queues: Record<ConfigScope, Queue> = {
		globals: Promise.resolve(),
		subscriptions: Promise.resolve(),
		connections: Promise.resolve(),
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
		this.connections = [];
		this.targets = [];
	}

	private path(scope: ConfigScope): string {
		switch (scope) {
			case "globals":
				return join(this.stateDir, "globals.json");
			case "subscriptions":
				return join(this.stateDir, "subscriptions.json");
			case "connections":
				return join(this.stateDir, "connections.json");
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
		if (
			!this.secretStore &&
			!this.plaintextApiKeyWarned &&
			Object.keys(collectAiSecrets(g)).length > 0
		) {
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

		// 上一版的**单把** aiApiKey → 新的多把袋子。schema 那边把扁平旧配置整份
		// 迁进了 `providers.custom`,所以这把 key 的去处正是 custom 槽。
		if (this.secretBag.aiApiKey) {
			const { aiApiKey, ...rest } = this.secretBag;
			this.secretBag = {
				...rest,
				aiApiKeys: { custom: aiApiKey, ...(this.secretBag.aiApiKeys ?? {}) },
			};
			await this.secretStore.save(this.secretBag);
			this.serviceCtx.logger.info("[secrets] 已把旧的单把 apiKey 迁进按服务商分桶的密钥袋");
		}

		// 明文密钥(功能上线前写下的、或用户手改过 globals.json)一并抬进加密袋。
		const plaintext = collectAiSecrets(this.globals);
		const hadPlaintext = Object.keys(plaintext).length > 0;
		if (hadPlaintext) {
			// 袋里已有的优先 —— 盘上的明文可能是更早的残留。
			this.secretBag = {
				...this.secretBag,
				aiApiKeys: { ...plaintext, ...(this.secretBag.aiApiKeys ?? {}) },
			};
			await this.secretStore.save(this.secretBag);
			this.serviceCtx.logger.info(
				"[secrets] 已把明文 apiKey 从 globals.json 迁移进加密 secrets 文件",
			);
		}
		// Hydrate in-memory (engines/routes keep reading defaults.ai.apiKey).
		//
		// 末尾必须重新过一遍 schema —— 不是为了校验,是为了**把键序归位**。
		// `stripApiKeyForDisk` 在盘上是 `delete` 掉 apiKey 的,所以 load() 读回的对象里
		// 压根没有这个键;下面的 spread 于是把它当**新键追加到对象末尾**,键序就偏离了
		// zod parse 的声明顺序。而 `engines.ts` 的 config-changed diff 是拿
		// `JSON.stringify` 逐 section 比相等的(键序敏感),它依赖「globals 永远是 zod
		// parse 的规范形态」这一不变式 —— 不归位的话,重启后第一次改**任何** globals
		// 字段(哪怕只是 dynamicCron),`defaults.ai` 都会被误判成「变了」,白白热重载一次
		// AI 实例并刷两条日志。走 legacy 明文路径时键还在原位,spread 只覆盖值,所以这个
		// 坑只在「配了 AI + 启用加密 + 重启后首次变更」三者同时满足时才现形。
		this.globals = GlobalConfigSchema.parse(
			applyAiSecrets(this.globals, this.secretBag.aiApiKeys ?? {}),
		);
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

			// 迁移此前保存的卡片版式到当前块模型(例如把各块上下间距从模版回填进
			// layout)。normalizeCardLayout 按版本门控,已是最新的版式原样通过。
			// 消息版式同款对齐:未知块丢弃、缺失的内置块追加,老存档前向兼容。
			this.globals = {
				...this.globals,
				defaults: {
					...this.globals.defaults,
					cardLayout: normalizeCardLayout(this.globals.defaults.cardLayout, DEFAULT_CARD_LAYOUT),
					messageLayout: normalizeMessageLayout(
						this.globals.defaults.messageLayout,
						DEFAULT_MESSAGE_LAYOUT,
					),
				},
			};

			// 「presets: [] 的老 globals.json 补齐内置四份」这件事**已经移到 schema 层**
			// (`AISettingsSchema` 的 migratePersonaPointer)。那道迁移必然把列表填成非空,
			// 所以这里原先那个 `presets.length === 0` 判据永远不成立 —— 留着是死代码,
			// 更糟的是会让人以为补齐还归 store 管。见
			// packages/internal/src/schema/ai-persona-pointer.test.ts。

			// ⚠️ **这张表已冻结,不要再往里加条目。**
			//
			// 它是「改了默认怎么惠及老用户」的**上一代**解法:手写一张历代旧默认,
			// 值对得上就判定「他没改过」,悄悄改写成当前默认。毛病是这张表跟当前默认
			// (`DEFAULT_TEMPLATES`,另一个包)分居两处,改默认时没有任何东西提醒你来补
			// 一条 —— `liveSummary` 已经这么漏过一次(改了占位符语法却没进表)。
			//
			// 现在这件事归 `templateDefaultsSeen` 账本 + 规则页的逐字段提示管:不再猜
			// 「他改没改过」,只问「**这一版**默认他见过没有」,于是历代表整张不需要了。
			// 见 `packages/internal/src/template-defaults.ts`。
			//
			// 留着不删是因为**它对还停在老版本、将来才升级的用户仍然生效** —— 删掉
			// 那些人就从自动迁移退化成「打开页面看见提示再点一下」。新的默认变更一律
			// 走提示,不要再碰这张表。
			//
			// 一次性迁移:历代「旧默认原值」→ 当前默认。覆盖两代:① 占位符语法统一前
			// (alpha.x)的 {title}/{duration}/{user}/{mastername} 旧变量默认;② 消息版式
			// 引入前「链接内嵌模板」的 {url}/{link} 默认(链接已改为版式的独立部件,
			// 模板默认不再带链接)。检测到用户从未改过(值 == 任一代旧默认)时一次性
			// 改写成当前默认;用户自定义过的值(≠旧默认)原样保留。
			if (existed) {
				const tpl = this.globals.defaults.templates;
				const fresh = makeDefaultGlobalConfig().defaults.templates;
				let tplMigrated = false;
				const OLD_TPL_DEFAULTS: Partial<
					Record<"liveStart" | "liveOngoing" | "liveEnd" | "dynamic" | "dynamicVideo", string[]>
				> = {
					liveStart: [
						"{name} 开播了！\n直播间标题：{title}\n直播间链接：{link}",
						"{name} 开播啦，当前粉丝数：{follower}\n{link}",
					],
					liveOngoing: [
						"{name} 仍在直播中（已直播 {duration}）\n标题：{title}\n看过：{watched}",
						"{name} 正在直播，已播 {time}，累计观看：{watched}\n{link}",
					],
					liveEnd: ["{name} 下播了，直播时长 {duration}"],
					dynamic: ["{name}发布了一条动态：{url}"],
					dynamicVideo: ["{name}发布了新视频：{url}"],
				};
				for (const [k, olds] of Object.entries(OLD_TPL_DEFAULTS) as Array<
					[keyof typeof OLD_TPL_DEFAULTS, string[]]
				>) {
					if (olds.includes(tpl[k])) {
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

		// connections + targets (with one-time migration from the legacy single-file
		// targets.json that bundled connection+session into `config`)
		await this.loadConnectionsAndTargets();

		this.loaded = true;
		this.serviceCtx.logger.info(
			`config-store loaded (stateDir=${this.stateDir} subs= connections=${this.connections.length} targets=${this.targets.length})`,
		);
	}

	/**
	 * Loads connections.json + targets.json. If neither connections.json nor the
	 * file it replaced (adapters.json) is present AND the existing targets.json is
	 * in the legacy single-blob format (config field holding both connection and
	 * session params), runs a one-shot migration that extracts connections and
	 * rewrites targets to reference them.
	 */
	private async loadConnectionsAndTargets(): Promise<void> {
		const connectionsExist = await fileExists(this.path("connections"));
		// 这个文件从前叫 adapters.json。搬名字的方式是**读老的、写新的、老的一动不动** ——
		// 老那份于是既是原件备份,又让回退到旧载荷这条路仍然能开机:旧构建找的正是它,
		// 而它还是迁移前的形状。代价是升级后的编辑不会回流过去,回退等于退回升级那一刻。
		const legacyPath = join(this.stateDir, "adapters.json");
		const legacyOnly = !connectionsExist && (await fileExists(legacyPath));
		const sourcePath = connectionsExist ? this.path("connections") : legacyPath;

		if (connectionsExist || legacyOnly) {
			const connectionsRaw = JSON.parse(await readFile(sourcePath, "utf8"));
			if (!Array.isArray(connectionsRaw)) {
				throw new ConfigValidationError(
					"connections",
					{ message: "connections.json must be an array" },
					"connections.json on disk is not an array",
				);
			}
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

			// 形状迁移 —— 老盘上的连接没有 `kind` / `connector`、目标没有 `kind`,schema 会当场
			// 拒,开机就起不来。判据是数据形状不是版本号,且迁移幂等,所以「上次写到一半掉电」
			// 重来一遍无害;两个分区一起判,只有都迁完才算新形状。
			// 回退到旧载荷是安全的:这两层都是非 strict 的 z.object,旧 schema 会把不认识的键
			// strip 掉照常加载;它写回去的没有新字段,下次再被这里迁一遍。
			const migrated = migrateConfigSections({ connections: connectionsRaw, targets: value });
			if (legacyOnly || migrated.changed.connections || migrated.changed.targets) {
				this.serviceCtx.logger.info(
					`config-store migrating config v${migrated.from} → v${CONFIG_SCHEMA_VERSION}` +
						" (原件留在同名 .bak;adapters.json 原地不动)",
				);
			}
			// 从老文件名读来的那趟一定要写:connections.json 还不存在。它自己的原件就是没被
			// 动过的 adapters.json,所以这条路不留 .bak。
			if (legacyOnly) {
				await atomicWriteJson(this.path("connections"), migrated.connections);
			} else if (migrated.changed.connections) {
				// 原件留一份 —— 迁移错了主人还能自己捞回去。
				await copyFile(this.path("connections"), `${this.path("connections")}.bak`);
				await atomicWriteJson(this.path("connections"), migrated.connections);
			}
			if (migrated.changed.targets) {
				await copyFile(this.path("targets"), `${this.path("targets")}.bak`);
				await atomicWriteJson(this.path("targets"), migrated.targets);
			}

			const connections: Connection[] = [];
			for (const [idx, raw] of migrated.connections.entries()) {
				const r = ConnectionSchema.safeParse(raw);
				if (!r.success) {
					// 已撤下平台的存量连接静默丢弃 —— 判据见 isRetiredPlatformRecord。
					if (isRetiredPlatformRecord(raw)) continue;
					throw new ConfigValidationError(
						"connections",
						{ index: idx, issues: r.error.issues },
						`connections.json[] failed schema validation`,
					);
				}
				connections.push(r.data);
			}
			this.connections = connections;
			this.meta.connections.exists = true;

			const targets: PushTarget[] = [];
			for (const [idx, raw] of migrated.targets.entries()) {
				const r = PushTargetSchema.safeParse(raw);
				if (!r.success) {
					// 已撤下平台的存量目标同理丢弃。
					if (isRetiredPlatformRecord(raw)) continue;
					throw new ConfigValidationError(
						"targets",
						{ index: idx, issues: r.error.issues },
						`targets.json[${idx}] failed schema validation`,
					);
				}
				targets.push(r.data);
			}
			const synced = syncManagedWebhookTargets(this.connections, targets);
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

		// Legacy migration path: neither connections.json nor adapters.json is there. Inspect targets.json.
		const targetsExist = await fileExists(this.path("targets"));
		if (!targetsExist) {
			// Brand-new install: write empty files and continue.
			await atomicWriteJson(this.path("connections"), []);
			await atomicWriteJson(this.path("targets"), []);
			this.connections = [];
			this.targets = [];
			this.meta.connections.exists = true;
			this.meta.connections.lastUpdatedAt = new Date().toISOString();
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
		// connections.json — try parsing each entry against the new schema first.
		const tryNew = targetsRaw.every((t) => PushTargetSchema.safeParse(t).success);
		if (tryNew && targetsRaw.length > 0) {
			// New shape but no connections file → bail with an explicit error so the
			// user notices something is off rather than us silently inventing data.
			throw new ConfigValidationError(
				"connections",
				{ message: "connections.json missing but targets.json is in new format" },
				"connections.json missing but targets.json already in new format; cannot rebuild connections automatically",
			);
		}

		// Run migration: targetsRaw is the legacy shape.
		this.serviceCtx.logger.info(
			`config-store migrating ${targetsRaw.length} legacy push target(s) → connection + target split`,
		);
		const { connections, targets } = migrateLegacyTargets(targetsRaw);
		const synced = syncManagedWebhookTargets(connections, targets);
		const replaced = replaceTargetIdsInSubscriptions(this.subscriptions, synced.aliases);
		this.connections = connections;
		this.targets = synced.next;
		if (replaced.changed) this.subscriptions = replaced.next;
		await atomicWriteJson(this.path("connections"), connections);
		await atomicWriteJson(this.path("targets"), this.targets);
		if (replaced.changed) {
			await atomicWriteJson(this.path("subscriptions"), this.subscriptions);
			this.touch("subscriptions");
		}
		this.meta.connections.exists = true;
		this.meta.connections.lastUpdatedAt = new Date().toISOString();
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

	getConnections(): Connection[] {
		return deepClone(this.connections);
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
			// 整份重算而不是并进旧袋:主人删掉一家时,那家的 key 必须跟着消失,
			// 否则删了又加回来会拿到一把他以为已经删掉的旧密钥。
			const nextBag = { ...this.secretBag, aiApiKey: undefined, aiApiKeys: collectAiSecrets(g) };
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

	async upsertConnection(connection: Connection): Promise<void> {
		const saved = await this.runScoped("connections", async () => {
			const parsed = ConnectionSchema.safeParse(connection);
			if (!parsed.success) {
				throw new ConfigValidationError("connections", parsed.error.issues);
			}
			const existing = this.connections.find((a) => a.id === parsed.data.id);
			if (existing) assertConnectionIdentityStable(existing, parsed.data);
			const next = upsertById(this.connections, parsed.data);
			await atomicWriteJson(this.path("connections"), next);
			this.connections = next;
			this.touch("connections");
			return parsed.data;
		});
		let targetAliases = new Map<string, string>();
		const targetsChanged = isWebhookConnection(saved)
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
		this.bus.emit("config-changed", "connections");
		if (targetsChanged) this.bus.emit("config-changed", "targets");
		if (subscriptionsChanged) this.bus.emit("config-changed", "subscriptions");
	}

	async patchConnection(id: string, patch: DeepPartial<Connection>): Promise<Connection> {
		const result = await this.runScoped("connections", async () => {
			const idx = this.connections.findIndex((a) => a.id === id);
			if (idx < 0) {
				throw new ConfigValidationError(
					"connections",
					{ id, message: "connection not found" },
					`connection ${id} not found`,
				);
			}
			const current = this.connections[idx] as Connection;
			const merged = deepMerge(current, { ...patch, id });
			const parsed = ConnectionSchema.safeParse(merged);
			if (!parsed.success) {
				throw new ConfigValidationError("connections", parsed.error.issues);
			}
			assertConnectionIdentityStable(current, parsed.data);
			const next = [...this.connections];
			next[idx] = parsed.data;
			await atomicWriteJson(this.path("connections"), next);
			this.connections = next;
			this.touch("connections");
			return parsed.data;
		});
		let targetAliases = new Map<string, string>();
		const targetsChanged = isWebhookConnection(result)
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
		this.bus.emit("config-changed", "connections");
		if (targetsChanged) this.bus.emit("config-changed", "targets");
		if (subscriptionsChanged) this.bus.emit("config-changed", "subscriptions");
		return deepClone(result);
	}

	async deleteConnection(id: string): Promise<boolean> {
		const removedConnection = await this.runScoped("connections", async () => {
			const idx = this.connections.findIndex((a) => a.id === id);
			if (idx < 0) return undefined;
			const connection = this.connections[idx] as Connection;
			// 引用检查必须在任务体内(执行期)对 this.targets 求值,而非 enqueue
			// 时 —— 在 scope 外同步检查会与并行 targets 队列竞态:check 通过后、
			// 删除执行前一个 upsertTarget 引用该连接即产生孤儿 target。
			// (互补:upsertTarget 侧 assertTargetOwner 也校验连接存在。)
			const referencing = this.targets.filter((t) => t.connectionId === id).map((t) => t.id);
			if (!isWebhookConnection(connection) && referencing.length > 0) {
				throw new ConfigValidationError(
					"connections",
					{ id, targetIds: referencing, message: "connection still in use" },
					`connection ${id} is still referenced by ${referencing.length} target(s)`,
				);
			}
			const next = this.connections.filter((_, i) => i !== idx);
			await atomicWriteJson(this.path("connections"), next);
			this.connections = next;
			this.touch("connections");
			return connection;
		});
		if (!removedConnection) return false;

		let targetsChanged = false;
		let subscriptionsChanged = false;
		if (isWebhookConnection(removedConnection)) {
			let removedTargetIds: string[] = [];
			targetsChanged = await this.runScoped("targets", async () => {
				removedTargetIds = this.targets.filter((t) => t.connectionId === id).map((t) => t.id);
				const next = this.targets.filter((t) => t.connectionId !== id);
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

		this.bus.emit("config-changed", "connections");
		if (targetsChanged) this.bus.emit("config-changed", "targets");
		if (subscriptionsChanged) this.bus.emit("config-changed", "subscriptions");
		return true;
	}

	async upsertTarget(target: PushTarget): Promise<void> {
		let targetAliases: ReadonlyMap<string, string> = new Map();
		await this.runScoped("targets", async () => {
			const parsed = PushTargetSchema.safeParse(target);
			if (!parsed.success) {
				throw new ConfigValidationError("targets", parsed.error.issues);
			}
			this.assertConnectionMatches(parsed.data);
			// endpoint 目标是连接的派生物,不接受外部凭空创建 —— 但**备份恢复送回来的那条
			// 是它自己**:导出走 getTargets(),必然带上托管 target。所以放行的判据是 managedBy,
			// 光看形态会把它一起挡掉,任何含 webhook 连接的备份都恢复不了(而恢复是逐条 await
			// 的,炸在这一步时 globals / 订阅 / 连接已经落盘,配置只剩半新半旧)。
			if (parsed.data.kind === "endpoint" && parsed.data.managedBy !== "connection") {
				throw new ConfigValidationError(
					"targets",
					{ message: "webhook target is managed by its connection" },
					"webhook targets are created from webhook connections automatically",
				);
			}
			let next = upsertById(this.targets, parsed.data);
			// 交回托管同步:恢复回来的那条可能带着**老 id**(makeManagedWebhookTarget 取的是
			// `existing?.id ?? 确定性id`,老记录会一直保留自己的 id),与该连接名下当前那条
			// 并存。由它决定谁留下、把另一个记进 aliases,订阅引用随后跟着改写 —— 与
			// upsertConnection 完全同一条路径,别在这儿另写一套。
			const owner = this.connections.find((a) => a.id === parsed.data.connectionId);
			if (owner && isWebhookConnection(owner)) {
				const synced = syncManagedWebhookTarget(owner, next);
				next = synced.next;
				targetAliases = synced.aliases;
			}
			await atomicWriteJson(this.path("targets"), next);
			this.targets = next;
			this.touch("targets");
		});
		const subscriptionsChanged = await this.replaceSubscriptionTargetAliases(targetAliases);
		this.bus.emit("config-changed", "targets");
		if (subscriptionsChanged) this.bus.emit("config-changed", "subscriptions");
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
			if (current.kind === "endpoint" && current.managedBy === "connection") {
				throw new ConfigValidationError(
					"targets",
					{
						id,
						keys: Object.keys(patch as Record<string, unknown>),
						message: "managed target cannot be edited directly",
					},
					`target ${id} is managed by its connection and cannot be edited directly`,
				);
			}
			const merged = deepMerge(current, { ...patch, id });
			const parsed = PushTargetSchema.safeParse(merged);
			if (!parsed.success) {
				throw new ConfigValidationError("targets", parsed.error.issues);
			}
			this.assertConnectionMatches(parsed.data);
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

	private assertConnectionMatches(target: PushTarget): void {
		assertTargetOwner(target, this.connections);
	}

	async deleteTarget(id: string): Promise<boolean> {
		const removed = await this.runScoped("targets", async () => {
			const idx = this.targets.findIndex((t) => t.id === id);
			if (idx < 0) return false;
			const target = this.targets[idx] as PushTarget;
			if (target.managedBy === "connection") {
				throw new ConfigValidationError(
					"targets",
					{ id, message: "managed target cannot be deleted directly" },
					`target ${id} is managed by its connection and cannot be deleted directly`,
				);
			}
			const next = this.targets.filter((_, i) => i !== idx);
			await atomicWriteJson(this.path("targets"), next);
			this.targets = next;
			this.touch("targets");
			return true;
		});
		if (!removed) return false;
		const subscriptionsChanged = await this.runScoped("subscriptions", async () => {
			const cleaned = removeTargetIdsFromSubscriptions(this.subscriptions, [id]);
			if (!cleaned.changed) return false;
			await atomicWriteJson(this.path("subscriptions"), cleaned.next);
			this.subscriptions = cleaned.next;
			this.touch("subscriptions");
			return true;
		});
		this.bus.emit("config-changed", "targets");
		if (subscriptionsChanged) this.bus.emit("config-changed", "subscriptions");
		return removed;
	}

	/**
	 * 整体替换若干配置分区 —— **恢复备份与一次性迁移走这条路**,别再伪装成一串用户编辑。
	 *
	 * 逐条 upsert/delete 的老写法有两处治不好的病:
	 * ① 它会撞上专为用户设的守卫(webhook 目标不许手工创建),而恢复送回来的恰恰是系统
	 *    自己生成的那条;
	 * ② 中途失败时前面的分区**已经落盘**,配置只剩半新半旧 —— 订阅引用着从未创建的
	 *    target id,而原状态已被覆盖,用户连退回去都做不到。
	 *
	 * 这里分两步:**先把所有分区校验完(一个字节都不写)**,再落盘。落盘顺序是三个数组
	 * 先写(可回滚)、globals 最后写(`writeGlobals` 自带密钥袋回滚);数组写之前各留一份
	 * `.bak`,任何一步炸了就拿它们推回去。
	 *
	 * 缺席的分区保持不动。返回真正改过的 scope。
	 */
	async replaceSections(next: ConfigSections): Promise<ConfigScope[]> {
		const changed = await this.runAllScopes(async () => {
			// ---- 1) 校验:任一分区不过就整个中止,不写任何东西 ----------------
			let globals: GlobalConfig | undefined;
			if (next.globals !== undefined) {
				const r = GlobalConfigSchema.safeParse(next.globals);
				if (!r.success) throw new ConfigValidationError("globals", r.error.issues);
				globals = r.data;
			}
			const subscriptions = next.subscriptions && parseAll("subscriptions", next.subscriptions);
			const connections = next.connections && parseAll("connections", next.connections);
			const targets = next.targets && parseAll("targets", next.targets);

			// ---- 2) 跨分区不变式 + 托管目标归一化(与 load() 同一套) ----------
			const effConnections = connections ?? this.connections;
			const effTargets = targets ?? this.targets;
			const effSubs = subscriptions ?? this.subscriptions;
			for (const t of effTargets) assertTargetOwner(t, effConnections);
			const synced = syncManagedWebhookTargets(effConnections, effTargets);
			const replaced = replaceTargetIdsInSubscriptions(effSubs, synced.aliases);

			// ---- 3) 落盘:数组先写(留 .bak),globals 最后写 -------------------
			const writes: Array<[ConfigScope, unknown]> = [];
			if (subscriptions || replaced.changed) writes.push(["subscriptions", replaced.next]);
			if (connections) writes.push(["connections", effConnections]);
			if (targets || synced.changed) writes.push(["targets", synced.next]);

			const backups: Array<[string, string]> = [];
			for (const [scope] of writes) {
				const path = this.path(scope);
				if (!(await fileExists(path))) continue;
				const bak = `${path}.bak`;
				await copyFile(path, bak);
				backups.push([path, bak]);
			}
			try {
				for (const [scope, value] of writes) await atomicWriteJson(this.path(scope), value);
				if (globals) await this.writeGlobals(globals);
			} catch (e) {
				for (const [path, bak] of backups) await copyFile(bak, path).catch(() => {});
				throw e;
			} finally {
				for (const [, bak] of backups) await rm(bak, { force: true }).catch(() => {});
			}

			// ---- 4) 双写都成了才更新内存 -----------------------------------
			const touched: ConfigScope[] = [];
			if (subscriptions || replaced.changed) {
				this.subscriptions = replaced.next;
				this.touch("subscriptions");
				touched.push("subscriptions");
			}
			if (connections) {
				this.connections = effConnections;
				this.touch("connections");
				touched.push("connections");
			}
			if (targets || synced.changed) {
				this.targets = synced.next;
				this.touch("targets");
				touched.push("targets");
			}
			if (globals) {
				this.touch("globals");
				touched.push("globals");
			}
			return touched;
		});
		for (const scope of changed) this.bus.emit("config-changed", scope);
		return changed;
	}

	// ---- internals ------------------------------------------------------

	/**
	 * 一次拿住全部四把 scope 锁。顺序固定(globals → subscriptions → connections →
	 * targets),别的调用方一次只拿一把,所以不会死锁。
	 */
	private runAllScopes<T>(task: () => Promise<T>): Promise<T> {
		return this.runScoped("globals", () =>
			this.runScoped("subscriptions", () =>
				this.runScoped("connections", () => this.runScoped("targets", task)),
			),
		);
	}

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

function parseAll(scope: "subscriptions", items: readonly Subscription[]): Subscription[];
function parseAll(scope: "connections", items: readonly Connection[]): Connection[];
function parseAll(scope: "targets", items: readonly PushTarget[]): PushTarget[];
/**
 * 逐条重新校验一个分区。入参虽然带着类型,但它来自备份文件 / 磁盘 JSON —— 那个类型
 * 是句谎话,运行期必须自己验一遍。报错带下标,跟 load() 的口径一致。
 */
function parseAll(scope: ConfigScope, items: readonly unknown[]): unknown[] {
	const schema =
		scope === "subscriptions"
			? SubscriptionSchema
			: scope === "connections"
				? ConnectionSchema
				: PushTargetSchema;
	return items.map((item, idx) => {
		const r = schema.safeParse(item);
		if (!r.success) {
			throw new ConfigValidationError(
				scope,
				{ index: idx, issues: r.error.issues },
				`${scope}[${idx}] failed schema validation`,
			);
		}
		return r.data;
	});
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
