import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
	type ConfigScope,
	type Connection,
	ConnectionSchema,
	createSerialQueue,
	DEFAULT_MESSAGE_LAYOUT,
	type Disposable,
	deterministicUuid,
	EXTRA_KEYS,
	ExtensionIdSchema,
	type GlobalConfig,
	GlobalConfigSchema,
	type Issue,
	isWebhookConnection,
	type MessageBus,
	makeDefaultGlobalConfig,
	normalizeMessageLayout,
	type PushTarget,
	PushTargetSchema,
	type ServiceContext,
	type Subscription,
	SubscriptionSchema,
	type SubscriptionTag,
	SubscriptionTagListSchema,
} from "@bilibili-notify/internal";
import { atomicWriteFile, atomicWriteJson } from "@bilibili-notify/storage";
import {
	findIdentityDuplicates,
	findNewIdentityDuplicates,
	type IdentityDuplicate,
} from "@bilibili-notify/subscription";
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
 * of `config/settings/core.json` into `<dataRoot>/secrets/config-secrets.enc` (AES-256-GCM via
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
	/** 各集成的设置,按集成的键;只换给了的那几份。 */
	integrations?: Record<string, unknown>;
	/** 各拓展的设置,按拓展 id;只换给了的那几个(原样存,形状归拓展自己)。 */
	extensionSettings?: Record<string, unknown>;
	subscriptions?: Subscription[];
	/**
	 * 订阅标签表(ADR-0034),与订阅住同一个文件。只给它、不给订阅时,现有订阅上挂着的、新表里没有的 id
	 * 一起剥掉;两个都给时,订阅只许挂新表里有的,否则整份拒收。
	 */
	subscriptionTags?: SubscriptionTag[];
	connections?: Connection[];
	targets?: PushTarget[];
}

/**
 * 一个集成登记进来的设置(今天只有 B 站):一个集成一个文件 `config/settings/<键>.json`(ADR-0021 决策 42 下
 * 10-01 的 🔗)。仓不认得是哪个集成,只按登记的格式读写;登记在组装处做(今天 `runtime/bootstrap.ts`,3a 起
 * `compose.ts`)。
 */
export interface IntegrationSettingsSegment<T = unknown> {
	/** 集成的键,也是文件名。不能和核心设置的顶层键同名:`/api/settings` 把它们摆在同一层。 */
	readonly key: string;
	/** 盘上那份的格式。读盘也按它,所以对存量要宽松:一格坏值让整个开机失败,比退回默认更糟。 */
	readonly schema: z.ZodType<T>;
	/**
	 * 写入前多核的一道(读盘不核),回逐格原因(路径相对这一份设置),空 = 过。`prev` 是写之前那一份(没有就是
	 * `undefined`):只核这次真改了的格子 —— 盘上留着的一格老坏值,不该挡住主人去改别的格子。
	 */
	checkWrite?(next: T, prev: T | undefined): Issue[];
}

/** 一次设置写入:核心那份的补丁、各集成那份的补丁(按集成的键),给了哪份改哪份。 */
export interface SettingsPatch {
	core?: DeepPartial<GlobalConfig>;
	integrations?: Record<string, unknown>;
}

/** 一次设置写入之后的两份(深拷贝)。 */
export interface SettingsSnapshot {
	core: GlobalConfig;
	integrations: Record<string, unknown>;
}

export interface ConfigStore {
	readonly bootstrap: BootstrapConfig;

	/** Subscribe to scope-level change notifications. Backed by MessageBus 'config-changed'. */
	onChange(handler: (scope: ConfigScope) => void): Disposable;

	// --- lifecycle --------------------------------------------------------
	load(): Promise<void>;

	// --- reads ------------------------------------------------------------
	getGlobals(): GlobalConfig;
	/** 一个登记过的集成的设置(深拷贝)。没登记过就抛:那是组装处漏了,不是数据的问题。 */
	getIntegrationSettings<T>(segment: IntegrationSettingsSegment<T>): T;
	/** 全部登记过的集成的设置,按集成的键(深拷贝)。`/api/settings` 与备份用。 */
	getAllIntegrationSettings(): Record<string, unknown>;
	/**
	 * 一个拓展存着的设置(`config/settings/extensions/<id>.json`,深拷贝、原样;形状归拓展自己那份 zod);没存过是
	 * `undefined`。
	 */
	getExtensionSettings(id: string): unknown;
	/** 全部存着的拓展设置,按拓展 id(深拷贝)。备份用。 */
	getAllExtensionSettings(): Record<string, unknown>;
	getSubscriptions(): Subscription[];
	/** 订阅标签表(ADR-0034),按表里的顺序(深拷贝)。 */
	getSubscriptionTags(): SubscriptionTag[];
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
	/**
	 * 核心与各集成的设置一起改(`/api/settings` 的 PATCH):全部校验过才写,写到一半失败推回原样。没登记过的集成键
	 * 整次拒收。与 globals 的其余写入排在同一条队里。
	 */
	patchSettings(patch: SettingsPatch): Promise<SettingsSnapshot>;
	/**
	 * 在设置那条排队里「读当前 → 算新值 → 落盘」一气做完(按版本号写拓展设置,见 `extensions/settings-io.ts`):
	 * `update` 是**同步**的、拿到深拷贝,它抛了就整次作废、一个字都不落盘。拓展 id 不合 id 的形状整次拒收 ——
	 * 它要拼进文件路径。只广播 `integration-settings`。
	 */
	updateExtensionSettings(id: string, update: (current: unknown) => unknown): Promise<unknown>;
	/** 卸载一个拓展:开关那一格与它的设置文件一起删。 */
	removeExtension(id: string): Promise<void>;
	upsertSubscription(sub: Subscription): Promise<void>;
	patchSubscription(id: string, patch: DeepPartial<Subscription>): Promise<Subscription>;
	deleteSubscription(id: string): Promise<boolean>;
	/**
	 * 整张换掉订阅标签表 —— 新建、改名、排序、删除都走它(ADR-0034)。名字去掉首尾空白后不许为空、不许重名;
	 * 新表里没有了的标签,订阅上的 id 在同一次写里一起去掉。回存下的那张表。
	 */
	replaceSubscriptionTags(tags: SubscriptionTag[]): Promise<SubscriptionTag[]>;
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
	/** Where the settings / subscriptions / connections / targets JSON files live. Defaults to `<dataRoot>/config`. */
	stateDir?: string;
	/**
	 * Encrypted bag for secret fields (currently `defaults.ai.apiKey`). When
	 * given, the apiKey is moved out of plaintext `settings/core.json` into this store
	 * (and a one-time lift migrates an existing plaintext key). When omitted the
	 * legacy behaviour (apiKey stays in settings/core.json) is preserved — used by
	 * tests and any non-secret-aware caller.
	 */
	secretStore?: SecretStore;
	/** 登记进来的各集成的设置(见 {@link IntegrationSettingsSegment})。键不能重复,也不能和核心设置的顶层键同名。 */
	integrationSettings?: readonly IntegrationSettingsSegment[];
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
	// 未改 → master.targetId 等永远清不掉)。约定 null 表清除:
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
 * persisted to `settings/core.json` when a SecretStore owns the apiKey. The live
 * in-memory `this.globals` keeps the real value (engines read it via
 * getGlobals); only the on-disk copy is stripped.
 */
/**
 * 落盘前抠掉全部 AI 密钥(每家两把)。`settings/core.json` **不加密**,漏掉任何
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

/** 盘上的订阅文件:订阅标签表与订阅住在一起(ADR-0034),删标签清引用才是一次原子写。 */
interface SubscriptionFile {
	tags: SubscriptionTag[];
	subscriptions: Subscription[];
}

/**
 * 盘上的订阅文件 → 标签表 + 一份订阅。形状不是 `{ tags, subscriptions }`、标签表不合规矩、或任何一行订阅
 * 过不了 schema,都整个拒(开机报错)。0.x 那种裸数组由迁移改形,这里不认。
 */
function parseSubscriptionFile(fileName: string, value: unknown): SubscriptionFile {
	if (!isPlainObject(value) || !Array.isArray(value.tags) || !Array.isArray(value.subscriptions)) {
		throw ConfigValidationError.invalid(
			"subscriptions",
			`${fileName} 的形状不对:应当是 { tags, subscriptions }`,
		);
	}
	const tags = SubscriptionTagListSchema.safeParse(value.tags);
	if (!tags.success) {
		throw ConfigValidationError.fromZod("subscriptions", tags.error, {
			subject: `${fileName} 的标签表`,
			prefix: ["tags"],
		});
	}
	const subscriptions = value.subscriptions.map((raw, idx) => {
		const r = SubscriptionSchema.safeParse(raw);
		if (!r.success) {
			throw ConfigValidationError.fromZod("subscriptions", r.error, {
				subject: `${fileName} 第 ${idx + 1} 行`,
				prefix: ["subscriptions", idx],
			});
		}
		return r.data;
	});
	return { tags: tags.data, subscriptions };
}

/**
 * 订阅只许挂标签表里有的标签(ADR-0034)。逐条写与整体替换都走它:面板拿着旧快照存回去,能把刚删掉的标签
 * 又写回订阅上,在写盘这一层拦。
 */
function assertKnownTags(subs: readonly Subscription[], tags: readonly SubscriptionTag[]): void {
	const known = new Set(tags.map((t) => t.id));
	const issues: Issue[] = [];
	subs.forEach((sub, idx) => {
		sub.tagIds.forEach((id, j) => {
			if (!known.has(id)) {
				issues.push({ path: [idx, "tagIds", j], message: `标签 ${id} 不在标签表里(可能刚被删掉)` });
			}
		});
	});
	if (issues.length > 0) {
		throw ConfigValidationError.invalid("subscriptions", "订阅挂了不存在的标签", issues);
	}
}

/** 去掉订阅上不在标签表里的 id;没变的订阅原样留着。`dropped` 是去掉的那些 id。 */
function withoutUnknownTags(
	subs: readonly Subscription[],
	tags: readonly SubscriptionTag[],
): { next: Subscription[]; dropped: string[] } {
	const known = new Set(tags.map((t) => t.id));
	const dropped: string[] = [];
	const next = subs.map((sub) => {
		const kept = sub.tagIds.filter((id) => known.has(id));
		if (kept.length === sub.tagIds.length) return sub;
		dropped.push(...sub.tagIds.filter((id) => !known.has(id)));
		return { ...sub, tagIds: kept };
	});
	return { next, dropped };
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
 * 🔴 **它落盘**:`push/target-dispatcher.ts` 拿它填 `DeliveryResult.err`,历史每条消息的 `err` 里存的就是它
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
		const extraTargets = { ...sub.extraTargets };
		for (const key of EXTRA_KEYS) {
			const kept = Object.entries(extraTargets[key]).filter(([id]) => !ids.has(id));
			if (kept.length === Object.keys(extraTargets[key]).length) continue;
			extraTargets[key] = Object.fromEntries(kept);
			subChanged = true;
		}
		if (!subChanged) return sub;
		changed = true;
		return { ...sub, routing, extraTargets };
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

		const extraTargets = { ...sub.extraTargets };
		for (const key of EXTRA_KEYS) {
			const group = { ...extraTargets[key] };
			let groupChanged = false;
			for (const [from, to] of aliases) {
				if (!(from in group)) continue;
				const value = group[from];
				if (!(to in group) && value !== undefined) group[to] = value;
				delete group[from];
				groupChanged = true;
				subChanged = true;
			}
			if (groupChanged) extraTargets[key] = group;
		}
		if (!subChanged) return sub;
		changed = true;
		return { ...sub, routing, extraTargets };
	});
	return { next, changed };
}

/** 订阅的身份两格(ADR-0021 决策 14)。 */
const SUBSCRIPTION_IDENTITY_KEYS = ["sourceKey", "externalId"] as const;

/** 拼进给人看的话里的一个值:字符串原样,别的转 JSON,没有就说「空」。 */
function showValue(v: unknown): string {
	if (typeof v === "string") return v;
	return v === undefined ? "空" : (JSON.stringify(v) ?? "空");
}

function subscriptionIdentityError(key: string, from: unknown, to: unknown): ConfigValidationError {
	return ConfigValidationError.invalid(
		"subscriptions",
		`订阅的 identity.${key} 不能改（${showValue(from)} → ${showValue(to)}），要换人就删了重加`,
		[{ path: ["identity", key], message: "身份格不许改" }],
	);
}

/**
 * 订阅的**身份**不许改(ADR-0019 决策 50)—— 换了来源或外部 id 就是另一个人,而运行期的一切(资料缓存、
 * 历史、图库里的头像引用)都挂在这条订阅的 `id` 上。要换人就删了重加。
 *
 * 看的是调用方送来的那一份(补丁或整条),**在 schema 之前**:报错能点名是哪一格,而不是 schema 那边一堆
 * 不相干的话。没送 `identity`、或送了而某一格缺着,那一格算不改;值与现有的一样(面板整份送回来)不算改。
 */
function assertSubscriptionIdentityUnchanged(current: Subscription, raw: unknown): void {
	const sent = isPlainObject(raw) && isPlainObject(raw.identity) ? raw.identity : {};
	for (const key of SUBSCRIPTION_IDENTITY_KEYS) {
		if (sent[key] === undefined || sent[key] === current.identity[key]) continue;
		throw subscriptionIdentityError(key, current.identity[key], sent[key]);
	}
}

/**
 * 一组同身份的订阅,拼进给人看的话里:「bilibili 的「12345」」;给了 `detail` 就在后面括号里列出各条(开机警告列
 * 订阅 id)。写盘这道闸、开机的警告、恢复备份的拒收说同一种话。
 */
export function describeDuplicate(
	dup: IdentityDuplicate,
	detail?: (sub: Subscription) => string,
): string {
	const { sourceKey, externalId } = dup.identity;
	const shown = detail ? `（${dup.subscriptions.map(detail).join("、")}）` : "";
	return `${sourceKey} 的「${externalId}」${shown}`;
}

/**
 * 同一身份只能有一条订阅(守卫 9,docs/1.0/data-model.md)。在真正写盘的这一层把关:订阅仓只是写盘之后才同步的
 * 内存镜像,在那里拒收已经晚了。判据是这次写入有没有**新增**重复,见 `findNewIdentityDuplicates`。
 *
 * 逐条写(`writeSubscriptions`)与整体替换(`replaceSections`)都走这一份,同 {@link assertTargetOwner}。
 */
function assertNoNewIdentityDuplicate(
	before: readonly Subscription[],
	after: readonly Subscription[],
): void {
	const [dup] = findNewIdentityDuplicates(before, after);
	if (!dup) return;
	throw ConfigValidationError.conflict(
		"subscriptions",
		`同一个人只能有一条订阅：${describeDuplicate(dup)}已经订阅过了`,
	);
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
	/** 登记进来的各集成的设置格式,按集成的键。 */
	private readonly segments: ReadonlyMap<string, IntegrationSettingsSegment>;
	/** 各集成的设置(已按各自的格式解析过),按集成的键。 */
	private readonly integrationSettings = new Map<string, unknown>();
	/** 各拓展的设置(原样,形状归拓展自己),按拓展 id。 */
	private readonly extensionSettings = new Map<string, unknown>();
	/** 订阅:一份列表、一个文件(ADR-0021 决策 15)。写一律走 {@link writeSubscriptions}。 */
	private subscriptions: Subscription[];
	/** 订阅标签表(ADR-0034),与订阅同一个文件、同一条队。 */
	private subscriptionTags: SubscriptionTag[] = [];
	private connections: Connection[];
	private targets: PushTarget[];

	private readonly meta: Record<ConfigScope, ScopeMetaInternal> = {
		globals: { exists: false, lastUpdatedAt: null },
		"integration-settings": { exists: false, lastUpdatedAt: null },
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
		this.segments = segmentsByKey(opts.integrationSettings ?? []);
		// Initialize with safe defaults; `load()` overwrites.
		this.globals = makeDefaultGlobalConfig();
		this.subscriptions = [];
		this.connections = [];
		this.targets = [];
	}

	private path(scope: ConfigScope): string {
		switch (scope) {
			case "globals":
				return join(this.stateDir, ...CORE_SETTINGS_IN_CONFIG);
			case "integration-settings":
				// 一个集成一个文件,按键取({@link integrationPath});这一支只为穷尽。
				return join(this.stateDir, SETTINGS_DIR);
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

	/** 一个集成的设置文件。 */
	private integrationPath(key: string): string {
		return join(this.stateDir, SETTINGS_DIR, `${key}.json`);
	}

	/** 一个拓展的设置文件。id 要拼进路径:不合拓展 id 的形状整次拒收(`../` 一类不许进来)。 */
	private extensionSettingsPath(id: string): string {
		if (!ExtensionIdSchema.safeParse(id).success) {
			throw ConfigValidationError.invalid("integration-settings", `「${id}」不是合法的拓展 id`, [
				{ path: [id], message: "拓展 id 的形状不对" },
			]);
		}
		return join(this.stateDir, ...EXTENSION_SETTINGS_IN_CONFIG, `${id}.json`);
	}

	/**
	 * 一个集成的设置打上补丁之后的样子:按它的格式解析、再过它的写入那一道。没登记过的键、不合格式的值都整次拒收,
	 * 逐格原因的路径带上集成的键(`bilibili.dynamicCron`),面板按它找到那一格。
	 */
	private nextIntegrationSettings(key: string, patch: unknown): unknown {
		const prev = this.integrationSettings.get(key);
		return parseIntegrationSettings(this.segmentOf(key), deepMerge(prev, patch), prev);
	}

	/** 登记过的那一份格式;没登记过的键整次拒收(写进来的是一份认不得的设置)。 */
	private segmentOf(key: string): IntegrationSettingsSegment {
		const segment = this.segments.get(key);
		if (segment) return segment;
		throw ConfigValidationError.invalid("integration-settings", `没有叫「${key}」的集成设置`, [
			{ path: [key], message: "没有登记过这个集成" },
		]);
	}

	/**
	 * 把一份新的订阅列表(连同标签表)落盘(一次原子写)并换进内存。调用方都在 `subscriptions` 那条队里。
	 * 新增了同身份的重复、或挂了标签表里没有的标签就拒,盘上与内存都不动。
	 */
	private async writeSubscriptions(
		next: readonly Subscription[],
		tags: readonly SubscriptionTag[] = this.subscriptionTags,
	): Promise<void> {
		assertNoNewIdentityDuplicate(this.subscriptions, next);
		assertKnownTags(next, tags);
		const file: SubscriptionFile = { tags: [...tags], subscriptions: [...next] };
		await atomicWriteJson(this.path("subscriptions"), file);
		this.subscriptions = file.subscriptions;
		this.subscriptionTags = file.tags;
	}

	/** Write settings/core.json. When a SecretStore owns the apiKey, the on-disk copy is stripped. */
	private async persistGlobals(g: GlobalConfig): Promise<void> {
		// P2:无 SecretStore 的 legacy 路径,apiKey 明文落 settings/core.json。这是
		// 既有兼容回退(非缺陷),但此前无任何提示 —— 运维不知密钥在盘上明文。
		// 首次遇到非空 apiKey 时高可见告警一次(建议配置 passphrase 启用加密)。
		if (
			!this.secretStore &&
			!this.plaintextApiKeyWarned &&
			Object.keys(collectAiSecrets(g)).length > 0
		) {
			this.plaintextApiKeyWarned = true;
			this.serviceCtx.logger.warn(
				"[secret] AI apiKey 以明文写入 settings/core.json(未配置加密密钥)。建议设置 passphrase 启用 SecretStore 加密。",
			);
		}
		await atomicWriteJson(this.path("globals"), this.secretStore ? stripApiKeyForDisk(g) : g);
	}

	/**
	 * 读出加密袋,把盘上出现的明文 key 抬进去、抹掉盘上那份,再把袋里的 key 注回内存里的 globals(引擎与路由
	 * 照旧读 `providers.<id>.apiKey`)。没有 SecretStore 时什么都不做(只有测试走这条)。
	 */
	private async hydrateSecrets(): Promise<void> {
		if (!this.secretStore) return;
		this.secretBag = await this.secretStore.load();

		// **盘上不留明文**(一直成立的规矩,不是 0.x 兼容):settings/core.json 落盘时 apiKey 一律抠成空串,所以
		// 盘上出现非空的 key 就是明文 —— 主人手改写进去的,或 0.x 加密上线前留下的。开机抬进加密袋、抹掉盘上那份。
		const plaintext = collectAiSecrets(this.globals);
		const hadPlaintext = Object.keys(plaintext).length > 0;
		if (hadPlaintext) {
			// 明文优先:每次抬完盘上都会抹掉,所以盘上的明文只可能是之后写进去的,袋里那把才是旧的(主人手改换
			// key 就是这样)。抬到一半崩了(袋已存、盘上还没抹)时两边是同一把,谁优先都一样。
			this.secretBag = {
				...this.secretBag,
				aiApiKeys: { ...(this.secretBag.aiApiKeys ?? {}), ...plaintext },
			};
			await this.secretStore.save(this.secretBag);
			this.serviceCtx.logger.info(
				"[secrets] 已把明文 apiKey 从 settings/core.json 迁移进加密 secrets 文件",
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
		// 字段(哪怕只是 fansCron),`defaults.ai` 都会被误判成「变了」,白白热重载一次
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
				throw ConfigValidationError.fromZod("globals", parsed.error, {
					subject: "settings/core.json",
				});
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

			// 0.x 的老形状(AI 的扁平字段与人格指针、历代旧默认模板……)在开新代时由迁移器改写好了
			// (`migration/settings.ts`),这里只认最新的形状。

			// Move apiKey out of plaintext settings/core.json into encrypted secrets
			// (+ one-time lift), then hydrate it back in memory.
			await this.hydrateSecrets();
		}

		// 各集成的设置 —— 一个集成一个文件(ADR-0021 决策 42 下 10-01 的 🔗)。没有就按格式的默认值建一份;
		// 读坏了是开机报错,同核心那份(「坏了只停那一个集成」随 3a 的集成生命周期做)。
		for (const segment of this.segments.values()) {
			const { value } = await readJsonOrInit<unknown>(this.integrationPath(segment.key), () =>
				segment.schema.parse({}),
			);
			const parsed = segment.schema.safeParse(value);
			if (!parsed.success) {
				throw ConfigValidationError.fromZod("integration-settings", parsed.error, {
					subject: `settings/${segment.key}.json`,
				});
			}
			this.integrationSettings.set(segment.key, parsed.data);
		}
		this.meta["integration-settings"].exists = true;

		// 各拓展的设置 —— 一个拓展一个文件。仓不认得它们的形状,原样读进来(核对归拓展自己那份 zod)。
		for (const [id, value] of await readExtensionSettingsDir(
			join(this.stateDir, ...EXTENSION_SETTINGS_IN_CONFIG),
		)) {
			this.extensionSettings.set(id, value);
		}

		// subscriptions —— 一个文件(ADR-0021 决策 15)。读坏了就是开机报错:跳过坏行更糟,下次写回
		// 那几行就永久没了。
		{
			const { value, existed } = await readJsonOrInit<unknown>(
				this.path("subscriptions"),
				(): SubscriptionFile => ({ tags: [], subscriptions: [] }),
			);
			const file = parseSubscriptionFile("subscriptions.json", value);
			this.subscriptionTags = file.tags;
			// 悬空的标签 id 只可能是手改了文件(删标签清引用是同一次原子写):剥掉、记一句,不挡开机;下次写盘就干净了。
			const cleaned = withoutUnknownTags(file.subscriptions, file.tags);
			this.subscriptions = cleaned.next;
			if (cleaned.dropped.length > 0) {
				this.serviceCtx.logger.warn(
					`[config] subscriptions.json 里有订阅挂着标签表里没有的标签,已经剥掉:${[...new Set(cleaned.dropped)].join("、")}`,
				);
			}
			this.meta.subscriptions.exists = true;
			this.meta.subscriptions.lastUpdatedAt = existed ? null : new Date().toISOString();
			// 老版本留下的同身份重复:照读,只记一句警告 —— 拒收会让开机起不来。
			const duplicates = findIdentityDuplicates(this.subscriptions);
			if (duplicates.length > 0) {
				const listed = duplicates.map((d) => describeDuplicate(d, (s) => s.id)).join("；");
				this.serviceCtx.logger.warn(
					`[config] subscriptions.json 里同一个人订了不止一条：${listed}。同一个人只能有一条订阅，在订阅页删掉多余的那条`,
				);
			}
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

	getIntegrationSettings<T>(segment: IntegrationSettingsSegment<T>): T {
		if (!this.segments.has(segment.key)) {
			throw new Error(`集成「${segment.key}」的设置没有登记进配置仓(组装处漏了)`);
		}
		return deepClone(this.integrationSettings.get(segment.key)) as T;
	}

	getAllIntegrationSettings(): Record<string, unknown> {
		return deepClone(Object.fromEntries(this.integrationSettings));
	}

	getExtensionSettings(id: string): unknown {
		return deepClone(this.extensionSettings.get(id));
	}

	getAllExtensionSettings(): Record<string, unknown> {
		return deepClone(Object.fromEntries(this.extensionSettings));
	}

	getSubscriptionTags(): SubscriptionTag[] {
		return deepClone(this.subscriptionTags);
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
	 * into the encrypted bag and scrubbed from the on-disk settings/core.json; the
	 * in-memory copy keeps the real value so engines/routes are unaffected.
	 */
	private async writeGlobals(g: GlobalConfig): Promise<void> {
		if (this.secretStore) {
			// P2:此前 save 成功后 persistGlobals 抛错 → 密钥袋已存新 apiKey 但
			// settings/core.json/in-memory 仍旧值 → 重启后两边分叉。失败即回滚密钥袋,
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
		return (await this.patchSettings({ core: patch })).core;
	}

	async patchSettings(patch: SettingsPatch): Promise<SettingsSnapshot> {
		const keys = Object.keys(patch.integrations ?? {});
		const result = await this.runScoped("globals", async () => {
			// ---- 1) 全部校验:任一份不过就整个作废,一个字都不写 ----
			let core: GlobalConfig | undefined;
			if (patch.core !== undefined) {
				const parsed = GlobalConfigSchema.safeParse(deepMerge(this.globals, patch.core));
				if (!parsed.success) throw ConfigValidationError.fromZod("globals", parsed.error);
				core = parsed.data;
			}
			const integrations = new Map(
				keys.map((key) => [key, this.nextIntegrationSettings(key, patch.integrations?.[key])]),
			);

			// ---- 2) 落盘:集成的先写,核心的最后写;核心那份(连密钥袋)写失败,把写过的集成推回原样 ----
			const written: string[] = [];
			try {
				for (const [key, next] of integrations) {
					await atomicWriteJson(this.integrationPath(key), next);
					written.push(key);
				}
				if (core) await this.writeGlobals(core);
			} catch (e) {
				for (const key of written) {
					const before = this.integrationSettings.get(key);
					await atomicWriteJson(this.integrationPath(key), before).catch(() => {});
				}
				throw e;
			}

			// ---- 3) 都写成了才换进内存(核心那份 writeGlobals 已经换了) ----
			for (const [key, next] of integrations) this.integrationSettings.set(key, next);
			if (core) this.touch("globals");
			if (integrations.size > 0) this.touch("integration-settings");
			return { core: this.globals, integrations: Object.fromEntries(this.integrationSettings) };
		});
		if (patch.core !== undefined) this.bus.emit("config-changed", { scope: "globals" });
		if (keys.length > 0) this.bus.emit("config-changed", { scope: "integration-settings" });
		return deepClone(result);
	}

	async updateExtensionSettings(
		id: string,
		update: (current: unknown) => unknown,
	): Promise<unknown> {
		const path = this.extensionSettingsPath(id);
		const result = await this.runScoped("globals", async () => {
			const next = update(deepClone(this.extensionSettings.get(id)));
			await atomicWriteJson(path, next);
			this.extensionSettings.set(id, next);
			this.touch("integration-settings");
			return next;
		});
		this.bus.emit("config-changed", { scope: "integration-settings" });
		return deepClone(result);
	}

	async removeExtension(id: string): Promise<void> {
		const path = this.extensionSettingsPath(id);
		const removed = await this.runScoped("globals", async () => {
			// 开关先删:设置文件删不掉的话留下的只是一个没人认领的文件,反过来则是一个开着、却没了设置的拓展。
			const core = id in this.globals.extensions;
			if (core) {
				const { [id]: _gone, ...extensions } = this.globals.extensions;
				await this.writeGlobals({ ...this.globals, extensions });
				this.touch("globals");
			}
			const settings = this.extensionSettings.has(id);
			if (settings) {
				await rm(path, { force: true });
				this.extensionSettings.delete(id);
				this.touch("integration-settings");
			}
			return { core, settings };
		});
		if (removed.core) this.bus.emit("config-changed", { scope: "globals" });
		if (removed.settings) this.bus.emit("config-changed", { scope: "integration-settings" });
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
			if (existing) assertSubscriptionIdentityUnchanged(existing, sub);
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
			assertSubscriptionIdentityUnchanged(current, patch);
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

	async replaceSubscriptionTags(tags: SubscriptionTag[]): Promise<SubscriptionTag[]> {
		const saved = await this.runScoped("subscriptions", async () => {
			const parsed = SubscriptionTagListSchema.safeParse(tags);
			if (!parsed.success) {
				throw ConfigValidationError.fromZod("subscriptions", parsed.error, { subject: "标签表" });
			}
			const { next } = withoutUnknownTags(this.subscriptions, parsed.data);
			await this.writeSubscriptions(next, parsed.data);
			this.touch("subscriptions");
			return parsed.data;
		});
		this.bus.emit("config-changed", { scope: "subscriptions" });
		return deepClone(saved);
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
			const integrations =
				next.integrations &&
				new Map(
					Object.entries(next.integrations).map(([key, value]) => [
						key,
						parseIntegrationSettings(this.segmentOf(key), value, this.integrationSettings.get(key)),
					]),
				);
			// 拓展的设置原样存(形状归拓展自己);id 要拼进路径,不合 id 的形状整份拒收。
			const extensionSettings = Object.entries(next.extensionSettings ?? {}).map(([id, value]) => ({
				id,
				path: this.extensionSettingsPath(id),
				value,
			}));
			const subscriptions = next.subscriptions && parseAll("subscriptions", next.subscriptions);
			let subscriptionTags: SubscriptionTag[] | undefined;
			if (next.subscriptionTags !== undefined) {
				const r = SubscriptionTagListSchema.safeParse(next.subscriptionTags);
				if (!r.success) {
					throw ConfigValidationError.fromZod("subscriptions", r.error, { subject: "标签表" });
				}
				subscriptionTags = r.data;
			}
			const connections = next.connections && parseAll("connections", next.connections);
			const targets = next.targets && parseAll("targets", next.targets);

			// ---- 2) 跨分区不变式 + 托管目标归一化(与 load() 同一套) ----------
			const effConnections = connections ?? this.connections;
			const effTargets = targets ?? this.targets;
			const effTags = subscriptionTags ?? this.subscriptionTags;
			// 只换标签表时,现有订阅上的旧 id 跟着剥;订阅也给了的,挂错标签就整份拒(下面 assertKnownTags)。
			const effSubs = subscriptions ?? withoutUnknownTags(this.subscriptions, effTags).next;
			for (const t of effTargets) assertTargetOwner(t, effConnections);
			const synced = syncManagedWebhookTargets(effConnections, effTargets);
			const replaced = replaceTargetIdsInSubscriptions(effSubs, synced.aliases);
			assertNoNewIdentityDuplicate(this.subscriptions, replaced.next);
			assertKnownTags(replaced.next, effTags);

			// ---- 3) 落盘:数组先写(留 .bak),globals 最后写 -------------------
			const writes: Array<[string, unknown]> = [];
			for (const [key, value] of integrations ?? [])
				writes.push([this.integrationPath(key), value]);
			for (const { path, value } of extensionSettings) writes.push([path, value]);
			const subsTouched = Boolean(subscriptions) || Boolean(subscriptionTags) || replaced.changed;
			if (subsTouched) {
				const file: SubscriptionFile = { tags: effTags, subscriptions: replaced.next };
				writes.push([this.path("subscriptions"), file]);
			}
			if (connections) writes.push([this.path("connections"), effConnections]);
			if (targets || synced.changed) writes.push([this.path("targets"), synced.next]);

			const backups: Array<[string, string]> = [];
			// 写之前还不存在的:推回去 = 删掉它,否则开机时读到的是半新半旧。
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
			if ((integrations && integrations.size > 0) || extensionSettings.length > 0) {
				for (const [key, value] of integrations ?? []) this.integrationSettings.set(key, value);
				for (const { id, value } of extensionSettings) this.extensionSettings.set(id, value);
				this.touch("integration-settings");
				touched.push("integration-settings");
			}
			if (subsTouched) {
				this.subscriptions = replaced.next;
				this.subscriptionTags = effTags;
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

/** 设置在配置目录里的子目录:设置按集成分文件,都在这下面(ADR-0021 决策 42 下 10-01 的 🔗)。 */
const SETTINGS_DIR = "settings";

/** 核心的设置在配置目录里的位置。 */
const CORE_SETTINGS_IN_CONFIG = [SETTINGS_DIR, "core.json"] as const;

/** 各拓展的设置在配置目录里的位置:一个拓展一个文件(ADR-0025 决策 1:拓展一律落在 `extensions/` 下)。 */
const EXTENSION_SETTINGS_IN_CONFIG = [SETTINGS_DIR, "extensions"] as const;

/** 核心的设置文件(代的布局)。迁移写到哪、仓就从哪读。 */
export const CORE_SETTINGS_FILE = [...CONFIG_DIR, ...CORE_SETTINGS_IN_CONFIG] as const;

/** 一个集成的设置文件(代的布局):`config/settings/<键>.json`。迁移写到哪、仓就从哪读。 */
export function integrationSettingsFile(
	key: string,
): readonly [...typeof CONFIG_DIR, typeof SETTINGS_DIR, string] {
	return [...CONFIG_DIR, SETTINGS_DIR, `${key}.json`];
}

/** 一个拓展的设置文件(代的布局):`config/settings/extensions/<拓展 id>.json`。迁移写到哪、仓就从哪读。 */
export function extensionSettingsFile(
	id: string,
): readonly [...typeof CONFIG_DIR, ...typeof EXTENSION_SETTINGS_IN_CONFIG, string] {
	return [...CONFIG_DIR, ...EXTENSION_SETTINGS_IN_CONFIG, `${id}.json`];
}

/**
 * 读各拓展的设置文件:`<拓展 id>.json` 一个一份,按文件名排。目录不在 = 一个都没存过;文件名不合拓展 id 的形状的
 * (写到一半的临时文件、手放的别的东西)不认。读坏了是开机报错,同别的配置文件。
 */
async function readExtensionSettingsDir(dir: string): Promise<Array<[string, unknown]>> {
	let names: string[];
	try {
		names = await readdir(dir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
	const out: Array<[string, unknown]> = [];
	for (const name of names.sort()) {
		if (!name.endsWith(".json")) continue;
		const id = name.slice(0, -".json".length);
		if (!ExtensionIdSchema.safeParse(id).success) continue;
		out.push([id, JSON.parse(await readFile(join(dir, name), "utf8")) as unknown]);
	}
	return out;
}

/**
 * 登记进来的集成设置按键排好。键重复、或者和核心设置的顶层键同名(`/api/settings` 把两者摆在同一层),是组装处
 * 写错了,当场抛。
 */
function segmentsByKey(
	segments: readonly IntegrationSettingsSegment[],
): ReadonlyMap<string, IntegrationSettingsSegment> {
	const coreKeys = new Set(Object.keys(GlobalConfigSchema.shape));
	const byKey = new Map<string, IntegrationSettingsSegment>();
	for (const segment of segments) {
		if (byKey.has(segment.key)) throw new Error(`集成设置「${segment.key}」登记了两次`);
		if (coreKeys.has(segment.key)) {
			throw new Error(`集成设置的键「${segment.key}」和核心设置的顶层键撞名`);
		}
		byKey.set(segment.key, segment);
	}
	return byKey;
}

/** 一份集成设置按它的格式解析、再过它写入的那一道;逐格原因的路径带上集成的键。 */
function parseIntegrationSettings(
	segment: IntegrationSettingsSegment,
	value: unknown,
	prev: unknown,
): unknown {
	const subject = `${segment.key} 的设置`;
	const prefix = [segment.key];
	const parsed = segment.schema.safeParse(value);
	if (!parsed.success) {
		throw ConfigValidationError.fromZod("integration-settings", parsed.error, { subject, prefix });
	}
	const issues = segment.checkWrite?.(parsed.data, prev) ?? [];
	if (issues.length > 0) {
		throw ConfigValidationError.fromIssues("integration-settings", issues, { subject, prefix });
	}
	return parsed.data;
}

export function createConfigStore(opts: CreateConfigStoreOptions): ConfigStore {
	return new NodeConfigStore(opts);
}
