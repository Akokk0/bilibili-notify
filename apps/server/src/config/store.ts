import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
	type BiliSubscription,
	BiliSubscriptionSchema,
	type ConfigScope,
	type Connection,
	ConnectionSchema,
	createSerialQueue,
	DEFAULT_MESSAGE_LAYOUT,
	type Disposable,
	deterministicUuid,
	EXTRA_KEYS,
	type ExtensionSubscription,
	ExtensionSubscriptionSchema,
	type GlobalConfig,
	GlobalConfigSchema,
	isBiliSubscription,
	isExtensionSubscription,
	isWebhookConnection,
	type MessageBus,
	makeDefaultGlobalConfig,
	normalizeMessageLayout,
	type PushTarget,
	PushTargetSchema,
	type ServiceContext,
	type Subscription,
	SubscriptionSchema,
} from "@bilibili-notify/internal";
import { atomicWriteFile, atomicWriteJson } from "@bilibili-notify/storage";
import type { z } from "zod";
import { dataPath } from "../runtime/roots.js";
import { applyAiSecrets, collectAiSecrets, stripAiSecrets } from "./ai-secrets.js";
import type { BootstrapConfig } from "./schema.js";
import type { ConfigSecrets, SecretStore } from "./secret-store.js";
import { ConfigValidationError } from "./validation-error.js";

/**
 * ConfigStore — central runtime config holder.
 *
 * Stage 2.2: implements the runtime-write layer for globals / subscriptions /
 * targets, persisted as JSON under `<dataRoot>/state/` with atomic-rename writes.
 * Every successful write emits `'config-changed'` on the MessageBus carrying the
 * affected scope. A per-scope FIFO queue serializes concurrent writes so two
 * PATCHes on the same scope can never interleave their read-modify-write pair.
 *
 * Secrets layer: when a `SecretStore` is injected, the AI apiKey is lifted out
 * of `globals.json` into `<dataRoot>/secrets/config-secrets.enc` (AES-256-GCM via
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
	/** 只拷命中的那一条 —— 入站热路径按 id 校验归属用,别拿 getConnections() 再 find。 */
	getConnection(id: string): Connection | undefined;
	getTargets(): PushTarget[];

	getGlobalsMeta(): ConfigScopeMeta;
	getSubscriptionsMeta(): ConfigScopeMeta;
	getTargetsMeta(): ConfigScopeMeta;

	// --- writes -----------------------------------------------------------
	setGlobals(next: GlobalConfig): Promise<void>;
	patchGlobals(patch: DeepPartial<GlobalConfig>): Promise<GlobalConfig>;
	/**
	 * 在 globals 那条排队里「读当前 → 算新值 → 校验 → 落盘」一气做完 —— 「先看一眼再决定写什么」
	 * 的写入(比对版本号再写)走这里。队外先读后写的话,读与写之间的那一发会从缝里溜过去。
	 *
	 * `update` 拿到的是当前那份的**深拷贝**,改好交回整份;它抛了就整次作废、一个字都不落盘,
	 * 那一发原样交回调用方。详见实现处的注释。
	 */
	updateGlobals(update: (current: GlobalConfig) => GlobalConfig): Promise<GlobalConfig>;
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

	/**
	 * 关停:先等在途与已排队的写全部落盘,再关门 —— 此后的写一律以 `SerialQueueClosedError` 拒绝、不碰盘。
	 * 关停的 `flush` 段调它;返回以后数据目录里的 `state/` 不会再有本店的写入。
	 */
	close(): Promise<void>;
}

export interface CreateConfigStoreOptions {
	bootstrap: BootstrapConfig;
	/** 数据根:设置、订阅、连接、目标这些 JSON 住在它底下的 `state/`。 */
	dataRoot: string;
	bus: MessageBus;
	serviceCtx: ServiceContext;
	/** Where globals/subs/targets JSON files live. Defaults to `<dataRoot>/state`. */
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

// 一次配置写入被拒:类在 validation-error.ts(自带标准码与中文话,路由按码回、不嗅文案)。
// 这里再导出一遍,别处 `import { ConfigValidationError } from "../config/store.js"` 照旧。
export { ConfigValidationError };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ScopeMetaInternal {
	exists: boolean;
	lastUpdatedAt: string | null;
}

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

/**
 * 整份字节拷贝(留 `.bak` / 从 `.bak` 退回用):读出来再原子写到目标,拷到一半断电不会留下
 * 半份 `.bak`。权限跟着源文件走 —— 连接里有 token,不能因为备份放宽。
 */
async function copyFileAtomic(from: string, to: string): Promise<void> {
	const { mode } = await stat(from);
	await atomicWriteFile(to, await readFile(from), { mode: mode & 0o777 });
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

/** 读一个 JSON 文件;不存在回 `undefined`,**不替它建**(与 {@link readJsonOrInit} 的区别)。 */
async function readJsonIfExists(absPath: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(absPath, "utf8")) as unknown;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw err;
	}
}

/**
 * 盘上一个订阅文件 → 一份订阅。不是数组、或任何一行过不了 schema,都整个拒(开机报错)。
 * 两个文件各用各的那一支校验:`subscriptions.json` 里混进一行拓展订阅同样是坏数据。
 */
function parseSubscriptionFile<T extends Subscription>(
	fileName: string,
	value: unknown,
	schema: z.ZodType<T>,
): T[] {
	if (!Array.isArray(value)) {
		throw ConfigValidationError.invalid("subscriptions", `${fileName} 里的内容不是数组`);
	}
	return value.map((raw, idx) => {
		const r = schema.safeParse(raw);
		if (!r.success) {
			throw ConfigValidationError.fromZod("subscriptions", r.error, {
				subject: `${fileName} 第 ${idx + 1} 行`,
				prefix: [idx],
			});
		}
		return r.data;
	});
}

async function fileExists(absPath: string): Promise<boolean> {
	try {
		await stat(absPath);
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw err;
	}
}

/**
 * 连接的**身份轴**不许改 —— 换 `kind` 或换 `platform` 都等于换了另一条连接,而目标还
 * 挂在原来那个 id 上。允许改的话,「onebot 群目标」会一夜之间挂在一条飞书连接下面。
 *
 * 🔴 **两支都比 platform。** 拓展那一支曾经没有这一格(那时它是「一条桥接入」,驮着 N 个
 * 平台的 bot,ADR-0012 决策 27),于是这里对它整个早退;改成「一条连接 = 一个借来的 bot」
 * (决策 45)之后它有了,而早退没跟着改 —— 症状是把一条桥连接从 QQ bot 换成 telegram bot
 * 能存下去,底下的 QQ 群目标平台原地不动,投递却跑去了 telegram。
 */
function assertConnectionIdentityStable(current: Connection, next: Connection): void {
	if (current.kind !== next.kind) {
		throw ConfigValidationError.invalid(
			"connections",
			`连接的类型不能改（${current.kind} → ${next.kind}），要换就删了重建`,
			[{ path: ["kind"], message: "身份格不许改" }],
		);
	}
	if (current.platform !== next.platform) {
		throw ConfigValidationError.invalid(
			"connections",
			`连接的平台不能改（${current.platform} → ${next.platform}），要换就删了重建`,
			[{ path: ["platform"], message: "身份格不许改" }],
		);
	}
}

/**
 * 「这条连接不存在」在投递结果里的那一句。
 *
 * 🔴 **它落盘**:`sink/multiplex.ts` 拿它填 `DeliveryResult.err`,历史每条消息的 `err` 里存的就是它
 * (盘上存的失败字段随改盘上形状的那一期带迁移条目改,不在这里动)。配置写入这边不用它 ——
 * 找不到连接是 `ConfigValidationError` 的 `not_found` 码,路由按码回,不嗅文案。
 */
export const CONNECTION_NOT_FOUND = "connection not found";

/**
 * 目标与它挂着的那条连接对不对得上 —— 连接存在,且平台是同一个。
 *
 * 逐条 upsert 与整体 replaceSections 都走这一份:同一条不变式抄两遍,总有一天只改了
 * 一边(而那两条路上「半新半旧的配置」代价完全一样)。
 *
 * 🔴 **拓展那一支同样比平台。** 它曾经没有 `platform`(那时一条连接是「一条驮着 N 个
 * 平台的桥接入」,ADR-0012 决策 27),于是这里对它整个早退;改成「一条连接 = 一个借来的
 * bot」(决策 45)之后它有了,面板建目标时也正是从连接上抄的这一格 —— 早退留着,就等于
 * 「目标写着 onebot、连接却是 telegram」能存下去,而错要到发第一条推送时才现形。
 */
function assertTargetOwner(target: PushTarget, connections: readonly Connection[]): void {
	const owner = connections.find((a) => a.id === target.connectionId);
	if (!owner) {
		throw ConfigValidationError.invalid(
			"targets",
			`推送目标挂着的连接不存在（connectionId=${target.connectionId}）`,
			[{ path: ["connectionId"], message: "没有这条连接" }],
		);
	}
	if (owner.platform !== target.platform) {
		throw ConfigValidationError.invalid(
			"targets",
			`推送目标的平台（${target.platform}）和它挂着的连接（${owner.platform}）对不上`,
			[{ path: ["platform"], message: "要和连接的平台一致" }],
		);
	}
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

		// 附加项的 per-目标 三态表跟着 routing 一起清 —— schema 强制它的 key ⊆ 主特性目标。
		const extras = { ...sub.extras };
		for (const key of EXTRA_KEYS) {
			const kept = Object.entries(extras[key]).filter(([id]) => !ids.has(id));
			if (kept.length === Object.keys(extras[key]).length) continue;
			extras[key] = Object.fromEntries(kept);
			subChanged = true;
		}
		if (!subChanged) return sub;
		changed = true;
		return { ...sub, routing, extras };
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

		const extras = { ...sub.extras };
		for (const key of EXTRA_KEYS) {
			const group = { ...extras[key] };
			let groupChanged = false;
			for (const [from, to] of aliases) {
				if (!(from in group)) continue;
				const value = group[from];
				if (!(to in group) && value !== undefined) group[to] = value;
				delete group[from];
				groupChanged = true;
				subChanged = true;
			}
			if (groupChanged) extras[key] = group;
		}
		if (!subChanged) return sub;
		changed = true;
		return { ...sub, routing, extras };
	});
	return { next, changed };
}

/** 拓展订阅住的那个文件(ADR-0019 决策 47)。B 站订阅仍在 `subscriptions.json`。 */
export const EXTENSION_SUBSCRIPTIONS_FILE = "extension-subscriptions.json";

/**
 * B 站订阅落盘的样子:**剥掉 `kind`**。`subscriptions.json` 的形状与旧载荷写出来的一字不差
 * (决策 47:「B 站那支一个字不动」)—— 回退到旧载荷时它读到的就是它自己写的东西。读回来
 * 缺 `kind` 就是 B 站,schema 会补上。
 */
function toDiskBiliRow(sub: BiliSubscription): Omit<BiliSubscription, "kind"> {
	const { kind: _kind, ...row } = sub;
	return row;
}

/** 一个分区变没变:条数、或任何一格换了对象。级联那几个函数对没动的行原样交回同一个对象。 */
function partitionChanged<T>(prev: readonly T[], next: readonly T[]): boolean {
	return prev.length !== next.length || next.some((item, i) => item !== prev[i]);
}

/** 订阅的身份几格(决策 50):B 站是 uid,拓展是 `(extensionId, externalId)`;`kind` 本身也算。 */
const SUBSCRIPTION_IDENTITY_KEYS = ["kind", "uid", "extensionId", "externalId"] as const;

/** 拼进给人看的话里的一个值:字符串原样,别的转 JSON,没有就说「空」。 */
function showValue(v: unknown): string {
	if (typeof v === "string") return v;
	return v === undefined ? "空" : (JSON.stringify(v) ?? "空");
}

function subscriptionIdentityError(key: string, from: unknown, to: unknown): ConfigValidationError {
	return ConfigValidationError.invalid(
		"subscriptions",
		`订阅的 ${key} 不能改（${showValue(from)} → ${showValue(to)}），要换人就删了重加`,
		[{ path: [key], message: "身份格不许改" }],
	);
}

/**
 * 订阅的**身份**不许改(ADR-0019 决策 50)—— 换了 uid / 外部 id / 平台就是另一个人,而运行期
 * 的一切(资料缓存、历史、头像文件)都挂在这条订阅的 `id` 上。要换人就删了重加。
 *
 * 看的是调用方送来的那一份(补丁或整条),**在 schema 之前**:给 B 站订阅送一个 `extensionId`、
 * 给拓展订阅送一个 `uid`,schema 会一声不吭地剥掉 —— 那也是想改身份,照样拒;而把 `kind`
 * 清掉的补丁会先在 schema 那儿撞成一堆「缺 uid」,主人看不出是哪一格惹的。值与现有的一样
 * (面板整份送回来)不算改。`kind` 在整条 upsert 里缺省 = B 站,在补丁里缺省 = 不改。
 */
function assertSubscriptionIdentityUnchanged(
	current: Subscription,
	raw: unknown,
	kindDefault: "bilibili" | undefined,
): void {
	const cur = current as Record<string, unknown>;
	const fields = isPlainObject(raw) ? raw : {};
	for (const key of SUBSCRIPTION_IDENTITY_KEYS) {
		const sent = key === "kind" && !("kind" in fields) ? kindDefault : fields[key];
		if (sent === undefined || sent === cur[key]) continue;
		throw subscriptionIdentityError(key, cur[key], sent);
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
	private readonly secretStore?: SecretStore;
	private secretBag: ConfigSecrets = {};
	/** P2:明文 apiKey 告警只打一次(避免每次写盘刷屏)。 */
	private plaintextApiKeyWarned = false;

	private globals: GlobalConfig;
	/**
	 * 订阅在内存里是**一份**联合列表(决策 47),盘上是两个文件 —— 所以分两格存,读的时候拼:
	 * B 站那几行在前、拓展的在后,各按文件里的顺序。写一律走 {@link writeSubscriptions}。
	 */
	private biliSubscriptions: BiliSubscription[];
	private extensionSubscriptions: ExtensionSubscription[];
	private connections: Connection[];
	private targets: PushTarget[];

	private readonly meta: Record<ConfigScope, ScopeMetaInternal> = {
		globals: { exists: false, lastUpdatedAt: null },
		subscriptions: { exists: false, lastUpdatedAt: null },
		connections: { exists: false, lastUpdatedAt: null },
		targets: { exists: false, lastUpdatedAt: null },
		secrets: { exists: false, lastUpdatedAt: null },
	};

	/** 写道:键 = scope,同一个 scope 的写排成一队,不同 scope 互不等待。关停时由 {@link close} 关门。 */
	private readonly writes = createSerialQueue();

	private loaded = false;

	constructor(opts: CreateConfigStoreOptions) {
		this.bootstrap = opts.bootstrap;
		this.bus = opts.bus;
		this.serviceCtx = opts.serviceCtx;
		this.stateDir = opts.stateDir ?? dataPath(opts.dataRoot, ...CONFIG_DIR);
		this.secretStore = opts.secretStore;
		// Initialize with safe defaults; `load()` overwrites.
		this.globals = makeDefaultGlobalConfig();
		this.biliSubscriptions = [];
		this.extensionSubscriptions = [];
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

	/** 两个文件拼成的那一份联合列表(只读视图;写走 {@link writeSubscriptions})。 */
	private get subscriptions(): Subscription[] {
		return [...this.biliSubscriptions, ...this.extensionSubscriptions];
	}

	private extensionSubscriptionsPath(): string {
		return join(this.stateDir, EXTENSION_SUBSCRIPTIONS_FILE);
	}

	/**
	 * 把一份新的联合列表落盘并换进内存。**只写真的变了的那个文件**:改一条 B 站订阅不会
	 * 重写、更不会凭空建出 `extension-subscriptions.json`(旧载荷不认得它,多一份也无妨,
	 * 但没有理由去碰)。
	 *
	 * 两个文件不是一次原子写:两个都要写而后一个炸了,把前一个推回原样再抛,盘上不留
	 * 半新半旧。调用方都在 `subscriptions` 那条队里。
	 */
	private async writeSubscriptions(next: readonly Subscription[]): Promise<void> {
		const bili = next.filter(isBiliSubscription);
		const ext = next.filter(isExtensionSubscription);
		const biliChanged = partitionChanged(this.biliSubscriptions, bili);
		const extChanged = partitionChanged(this.extensionSubscriptions, ext);
		if (biliChanged) await atomicWriteJson(this.path("subscriptions"), bili.map(toDiskBiliRow));
		if (extChanged) {
			try {
				await atomicWriteJson(this.extensionSubscriptionsPath(), ext);
			} catch (e) {
				if (biliChanged) {
					await atomicWriteJson(
						this.path("subscriptions"),
						this.biliSubscriptions.map(toDiskBiliRow),
					).catch(() => {});
				}
				throw e;
			}
		}
		this.biliSubscriptions = bili;
		this.extensionSubscriptions = ext;
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
				throw ConfigValidationError.fromZod("globals", parsed.error, { subject: "globals.json" });
			}
			this.globals = parsed.data;
			this.meta.globals.exists = true;
			this.meta.globals.lastUpdatedAt = existed ? null : new Date().toISOString();

			// 迁移此前保存的卡片版式到当前块模型(例如把各块上下间距从模版回填进
			// layout)。normalizeCardLayout 按版本门控,已是最新的版式原样通过。
			// ⚠️ 旧版式已是可选键(ADR-0014 决策 15,迁移跑完就删掉):**键不在就别补回来**,
			// 补一份等于把「已经迁过了」的记号抹掉,下次开机会再折一套派生皮肤。
			// 消息版式:未知块丢弃、缺失的内置块追加,老存档前向兼容。(卡片版式那一份已随
			// 旧版式整个退役 —— 见 ADR-0014 决策 17 的 2026-09-18 🔗。)
			this.globals = {
				...this.globals,
				defaults: {
					...this.globals.defaults,
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
			// packages/internal/src/schema/__tests__/ai-persona-pointer.test.ts。

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

		// subscriptions —— 两个文件,一个分区(决策 47)。任何一个读坏了都是开机报错:跳过坏行
		// 更糟,下次写回那几行就永久没了。
		{
			const { value, existed } = await readJsonOrInit<unknown[]>(
				this.path("subscriptions"),
				() => [] as Subscription[],
			);
			this.biliSubscriptions = parseSubscriptionFile(
				"subscriptions.json",
				value,
				BiliSubscriptionSchema,
			);
			// 拓展订阅那份不存在 = 一条都没有。**不在这里建它**:没有拓展订阅的机器上,盘上
			// 就和旧载荷那时一模一样。
			const extRaw = await readJsonIfExists(this.extensionSubscriptionsPath());
			this.extensionSubscriptions =
				extRaw === undefined
					? []
					: parseSubscriptionFile(
							EXTENSION_SUBSCRIPTIONS_FILE,
							extRaw,
							ExtensionSubscriptionSchema,
						);
			this.meta.subscriptions.exists = true;
			this.meta.subscriptions.lastUpdatedAt = existed ? null : new Date().toISOString();
		}

		// connections + targets (with one-time migration from the legacy single-file
		// targets.json that bundled connection+session into `config`)
		await this.loadConnectionsAndTargets();

		this.loaded = true;
		this.serviceCtx.logger.info(
			`config-store loaded (stateDir=${this.stateDir} subs=${this.subscriptions.length} connections=${this.connections.length} targets=${this.targets.length})`,
		);
	}

	/**
	 * 读 connections.json + targets.json。只认最新的形状:0.x 各个版本的形状(`adapters.json`、最老的单文件
	 * `targets.json`、v1 的连接 / 目标、已撤下平台的存量)由迁移器在开新代时改写好(`migration/connections.ts`)。
	 * 任何一条过不了 schema 都整个拒(开机报错),不静默丢。
	 */
	private async loadConnectionsAndTargets(): Promise<void> {
		if (!(await fileExists(this.path("connections")))) {
			const targetsRaw = await readJsonIfExists(this.path("targets"));
			if (targetsRaw !== undefined && !Array.isArray(targetsRaw)) {
				throw ConfigValidationError.invalid("targets", "targets.json 里的内容不是数组");
			}
			// 目标还在、连接没了:不凭空造连接,让主人看见。
			if (Array.isArray(targetsRaw) && targetsRaw.length > 0) {
				throw ConfigValidationError.invalid(
					"connections",
					"connections.json 不见了，但 targets.json 里还有目标，连接没法凭空重建",
				);
			}
			// 全新安装。
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

		const connectionsRaw = JSON.parse(await readFile(this.path("connections"), "utf8"));
		if (!Array.isArray(connectionsRaw)) {
			throw ConfigValidationError.invalid("connections", "connections.json 里的内容不是数组");
		}
		const { value: targetsRaw, existed } = await readJsonOrInit<unknown[]>(
			this.path("targets"),
			() => [] as PushTarget[],
		);
		if (!Array.isArray(targetsRaw)) {
			throw ConfigValidationError.invalid("targets", "targets.json 里的内容不是数组");
		}

		this.connections = connectionsRaw.map((raw, idx) => {
			const r = ConnectionSchema.safeParse(raw);
			if (!r.success) {
				throw ConfigValidationError.fromZod("connections", r.error, {
					subject: `connections.json 第 ${idx + 1} 行`,
					prefix: [idx],
				});
			}
			return r.data;
		});
		this.meta.connections.exists = true;

		const targets = targetsRaw.map((raw, idx) => {
			const r = PushTargetSchema.safeParse(raw);
			if (!r.success) {
				throw ConfigValidationError.fromZod("targets", r.error, {
					subject: `targets.json 第 ${idx + 1} 行`,
					prefix: [idx],
				});
			}
			return r.data;
		});
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
			await this.writeSubscriptions(replaced.next);
			this.touch("subscriptions");
		}
	}

	// ---- read accessors -------------------------------------------------

	onChange(handler: (scope: ConfigScope) => void): Disposable {
		return this.bus.on("config-changed", ({ scope }) => handler(scope));
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

	getConnection(id: string): Connection | undefined {
		const hit = this.connections.find((connection) => connection.id === id);
		return hit ? deepClone(hit) : undefined;
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
				throw ConfigValidationError.fromZod("globals", parsed.error);
			}
			await this.writeGlobals(parsed.data);
			this.touch("globals");
		});
		this.bus.emit("config-changed", { scope: "globals" });
	}

	async patchGlobals(patch: DeepPartial<GlobalConfig>): Promise<GlobalConfig> {
		const result = await this.runScoped("globals", async () => {
			const merged = deepMerge(this.globals, patch);
			const parsed = GlobalConfigSchema.safeParse(merged);
			if (!parsed.success) {
				throw ConfigValidationError.fromZod("globals", parsed.error);
			}
			await this.writeGlobals(parsed.data);
			this.touch("globals");
			return parsed.data;
		});
		this.bus.emit("config-changed", { scope: "globals" });
		return deepClone(result);
	}

	/**
	 * 🔴 `update` 是**同步**的:队里只做比对与拼装,不跑别人的代码。这条队是全部 globals 写入共用的,
	 * 慢的校验(拓展自己那份 zod 是异步的、还可能挂住)要放在队外先做好,再到队里按版本号比对一次
	 * —— 写成 async 的话,一个挂住的校验会让之后所有的全局设置都存不进去。
	 */
	async updateGlobals(update: (current: GlobalConfig) => GlobalConfig): Promise<GlobalConfig> {
		const result = await this.runScoped("globals", async () => {
			const parsed = GlobalConfigSchema.safeParse(update(deepClone(this.globals)));
			if (!parsed.success) {
				throw ConfigValidationError.fromZod("globals", parsed.error);
			}
			await this.writeGlobals(parsed.data);
			this.touch("globals");
			return parsed.data;
		});
		this.bus.emit("config-changed", { scope: "globals" });
		return deepClone(result);
	}

	async upsertSubscription(sub: Subscription): Promise<void> {
		await this.runScoped("subscriptions", async () => {
			const parsed = SubscriptionSchema.safeParse(sub);
			if (!parsed.success) {
				throw ConfigValidationError.fromZod("subscriptions", parsed.error);
			}
			const existing = this.subscriptions.find((s) => s.id === parsed.data.id);
			if (existing) assertSubscriptionIdentityUnchanged(existing, sub, "bilibili");
			await this.writeSubscriptions(upsertById(this.subscriptions, parsed.data));
			this.touch("subscriptions");
		});
		this.bus.emit("config-changed", { scope: "subscriptions" });
	}

	async patchSubscription(id: string, patch: DeepPartial<Subscription>): Promise<Subscription> {
		const result = await this.runScoped("subscriptions", async () => {
			const idx = this.subscriptions.findIndex((s) => s.id === id);
			if (idx < 0) {
				throw ConfigValidationError.notFound("subscriptions", `没有 id 为 ${id} 的订阅`);
			}
			const current = this.subscriptions[idx] as Subscription;
			// 补丁里没提的身份格就是「不改」,所以 kind 缺省不补。
			assertSubscriptionIdentityUnchanged(current, patch, undefined);
			const merged = deepMerge(current, { ...patch, id });
			const parsed = SubscriptionSchema.safeParse(merged);
			if (!parsed.success) {
				throw ConfigValidationError.fromZod("subscriptions", parsed.error);
			}
			const next = [...this.subscriptions];
			next[idx] = parsed.data;
			await this.writeSubscriptions(next);
			this.touch("subscriptions");
			return parsed.data;
		});
		this.bus.emit("config-changed", { scope: "subscriptions" });
		return deepClone(result);
	}

	async deleteSubscription(id: string): Promise<boolean> {
		const removed = await this.runScoped("subscriptions", async () => {
			const idx = this.subscriptions.findIndex((s) => s.id === id);
			if (idx < 0) return false;
			await this.writeSubscriptions(this.subscriptions.filter((_, i) => i !== idx));
			this.touch("subscriptions");
			return true;
		});
		if (removed) this.bus.emit("config-changed", { scope: "subscriptions" });
		return removed;
	}

	/**
	 * 一条连接落盘之后的**连带账**:托管的 webhook 目标跟着同步、目标换 id 时订阅里的
	 * 引用跟着改写,最后按「这一轮到底动了哪几个分区」发事件。
	 *
	 * upsert 与 patch 共用这一份 —— 两处各抄一遍的话,加一个连带分区时总会漏掉一边,
	 * 而症状是「改连接时同步了、打补丁时没同步」这种只有真机才露馅的分叉。
	 */
	private async syncWebhookSideEffects(connection: Connection): Promise<void> {
		let targetAliases = new Map<string, string>();
		const targetsChanged = isWebhookConnection(connection)
			? await this.runScoped("targets", async () => {
					const synced = syncManagedWebhookTarget(connection, this.targets);
					targetAliases = synced.aliases;
					if (!synced.changed) return false;
					await atomicWriteJson(this.path("targets"), synced.next);
					this.targets = synced.next;
					this.touch("targets");
					return true;
				})
			: false;
		const subscriptionsChanged = await this.replaceSubscriptionTargetAliases(targetAliases);
		this.bus.emit("config-changed", { scope: "connections" });
		if (targetsChanged) this.bus.emit("config-changed", { scope: "targets" });
		if (subscriptionsChanged) this.bus.emit("config-changed", { scope: "subscriptions" });
	}

	async upsertConnection(connection: Connection): Promise<void> {
		const saved = await this.runScoped("connections", async () => {
			const parsed = ConnectionSchema.safeParse(connection);
			if (!parsed.success) {
				throw ConfigValidationError.fromZod("connections", parsed.error);
			}
			const existing = this.connections.find((a) => a.id === parsed.data.id);
			if (existing) assertConnectionIdentityStable(existing, parsed.data);
			const next = upsertById(this.connections, parsed.data);
			await atomicWriteJson(this.path("connections"), next);
			this.connections = next;
			this.touch("connections");
			return parsed.data;
		});
		await this.syncWebhookSideEffects(saved);
	}

	async patchConnection(id: string, patch: DeepPartial<Connection>): Promise<Connection> {
		const result = await this.runScoped("connections", async () => {
			const idx = this.connections.findIndex((a) => a.id === id);
			if (idx < 0) {
				throw ConfigValidationError.notFound("connections", `没有 id 为 ${id} 的连接`);
			}
			const current = this.connections[idx] as Connection;
			const merged = deepMerge(current, { ...patch, id });
			const parsed = ConnectionSchema.safeParse(merged);
			if (!parsed.success) {
				throw ConfigValidationError.fromZod("connections", parsed.error);
			}
			assertConnectionIdentityStable(current, parsed.data);
			const next = [...this.connections];
			next[idx] = parsed.data;
			await atomicWriteJson(this.path("connections"), next);
			this.connections = next;
			this.touch("connections");
			return parsed.data;
		});
		await this.syncWebhookSideEffects(result);
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
				throw ConfigValidationError.conflict(
					"connections",
					`这条连接还被 ${referencing.length} 个推送目标用着，先解除引用再删`,
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
				await this.writeSubscriptions(cleaned.next);
				this.touch("subscriptions");
				return true;
			});
		}

		this.bus.emit("config-changed", { scope: "connections" });
		if (targetsChanged) this.bus.emit("config-changed", { scope: "targets" });
		if (subscriptionsChanged) this.bus.emit("config-changed", { scope: "subscriptions" });
		return true;
	}

	async upsertTarget(target: PushTarget): Promise<void> {
		let targetAliases: ReadonlyMap<string, string> = new Map();
		await this.runScoped("targets", async () => {
			const parsed = PushTargetSchema.safeParse(target);
			if (!parsed.success) {
				throw ConfigValidationError.fromZod("targets", parsed.error);
			}
			assertTargetOwner(parsed.data, this.connections);
			// endpoint 目标是连接的派生物,不接受外部凭空创建 —— 但**备份恢复送回来的那条
			// 是它自己**:导出走 getTargets(),必然带上托管 target。所以放行的判据是 managedBy,
			// 光看形态会把它一起挡掉,任何含 webhook 连接的备份都恢复不了(而恢复是逐条 await
			// 的,炸在这一步时 globals / 订阅 / 连接已经落盘,配置只剩半新半旧)。
			if (parsed.data.kind === "endpoint" && parsed.data.managedBy !== "connection") {
				throw ConfigValidationError.invalid(
					"targets",
					"webhook 目标由它的连接自动创建，不能手动新建",
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
		this.bus.emit("config-changed", { scope: "targets" });
		if (subscriptionsChanged) this.bus.emit("config-changed", { scope: "subscriptions" });
	}

	async patchTarget(id: string, patch: DeepPartial<PushTarget>): Promise<PushTarget> {
		const result = await this.runScoped("targets", async () => {
			const idx = this.targets.findIndex((t) => t.id === id);
			if (idx < 0) {
				throw ConfigValidationError.notFound("targets", `没有 id 为 ${id} 的推送目标`);
			}
			const current = this.targets[idx] as PushTarget;
			if (current.kind === "endpoint" && current.managedBy === "connection") {
				throw ConfigValidationError.conflict(
					"targets",
					"这个推送目标由它的连接托管，不能直接改，改它的连接就行",
				);
			}
			const merged = deepMerge(current, { ...patch, id });
			const parsed = PushTargetSchema.safeParse(merged);
			if (!parsed.success) {
				throw ConfigValidationError.fromZod("targets", parsed.error);
			}
			assertTargetOwner(parsed.data, this.connections);
			const next = [...this.targets];
			next[idx] = parsed.data;
			await atomicWriteJson(this.path("targets"), next);
			this.targets = next;
			this.touch("targets");
			return parsed.data;
		});
		this.bus.emit("config-changed", { scope: "targets" });
		return deepClone(result);
	}

	async recordTargetTestStatus(id: string, status: PushTarget["testStatus"]): Promise<PushTarget> {
		const result = await this.runScoped("targets", async () => {
			const idx = this.targets.findIndex((t) => t.id === id);
			if (idx < 0) {
				throw ConfigValidationError.notFound("targets", `没有 id 为 ${id} 的推送目标`);
			}
			const next = [...this.targets];
			next[idx] = { ...(this.targets[idx] as PushTarget), testStatus: status };
			await atomicWriteJson(this.path("targets"), next);
			this.targets = next;
			this.touch("targets");
			return next[idx] as PushTarget;
		});
		this.bus.emit("config-changed", { scope: "targets" });
		return deepClone(result);
	}

	async deleteTarget(id: string): Promise<boolean> {
		const removed = await this.runScoped("targets", async () => {
			const idx = this.targets.findIndex((t) => t.id === id);
			if (idx < 0) return false;
			const target = this.targets[idx] as PushTarget;
			if (target.managedBy === "connection") {
				throw ConfigValidationError.conflict(
					"targets",
					"这个推送目标由它的连接托管，不能直接删，删它的连接就行",
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
			await this.writeSubscriptions(cleaned.next);
			this.touch("subscriptions");
			return true;
		});
		this.bus.emit("config-changed", { scope: "targets" });
		if (subscriptionsChanged) this.bus.emit("config-changed", { scope: "subscriptions" });
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
				if (!r.success) throw ConfigValidationError.fromZod("globals", r.error);
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
			// 订阅一个分区两个文件(决策 47),各自只在那一支真变了时才写。
			const writes: Array<[string, unknown]> = [];
			const subsTouched = Boolean(subscriptions) || replaced.changed;
			const nextBili = replaced.next.filter(isBiliSubscription);
			const nextExt = replaced.next.filter(isExtensionSubscription);
			if (subsTouched && partitionChanged(this.biliSubscriptions, nextBili)) {
				writes.push([this.path("subscriptions"), nextBili.map(toDiskBiliRow)]);
			}
			if (subsTouched && partitionChanged(this.extensionSubscriptions, nextExt)) {
				writes.push([this.extensionSubscriptionsPath(), nextExt]);
			}
			if (connections) writes.push([this.path("connections"), effConnections]);
			if (targets || synced.changed) writes.push([this.path("targets"), synced.next]);

			const backups: Array<[string, string]> = [];
			// 写之前还不存在的(拓展订阅那份可能从没建过):推回去 = 删掉它,否则开机时
			// 读到的是「订阅退回去了、拓展订阅却是备份里那份」的半新半旧。
			const created: string[] = [];
			for (const [path] of writes) {
				if (!(await fileExists(path))) {
					created.push(path);
					continue;
				}
				// 🔴 **不能叫 `.bak`**:那个名字是 v1→v2 迁移留给主人的**救命原件**(「迁移错了
				// 还能自己捞回去」),而这里这份是写一半用来推回去的临时件、`finally` 里无条件
				// 删掉 —— 同名的话,恢复一次备份就把那份原件顺手抹了,没有一行日志。
				const bak = `${path}.restore.bak`;
				await copyFileAtomic(path, bak);
				backups.push([path, bak]);
			}
			try {
				for (const [path, value] of writes) await atomicWriteJson(path, value);
				if (globals) await this.writeGlobals(globals);
			} catch (e) {
				for (const [path, bak] of backups) await copyFileAtomic(bak, path).catch(() => {});
				for (const path of created) await rm(path, { force: true }).catch(() => {});
				throw e;
			} finally {
				for (const [, bak] of backups) await rm(bak, { force: true }).catch(() => {});
			}

			// ---- 4) 双写都成了才更新内存 -----------------------------------
			const touched: ConfigScope[] = [];
			if (subsTouched) {
				this.biliSubscriptions = nextBili;
				this.extensionSubscriptions = nextExt;
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
		for (const scope of changed) this.bus.emit("config-changed", { scope });
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
			await this.writeSubscriptions(replaced.next);
			this.touch("subscriptions");
			return true;
		});
	}

	private touch(scope: ConfigScope): void {
		this.meta[scope].exists = true;
		this.meta[scope].lastUpdatedAt = new Date().toISOString();
	}

	/**
	 * Per-scope FIFO queue: concurrent writes on the same scope serialize, different scopes proceed
	 * in parallel. Errors propagate to the caller without poisoning the queue. 关门之后交进来的写
	 * 以 `SerialQueueClosedError` 拒绝、一个字节都不碰盘。
	 */
	private runScoped<T>(scope: ConfigScope, task: () => Promise<T>): Promise<T> {
		return this.writes.run(scope, task);
	}

	async close(): Promise<void> {
		// 先等空再关门:`runAllScopes` 是四层嵌套的 `runScoped`,外层任务已经在跑、内层还没交进来的时候
		// 就关门的话,内层会被拒,一次恢复备份半路夭折。先 flush 把嵌套交进来的也等完,再关。
		await this.writes.flush();
		await this.writes.close();
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
			throw ConfigValidationError.fromZod(scope, r.error, { prefix: [idx] });
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

/** 主人填的设置、订阅、连接、目标所在的目录(代的布局)。 */
export const CONFIG_DIR = ["config"] as const;

export function createConfigStore(opts: CreateConfigStoreOptions): ConfigStore {
	return new NodeConfigStore(opts);
}
