import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
	type ConfigScope,
	type Connection,
	type ConnectionProbeState,
	ConnectionProbeStateSchema,
	ConnectionSchema,
	ConnectionShellSchema,
	createSerialQueue,
	DEFAULT_MESSAGE_LAYOUT,
	type Disposable,
	deterministicUuid,
	EXTRA_KEYS,
	ExtensionIdSchema,
	fail,
	type GlobalConfig,
	GlobalConfigSchema,
	type Issue,
	isPrivateTarget,
	type MessageBus,
	makeDefaultGlobalConfig,
	NewConnectionSchema,
	neutralPlatformSnapshot,
	normalizeMessageLayout,
	ok,
	type PlatformSnapshot,
	PlatformSnapshotSchema,
	type PushTarget,
	PushTargetSchema,
	type Result,
	type ServiceContext,
	type Subscription,
	SubscriptionSchema,
	type SubscriptionTag,
	SubscriptionTagListSchema,
	type TargetReachability,
} from "@bilibili-notify/internal";
import { atomicWriteFile, atomicWriteJson } from "@bilibili-notify/storage";
import {
	findIdentityDuplicates,
	findNewIdentityDuplicates,
	type IdentityDuplicate,
} from "@bilibili-notify/subscription";
import type { ZodType, z } from "zod";
import { dataPath } from "../runtime/roots.js";
import { errorMessageOf } from "../util/error-message.js";
import {
	applyAiSecrets,
	collectAiSecrets,
	isInstanceSecretKey,
	isSearchSecretKey,
	stripAiSecrets,
} from "./ai-secrets.js";
import {
	type InvalidSettingEntry,
	instanceIdOfEntry,
	parseCoreSettings,
	withRawSettings,
} from "./core-settings.js";
import { parseIntegrationCells } from "./integration-settings.js";
import type { BootstrapConfig } from "./schema.js";
import type { ConfigSecrets, SecretStore } from "./secret-store.js";
import { brokenInstanceIdTakenMessage } from "./settings-problems.js";
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
 * 10-01 的 🔗)。仓不认得是哪个集成,只按登记的格式读写;组装处(`compose.ts`)把它们交上来,运行时
 * 登记。
 */
export interface IntegrationSettingsSegment<T = unknown> {
	/** 集成的键,也是文件名。不能和核心设置的顶层键同名:`/api/settings` 把它们摆在同一层。 */
	readonly key: string;
	/**
	 * 盘上那份的格式,必须是 `z.object`(每个顶层键一格,读盘逐格解析:一格坏了只那一格退默认)且空对象过得了
	 * (「文件不在时建一份」与「坏格退默认」共同的前提,登记时核)。读盘也按它,所以对存量要宽松。
	 */
	readonly schema: z.ZodObject<Record<string, ZodType>> & z.ZodType<T>;
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
	/**
	 * 核心设置里读盘时被隔离的格(深拷贝):那一格在内存里是默认值,盘上原文在落盘时原样放回。
	 * 🔴 `raw` 是盘上原文,可能带着主人手写的明文 key —— **不许接到任何路由、日志或备份上**;
	 * 对外只说路径与原因(问题表那一条已经是这样)。
	 */
	getInvalidSettings(): InvalidSettingEntry[];
	/**
	 * 按键读一个登记过的集成此刻**盘上那一份**(深拷贝、不过 schema:形状归读的人自己那份 zod)。某一格读盘时被隔离的,
	 * 给的是盘上原文(读的人拿自己那一格的 schema 判);整个文件读不懂(不是合法 JSON、顶层不是对象)回失败,
	 * `issues` 里一条、不带 `path`。读盘本身出错开机就抛了,到不了这里。没登记过的键抛(组装处漏了)。
	 * 🔴 带原文,**不许接到任何路由、日志或备份上**。
	 */
	readIntegrationSettings(key: string): Result<{ settings: unknown }>;
	/**
	 * 全部登记过的集成的设置,按集成的键(深拷贝)。`/api/settings` 与备份用。**每个登记过的键一直在**:坏格是默认值、
	 * 整个文件读不懂时整段是默认值 —— 键不在的话面板存这个集成的设置会被当成核心补丁、回 200 而一个字没写。
	 */
	getAllIntegrationSettings(): Record<string, unknown>;
	/**
	 * 一个拓展存着的设置(`config/settings/extensions/<id>.json`,深拷贝、原样;形状归拓展自己那份 zod);没存过是
	 * `undefined`。
	 */
	getExtensionSettings(id: string): unknown;
	/** 全部存着的拓展设置,按拓展 id(深拷贝)。备份用。 */
	getAllExtensionSettings(): Record<string, unknown>;
	/**
	 * 一个拓展的设置文件读不懂(不是合法 JSON)时的原因;读得懂或没存过是 `undefined`。这种拓展的
	 * `getExtensionSettings` 与没设过同形,装载器靠这一口把它停下。重存(写盘成功)才清。
	 */
	extensionSettingsIssue(id: string): Issue | undefined;
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
	/** 整条写(快照取调用方给的):外壳与快照形状 + 适配器在场时验 `settings` + 身份守卫。 */
	upsertConnection(connection: Connection): Promise<void>;
	/**
	 * 只管新建:同 id 已存在回 `conflict`(编辑走 {@link patchConnection} —— 整条覆盖分不开「没带」与「清空」)。
	 * `input` 按 {@link NewConnectionSchema} 收(宿主独写的 `platformSnapshot` / `probeState` 带来了也被剥掉),
	 * 快照由调用方(路由)从适配器的候选抄来。
	 */
	createConnection(input: unknown, platformSnapshot: PlatformSnapshot): Promise<void>;
	/**
	 * 补丁里带来的 `platformSnapshot` / `probeState` 一律忽略(只有宿主写);只有补丁里带了 `settings`
	 * 才验 `settings` —— 被隔离的连接照样能改名、能停用。
	 */
	patchConnection(id: string, patch: DeepPartial<Connection>): Promise<Connection>;
	/** 只换探测状态那一格:不验 `settings`、不做托管目标同步;发 `config-changed { scope: "connections" }`。 */
	recordConnectionProbeState(id: string, state: ConnectionProbeState): Promise<Connection>;
	deleteConnection(id: string): Promise<boolean>;
	upsertTarget(target: PushTarget): Promise<void>;
	patchTarget(id: string, patch: DeepPartial<PushTarget>): Promise<PushTarget>;
	recordTargetReachability(id: string, reachability: TargetReachability): Promise<PushTarget>;
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
	 * Encrypted bag for secret fields (currently `ai.apiKey`). When
	 * given, the apiKey is moved out of plaintext `settings/core.json` into this store
	 * (and a one-time lift migrates an existing plaintext key). When omitted the
	 * legacy behaviour (apiKey stays in settings/core.json) is preserved — used by
	 * tests and any non-secret-aware caller.
	 */
	secretStore?: SecretStore;
	/** 登记进来的各集成的设置(见 {@link IntegrationSettingsSegment})。键不能重复,也不能和核心设置的顶层键同名。 */
	integrationSettings?: readonly IntegrationSettingsSegment[];
	/**
	 * 在场的适配器的 `settingsSchema`;不在场回 undefined。现取的闭包(适配器来去,拓展拨一下开关就变)。
	 * 不给 = 一律当不在场:保存时不验 `settings`(测试与不关心连接的调用方)。
	 */
	connectionSettingsSchemaOf?: (adapterKey: string) => ZodType | undefined;
	/**
	 * 核心设置的坏格表变了:`load()` 末尾有坏格时叫一次,之后每次写让表变了、出了写队列再叫一次(带着整张新表,
	 * 空表 = 都好了)。仓不认得问题表,组装处把它接过去。回调抛了只记一行 warn,不让已经落盘的写失败。
	 */
	onInvalidSettingsChanged?: (entries: InvalidSettingEntry[]) => void;
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
 * 落盘前把全部 AI 密钥(每家两把,加搜索后端的)抠成空串,回一份深拷贝。`settings/core.json` **不加密**,漏掉任何
 * 一把就是明文躺在盘上。内存里的 `this.globals` 留着真值(引擎经 getGlobals 读),只有盘上那份被抠掉。
 * 具体规则见 `./ai-secrets.ts#stripAiSecrets`。
 */
function stripApiKeyForDisk(g: GlobalConfig): GlobalConfig {
	return stripAiSecrets(deepClone(g));
}

/** 按路径取值,中途不是对象、或没有自己的这个键就是 `undefined`(键叫原型名时不摸到原型上的东西)。 */
function valueAt(root: unknown, path: readonly string[]): unknown {
	let cur: unknown = root;
	for (const step of path) {
		if (!isPlainObject(cur) || !Object.hasOwn(cur, step)) return undefined;
		cur = cur[step];
	}
	return cur;
}

/**
 * 旧袋里属于仍被隔离的 `ai` 子格的那些键,三档:
 * - `ai` 整格被隔离:两域都留;
 * - `ai.providers` 整张表被隔离(两段):实例域全留(不是搜索域的);`ai.search` 被隔离:搜索域留;
 * - `ai.providers` 里**某一家**被隔离(三段):只留这几家名下的键,别家照「删一家,key 跟着消失」重算。
 * 袋键怎么分域、怎么认实例见 `ai-secrets.ts`。
 */
function isolatedSecrets(
	bag: Readonly<Record<string, string>>,
	isolated: readonly InvalidSettingEntry[],
): Record<string, string> {
	const whole = isolated.some((e) => e.path.length === 1 && e.path[0] === "ai");
	const has = (cell: string) =>
		isolated.some((e) => e.path.length === 2 && e.path[0] === "ai" && e.path[1] === cell);
	const keepInstances = whole || has("providers");
	const keepSearch = whole || has("search");
	const brokenIds = isolated.flatMap((e) => instanceIdOfEntry(e.path) ?? []);
	const ofBrokenInstance = (key: string) => brokenIds.some((id) => isInstanceSecretKey(key, id));
	return Object.fromEntries(
		Object.entries(bag).filter(
			([key]) =>
				// 先问是不是坏家名下的(实例 id 自己可以长成 `search:…`),再按域判。
				ofBrokenInstance(key) || (isSearchSecretKey(key) ? keepSearch : keepInstances),
		),
	);
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

/** 一个文件落盘前的样子(字节与权限),写失败时按它原样推回去。 */
interface FileSnapshot {
	bytes: Buffer;
	mode: number;
}

/** 记下文件此刻的字节与权限;文件不在回 `undefined`(推回去 = 删掉)。其余读盘错误原样抛。 */
async function snapshotFile(path: string): Promise<FileSnapshot | undefined> {
	try {
		const [bytes, info] = await Promise.all([readFile(path), stat(path)]);
		return { bytes, mode: info.mode & 0o777 };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw err;
	}
}

/** 把 {@link snapshotFile} 记下的样子原样写回去;当时不存在就删掉。 */
async function restoreFile(path: string, before: FileSnapshot | undefined): Promise<void> {
	if (before === undefined) await rm(path, { force: true });
	else await atomicWriteFile(path, before.bytes, { mode: before.mode });
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
 * 连接的**身份轴**不许改 —— 换 `adapterKey` 或换 `platform` 都等于换了另一条连接,而目标还
 * 挂在原来那个 id 上。允许改的话,「onebot 群目标」会一夜之间挂在一条飞书连接下面。
 *
 * 🔴 **两支都比 platform。** 拓展那一支曾经没有这一格(那时它是「一条桥接入」,驮着 N 个
 * 平台的 bot,ADR-0012 决策 27),于是这里对它整个早退;改成「一条连接 = 一个借来的 bot」
 * (决策 45)之后它有了,而早退没跟着改 —— 症状是把一条桥连接从 QQ bot 换成 telegram bot
 * 能存下去,底下的 QQ 群目标平台原地不动,投递却跑去了 telegram。
 *
 * 现在目标不再自带平台(平台只在连接上):连接的平台一改,底下挂着的目标会**静默换义**
 * (QQ 群号被当成 telegram 地址),再没有目标上那份拷贝来兜底,所以这一道要留着。
 */
function assertConnectionIdentityStable(current: Connection, next: Connection): void {
	if (current.adapterKey !== next.adapterKey) {
		throw ConfigValidationError.invalid(
			"connections",
			`连接的适配器不能改（${current.adapterKey} → ${next.adapterKey}），要换就删了重建`,
			[{ path: ["adapterKey"], message: "身份格不许改" }],
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
 * 主人目标只许指向私聊目标(ADR-0021 决策 57)。`targetId` 没给 = 清空,永远放行;
 * 给了却指向不存在的目标或群 / 频道 / 端点 → 拒收。保存时拦、**开机读盘不拦**(盘上旧值靠迁移清空 +
 * 发送时复检兜底,不能因为一个主人目标让整个服务起不来)。
 */
function assertMasterTarget(
	master: GlobalConfig["master"],
	targets: readonly PushTarget[],
	scope: ConfigScope,
): void {
	const targetId = master?.targetId;
	if (targetId === undefined) return;
	const target = targets.find((t) => t.id === targetId);
	if (!target) {
		throw ConfigValidationError.invalid(
			scope,
			"主人目标指向的推送目标不存在，请重新选一个私聊目标",
			[{ path: ["master", "targetId"], message: "没有这个推送目标" }],
		);
	}
	if (!isPrivateTarget(target)) {
		throw ConfigValidationError.invalid(
			scope,
			`主人目标必须是私聊目标，「${target.name}」不是私聊，女仆没法悄悄告诉主人`,
			[{ path: ["master", "targetId"], message: "不是私聊目标" }],
		);
	}
}

/** 把当前的主人目标改成不再是私聊,会让主人通知落到群里 —— 拒收,先去系统页换掉主人目标。 */
const MASTER_TARGET_IN_USE = "它是主人目标，先在系统页把主人目标换掉或清空";

/**
 * 「这条连接不存在」在投递结果里的那一句。
 *
 * 🔴 **它落盘**:`push/target-dispatcher.ts` 拿它当投递失败的 `message`,历史每条失败消息的 `message` 里存的就是它
 * (盘上存的失败字段随改盘上形状的那一期带迁移条目改,不在这里动)。配置写入这边不用它 ——
 * 找不到连接是 `ConfigValidationError` 的 `not_found` 码,路由按码回,不嗅文案。
 */
export const CONNECTION_NOT_FOUND = "connection not found";

/**
 * 目标挂着的那条连接得存在。逐条 upsert 与整体 replaceSections 都走这一份。
 *
 * 目标不再自带平台,所以这里不比平台;「不许换连接」由
 * {@link assertTargetKeepsConnection} 管。**只在写入口调**:读盘不查(连接不在了的目标
 * 照旧读进来、发送时 `not_found`,不挡开机)。
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
}

/** 目标建好之后焊死在它那条连接上:换机器人改连接自己的参数就行,底下的目标不用动。 */
function assertTargetKeepsConnection(before: PushTarget | undefined, after: PushTarget): void {
	if (!before || before.connectionId === after.connectionId) return;
	throw ConfigValidationError.invalid(
		"targets",
		"推送目标建好之后不能换连接；要推到别的连接上请新建一个目标",
		[{ path: ["connectionId"], message: "建好之后不能换连接" }],
	);
}

/**
 * 整节替换的统一规矩(不分「换了哪一节」,两节一起交的合并式备份恢复也走这里):对替换**之后**的
 * 每个目标,若替换之前有同 id 的目标 ——
 * ① 它的 `connectionId` 必须没变;
 * ② 它所指的连接若在替换前后都在,连接的 `adapterKey` 与 `platform` 都必须没变
 *    (`assertConnectionIdentityStable` 管的是逐条写,这条路不经过它)。
 * 替换之前没有的新目标不比。
 */
function assertRetainedTargetsKeepOwner(
	oldTargets: readonly PushTarget[],
	newTargets: readonly PushTarget[],
	oldConnections: readonly Connection[],
	newConnections: readonly Connection[],
): void {
	for (const target of newTargets) {
		const old = oldTargets.find((t) => t.id === target.id);
		if (!old) continue;
		assertTargetKeepsConnection(old, target);
		const before = oldConnections.find((c) => c.id === target.connectionId);
		const after = newConnections.find((c) => c.id === target.connectionId);
		if (!before || !after) continue;
		const platformChanged = before.platform !== after.platform;
		if (!platformChanged && before.adapterKey === after.adapterKey) continue;
		const change = platformChanged
			? `平台变了（${before.platform} → ${after.platform}）`
			: `适配器变了（${before.adapterKey} → ${after.adapterKey}）`;
		throw ConfigValidationError.invalid(
			"connections",
			`连接「${after.name}」的${change}，它底下还挂着推送目标；要换平台请新建一条连接`,
			[
				{
					path: [platformChanged ? "platform" : "adapterKey"],
					message: "底下还挂着推送目标，平台不能变",
				},
			],
		);
	}
}

/**
 * 这条连接有没有一个由它托管的目标 —— 判据是平台快照上的**目标形态**(`endpoint`:地址烧在设置里,
 * 目标只是个壳),不是平台名也不是适配器键(PUSH:156)。
 */
const hasManagedTarget = (c: Connection): boolean => c.platformSnapshot.targetKind === "endpoint";

/**
 * 托管目标的 id。**种子里那个 `adapter` 是冻住的**,别顺着改名一起改:它算出来的 uuid
 * 已经落在主人盘上,订阅的路由表按 id 引用着它 —— 换种子等于给每条 webhook 连接凭空
 * 换一张目标,主人配好的路由指向一个不存在的 id,而且不报错。
 */
function managedWebhookTargetId(connectionId: string): string {
	return deterministicUuid(`push-target:webhook-adapter:${connectionId}`);
}

function makeManagedWebhookTarget(connection: Connection, existing?: PushTarget): PushTarget {
	return {
		id: existing?.id ?? managedWebhookTargetId(connection.id),
		name: connection.name || "Webhook",
		connectionId: connection.id,
		kind: "endpoint",
		enabled: connection.enabled,
		managedBy: "connection",
		reachability: existing?.reachability,
	};
}

function syncManagedWebhookTarget(
	connection: Connection,
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
		if (!hasManagedTarget(connection)) continue;
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
	private readonly connectionSettingsSchemaOf: (adapterKey: string) => ZodType | undefined;
	private readonly onInvalidSettingsChanged?: (entries: InvalidSettingEntry[]) => void;
	private readonly stateDir: string;
	private readonly secretStore?: SecretStore;
	private secretBag: ConfigSecrets = {};
	/** P2:明文 apiKey 告警只打一次(避免每次写盘刷屏)。 */
	private plaintextApiKeyWarned = false;

	private globals: GlobalConfig;
	/**
	 * 读盘时被隔离的核心设置格:内存里是默认值、盘上原文落盘时放回。只在 `load()` 与 {@link writeGlobals}
	 * (落盘成功之后)里换;值里的 `raw` 可能带明文 key,读口见 {@link ConfigStore.getInvalidSettings}。
	 */
	private invalidSettings: InvalidSettingEntry[] = [];
	/** 写让坏格表变了、还没通知出去(通知要出了写队列再叫,见 {@link announceInvalidSettings})。 */
	private invalidSettingsChanged = false;
	/** 登记进来的各集成的设置格式,按集成的键。 */
	private readonly segments: ReadonlyMap<string, IntegrationSettingsSegment>;
	/** 各集成的设置(已按各自的格式解析过),按集成的键。 */
	private readonly integrationSettings = new Map<string, unknown>();
	/**
	 * 各集成的设置里读盘时被隔离的格:内存里是默认值、盘上原文落盘时放回,按集成的键。与
	 * {@link integrationUnreadable} 互斥。`raw` 可能带密钥,不许出仓(读口只在 {@link readIntegrationSettings})。
	 */
	private readonly integrationInvalid = new Map<string, InvalidSettingEntry[]>();
	/** 整个文件读不懂(不是合法 JSON、顶层不是对象)的集成设置,按集成的键;内存里是整段默认值,文件不动。 */
	private readonly integrationUnreadable = new Map<string, Issue>();
	/** 各拓展的设置(原样,形状归拓展自己),按拓展 id。 */
	private readonly extensionSettings = new Map<string, unknown>();
	/**
	 * 文件读不懂(不是合法 JSON)的拓展设置,按拓展 id。这些 id 不进 {@link extensionSettings}:读者看到的与
	 * 「没设过」同形,要不要停那个拓展由装载器看这张表决定。文件原样留在盘上,重存(写盘成功)才清。
	 */
	private readonly extensionSettingsIssues = new Map<string, Issue>();
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
		this.connectionSettingsSchemaOf = opts.connectionSettingsSchemaOf ?? (() => undefined);
		this.onInvalidSettingsChanged = opts.onInvalidSettingsChanged;
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

	/**
	 * Write settings/core.json. When a SecretStore owns the apiKey, the on-disk copy is stripped.
	 *
	 * 核心设置唯一的落盘口:仍被隔离的格(`entries`,缺省是仓里现有的那张表)在**密钥抠除之后**盖回盘上原文
	 * (`missing` 的删键)。放在这里而不是某个写口上,开机抹明文的那次写与 `removeExtension` 才不会漏;次序也不能
	 * 反 —— 抠除只认合法的内存值,原文那种不合形状的会被它改成别的样子。
	 */
	private async persistGlobals(
		g: GlobalConfig,
		entries: readonly InvalidSettingEntry[] = this.invalidSettings,
	): Promise<void> {
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
		const disk = this.secretStore ? stripApiKeyForDisk(g) : g;
		await atomicWriteJson(this.path("globals"), withRawSettings(disk, entries));
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
		// Hydrate in-memory (engines/routes keep reading ai.apiKey).
		//
		// 末尾重新过一遍 schema,保证 globals 是 zod parse 的**规范形态**(键序也算)。
		// `stripAiSecrets` 落盘时把 apiKey 抠成**空串**、不是删掉那个键(见 `ai-secrets.ts`),
		// 所以读回的对象里键还在原位,`applyAiSecrets` 的 spread 只覆盖值、不会把它追加到末尾。
		// 这一遍 parse 是兜底:`engines.ts` 的 config-changed diff 拿 `JSON.stringify` 逐 section
		// 比相等(键序敏感),依赖「globals 永远是 zod parse 的规范形态」这一不变式 —— 万一哪天
		// 键序偏了,重启后第一次改**任何** globals 字段(哪怕只是 profileRefreshCron),`ai`
		// 都会被误判成「变了」,白白热重载一次 AI 实例并刷两条日志。
		this.globals = GlobalConfigSchema.parse(
			applyAiSecrets(this.globals, this.secretBag.aiApiKeys ?? {}),
		);
		// Scrub disk if it ever held the plaintext.
		if (hadPlaintext) await this.persistGlobals(this.globals);
	}

	/**
	 * 读一个集成的设置文件进内存。内存里那一份永远是过得了段 schema 的规范形态(坏格是默认值、整个文件读不懂时整段是默认值),
	 * 不然 {@link patchSettings} 的合并底带着坏值、主人改另一格时整份过不了、永远 400。盘上原文不动。
	 */
	private async loadIntegrationSegment(segment: IntegrationSettingsSegment): Promise<void> {
		const { key } = segment;
		const path = this.integrationPath(key);
		let text: string;
		try {
			text = await readFile(path, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			const fresh = segment.schema.parse({});
			await atomicWriteJson(path, fresh);
			this.integrationSettings.set(key, fresh);
			return;
		}
		const read = readJsonObject(text);
		if ("issue" in read) {
			this.integrationSettings.set(key, segment.schema.parse({}));
			this.integrationUnreadable.set(key, read.issue);
			this.serviceCtx.logger.warn(
				`[config] settings/${key}.json 读不懂,这个集成读它的那几样先停着: ${read.issue.message}`,
			);
			return;
		}
		const parsed = parseIntegrationCells(segment.schema, read.value);
		this.integrationSettings.set(key, parsed.settings);
		if (parsed.invalid.length === 0) return;
		this.integrationInvalid.set(key, parsed.invalid);
		for (const entry of parsed.invalid) {
			this.serviceCtx.logger.warn(
				`[config] settings/${key}.json 的「${entry.path.join(".")}」读不懂,先按默认值跑: ${entry.issues.map((i) => i.message).join("; ")}`,
			);
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
			// 逐格解析:一格坏了只那一格退默认、盘上原文留着(落盘时放回),不挡开机;只有信封坏了
			// (解析不了、顶层不是对象)才抛。
			const parsed = parseCoreSettings(value);
			this.globals = parsed.settings;
			this.invalidSettings = parsed.invalid;
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
		// 内容读不懂不挡开机:一格坏了只那一格退默认,整个文件读不懂整段退默认,盘上原文都不动(落盘时放回),
		// 由读它的集成各读各的格、停各自那一样。读盘本身出错(没权限、路径是个目录)照旧挡开机。
		for (const segment of this.segments.values()) await this.loadIntegrationSegment(segment);
		this.meta["integration-settings"].exists = true;

		// 各拓展的设置 —— 一个拓展一个文件。仓不认得它们的形状,原样读进来(核对归拓展自己那份 zod)。
		// 一个拓展的文件读不懂只停它自己,不挡开机(读盘本身出错照旧挡)。
		const extensionFiles = await readExtensionSettingsDir(
			join(this.stateDir, ...EXTENSION_SETTINGS_IN_CONFIG),
		);
		for (const [id, value] of extensionFiles.settings) this.extensionSettings.set(id, value);
		for (const [id, issue] of extensionFiles.unreadable)
			this.extensionSettingsIssues.set(id, issue);

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
		if (this.invalidSettings.length > 0) this.notifyInvalidSettings();
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

		this.connections = connectionsRaw.map((raw, idx) =>
			readConnection(raw, idx, (msg) => this.serviceCtx.logger.warn(msg)),
		);
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

	getInvalidSettings(): InvalidSettingEntry[] {
		return deepClone(this.invalidSettings);
	}

	readIntegrationSettings(key: string): Result<{ settings: unknown }> {
		if (!this.segments.has(key)) {
			throw new Error(`集成「${key}」的设置没有登记进配置仓(组装处漏了)`);
		}
		const unreadable = this.integrationUnreadable.get(key);
		if (unreadable) {
			return fail("invalid", `设置文件读不懂：${unreadable.message}`, {
				issues: [{ ...unreadable }],
			});
		}
		// 盘上那一份:内存值(坏格是默认值)上把坏格的原文盖回去。读的人拿自己的 schema 判自己那一格。
		const settings = deepClone(this.integrationSettings.get(key));
		const invalid = this.integrationInvalid.get(key) ?? [];
		return ok({ settings: invalid.length > 0 ? withRawSettings(settings, invalid) : settings });
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

	extensionSettingsIssue(id: string): Issue | undefined {
		return this.extensionSettingsIssues.get(id);
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
	private async writeGlobals(
		g: GlobalConfig,
		mode: "compare" | "replace" = "compare",
	): Promise<void> {
		// 哪些被隔离的格这次仍算「没动」:新旧两份在那条路径上比值(两边都是 zod 的规范形态,比 JSON 就够)。
		// 不比「补丁里有没有这个键」:面板的补丁值没变也照发(规则页每次带 `defaults` 下的整格),按键判会让主人
		// 改个时间段就把没碰过的坏格原文盖掉。`replace` 是恢复备份:以给的这份为准,本机的坏格一起换掉、不放回。
		//
		// 单家的条目(`ai.providers.<id>`)不比值:内存里那个键永远不在,「没动」只有一种样子 —— 新的这份里也没有
		// 这个自己的键(`Object.hasOwn`,不走 `valueAt` 的路径取值)。新的这份里有了(面板新加的一家 id 撞上它)
		// 在写任何东西之前就拒收了(见 {@link assertNoBrokenInstanceIdTaken}),所以走到这里时它实际恒为「没动」。
		if (mode === "compare") this.assertNoBrokenInstanceIdTaken(g);
		const retained =
			mode === "replace"
				? []
				: this.invalidSettings.filter((e) => {
						const id = instanceIdOfEntry(e.path);
						if (id !== undefined) return !Object.hasOwn(g.ai.providers, id);
						return (
							JSON.stringify(valueAt(g, e.path)) === JSON.stringify(valueAt(this.globals, e.path))
						);
					});
		if (this.secretStore) {
			// P2:此前 save 成功后 persistGlobals 抛错 → 密钥袋已存新 apiKey 但
			// settings/core.json/in-memory 仍旧值 → 重启后两边分叉。失败即回滚密钥袋,
			// 两端始终一致(全旧或全新);in-memory 仅在双写都成功后更新。
			const prevBag = this.secretBag;
			// 整份重算而不是并进旧袋:主人删掉一家时,那家的 key 必须跟着消失,
			// 否则删了又加回来会拿到一把他以为已经删掉的旧密钥。唯一的例外是仍被隔离的那一格名下的旧键:
			// 那一格在内存里是默认值(`ai.providers` 里一家坏了则是那一家不在),收集不到它们,重算会把它们洗空,
			// 主人把那一格改对时 key 已经没了。留哪些键见 {@link isolatedSecrets} 的三档。
			const nextBag = {
				...this.secretBag,
				aiApiKey: undefined,
				aiApiKeys: {
					...isolatedSecrets(this.secretBag.aiApiKeys ?? {}, retained),
					...collectAiSecrets(g),
				},
			};
			await this.secretStore.save(nextBag);
			try {
				await this.persistGlobals(g, retained);
			} catch (e) {
				this.secretBag = prevBag;
				await this.secretStore.save(prevBag).catch(() => {});
				throw e;
			}
			this.secretBag = nextBag;
		} else {
			await this.persistGlobals(g, retained);
		}
		// 落盘成功之后才换内存与坏格表;失败的话上面已经抛出去,两样都原样不动。
		this.globals = g;
		if (retained.length !== this.invalidSettings.length) this.invalidSettingsChanged = true;
		this.invalidSettings = retained;
	}

	/**
	 * 新的这份里有一家的 id 正是某一家读不懂的 AI 实例的 id(面板挑 id 时看不见坏着的那一家,会撞上):这次保存拒收,
	 * 逐格原因的路径是 `["ai","providers","<id>"]`。**要在写任何东西之前调**(存袋之前、同一发补丁里的集成设置文件
	 * 落盘之前):放行的话新的一家会把坏的那一家的原文与存着的密钥悄悄换掉。
	 */
	private assertNoBrokenInstanceIdTaken(g: GlobalConfig): void {
		const taken = this.invalidSettings.flatMap((e) => {
			const id = instanceIdOfEntry(e.path);
			return id !== undefined && Object.hasOwn(g.ai.providers, id) ? [id] : [];
		});
		if (taken.length === 0) return;
		throw ConfigValidationError.fromIssues(
			"globals",
			taken.map((id) => ({
				path: ["ai", "providers", id],
				message: brokenInstanceIdTakenMessage(id),
			})),
		);
	}

	/** 通知组装处坏格表现在的样子。 */
	private notifyInvalidSettings(): void {
		try {
			this.onInvalidSettingsChanged?.(this.getInvalidSettings());
		} catch (err) {
			this.serviceCtx.logger.warn(`[config] 通知核心设置的坏格表失败: ${errorMessageOf(err)}`);
		}
	}

	/** 写让坏格表变了就通知一次。在写队列**外**调:回调里的人可能再读配置仓。 */
	private announceInvalidSettings(): void {
		if (!this.invalidSettingsChanged) return;
		this.invalidSettingsChanged = false;
		this.notifyInvalidSettings();
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
		this.announceInvalidSettings();
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
				// 撞上坏着的那一家的 id:这一步就拒收,同一发里的集成设置文件还没动。
				this.assertNoBrokenInstanceIdTaken(parsed.data);
				// 只在这次真动了主人那一格时才查:盘上读进来的旧值(群 / 目标没了)不该让别的设置也存不进去。
				if (patch.core.master !== undefined) {
					assertMasterTarget(parsed.data.master, this.targets, "globals");
				}
				core = parsed.data;
			}
			const integrations = new Map(
				keys.map((key) => [key, this.nextIntegrationSettings(key, patch.integrations?.[key])]),
			);
			// 这一发里仍被隔离的格(比值,同核心那份 `writeGlobals` 的规矩):合并后的值与内存里跑着的默认值一样就是
			// 「没动」—— 系统页保存时同一块的格子一起发,坏格显示的是默认值,按「补丁里有没有这个键」判会把没碰过的
			// 坏格原文盖掉。整个文件读不懂的没有可放回的格,补丁带了这一段就整文件重写。
			const retained = new Map(
				[...integrations].map(([key, next]) => [
					key,
					(this.integrationInvalid.get(key) ?? []).filter(
						(e) =>
							JSON.stringify(valueAt(next, e.path)) ===
							JSON.stringify(valueAt(this.integrationSettings.get(key), e.path)),
					),
				]),
			);

			// ---- 2) 落盘:集成的先写,核心的最后写;核心那份(连密钥袋)写失败,把写过的集成推回原样 ----
			// 回滚按**字节**:盘上可能留着坏格原文(或整份半截 JSON),把内存值写回去会被默认值换掉。
			const written: Array<{ path: string; before: FileSnapshot | undefined }> = [];
			try {
				for (const [key, next] of integrations) {
					const path = this.integrationPath(key);
					const before = await snapshotFile(path);
					await atomicWriteJson(path, withRawSettings(next, retained.get(key) ?? []));
					written.push({ path, before });
				}
				if (core) await this.writeGlobals(core);
			} catch (e) {
				for (const { path, before } of written) await restoreFile(path, before).catch(() => {});
				throw e;
			}

			// ---- 3) 都写成了才换进内存与坏格表(核心那份 writeGlobals 已经换了) ----
			for (const [key, next] of integrations) {
				this.integrationSettings.set(key, next);
				const left = retained.get(key) ?? [];
				if (left.length > 0) this.integrationInvalid.set(key, left);
				else this.integrationInvalid.delete(key);
				this.integrationUnreadable.delete(key);
			}
			if (core) this.touch("globals");
			if (integrations.size > 0) this.touch("integration-settings");
			return { core: this.globals, integrations: Object.fromEntries(this.integrationSettings) };
		});
		this.announceInvalidSettings();
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
			// 重存以新值为准:原来那份读不懂的文件已经被整个盖掉了(写盘成功才算)。
			this.extensionSettingsIssues.delete(id);
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
			// 读不懂的文件也要删,不然装回同 id 时坏文件原样回来。
			const settings = this.extensionSettings.has(id) || this.extensionSettingsIssues.has(id);
			if (settings) {
				await rm(path, { force: true });
				this.extensionSettings.delete(id);
				this.extensionSettingsIssues.delete(id);
				this.touch("integration-settings");
			}
			return { core, settings };
		});
		this.announceInvalidSettings();
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
		this.announceInvalidSettings();
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
		const targetsChanged = hasManagedTarget(connection)
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
		await this.writeConnection({ mode: "upsert", connection });
	}

	async createConnection(input: unknown, platformSnapshot: PlatformSnapshot): Promise<void> {
		await this.writeConnection({ mode: "create", input, platformSnapshot });
	}

	/**
	 * 适配器在场:按它的 `settingsSchema` 解,不过抛 `invalid`(原因的路径以 `settings` 打头),过了回解过的值
	 * (补了默认值);不在场:原样(形状归适配器,此刻没人能验)。
	 */
	private validatedSettings(adapterKey: string, settings: unknown): unknown {
		const schema = this.connectionSettingsSchemaOf(adapterKey);
		if (!schema) return settings;
		const parsed = schema.safeParse(settings);
		if (!parsed.success) {
			throw ConfigValidationError.fromZod("connections", parsed.error, { prefix: ["settings"] });
		}
		return parsed.data;
	}

	private async writeConnection(
		job:
			| { mode: "upsert"; connection: Connection }
			| { mode: "create"; input: unknown; platformSnapshot: PlatformSnapshot },
	): Promise<void> {
		const saved = await this.runScoped("connections", async () => {
			let candidate: unknown;
			if (job.mode === "create") {
				// 宿主独写的两格(快照、探测状态)不在这份 schema 里,带来了也被剥掉。
				const draft = NewConnectionSchema.safeParse(job.input);
				if (!draft.success) throw ConfigValidationError.fromZod("connections", draft.error);
				if (this.connections.some((a) => a.id === draft.data.id)) {
					throw ConfigValidationError.conflict(
						"connections",
						"这条连接已经存在 —— 要改请用 PATCH /api/connections/:id,新建别复用 id",
					);
				}
				candidate = { ...draft.data, platformSnapshot: job.platformSnapshot };
			} else {
				candidate = job.connection;
			}
			const parsed = ConnectionSchema.safeParse(candidate);
			if (!parsed.success) {
				throw ConfigValidationError.fromZod("connections", parsed.error);
			}
			const connection: Connection = {
				...parsed.data,
				settings: this.validatedSettings(parsed.data.adapterKey, parsed.data.settings),
			};
			const existing = this.connections.find((a) => a.id === connection.id);
			if (existing) assertConnectionIdentityStable(existing, connection);
			const next = upsertById(this.connections, connection);
			await atomicWriteJson(this.path("connections"), next);
			this.connections = next;
			this.touch("connections");
			return connection;
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
			// 快照与探测状态只有宿主写:补丁里带来的一律忽略。
			const { platformSnapshot: _snapshot, probeState: _probe, ...rest } = patch;
			const merged = deepMerge(current, { ...rest, id });
			const parsed = ConnectionSchema.safeParse(merged);
			if (!parsed.success) {
				throw ConfigValidationError.fromZod("connections", parsed.error);
			}
			assertConnectionIdentityStable(current, parsed.data);
			// 只有补丁动到了 settings 才验(SV 规矩 2:存量里别的不合规的不连坐)—— 被隔离的连接才能改名、能停用。
			const connection: Connection =
				rest.settings === undefined
					? parsed.data
					: {
							...parsed.data,
							settings: this.validatedSettings(parsed.data.adapterKey, parsed.data.settings),
						};
			const next = [...this.connections];
			next[idx] = connection;
			await atomicWriteJson(this.path("connections"), next);
			this.connections = next;
			this.touch("connections");
			return connection;
		});
		await this.syncWebhookSideEffects(result);
		return deepClone(result);
	}

	async recordConnectionProbeState(id: string, state: ConnectionProbeState): Promise<Connection> {
		const result = await this.runScoped("connections", async () => {
			const idx = this.connections.findIndex((a) => a.id === id);
			if (idx < 0) {
				throw ConfigValidationError.notFound("connections", `没有 id 为 ${id} 的连接`);
			}
			const next = [...this.connections];
			next[idx] = { ...(this.connections[idx] as Connection), probeState: state };
			await atomicWriteJson(this.path("connections"), next);
			this.connections = next;
			this.touch("connections");
			return next[idx] as Connection;
		});
		this.bus.emit("config-changed", { scope: "connections" });
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
			if (!hasManagedTarget(connection) && referencing.length > 0) {
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
		if (hasManagedTarget(removedConnection)) {
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
			assertTargetKeepsConnection(
				this.targets.find((t) => t.id === parsed.data.id),
				parsed.data,
			);
			assertTargetOwner(parsed.data, this.connections);
			if (this.globals.master?.targetId === parsed.data.id && !isPrivateTarget(parsed.data)) {
				throw ConfigValidationError.invalid("targets", MASTER_TARGET_IN_USE);
			}
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
			if (owner && hasManagedTarget(owner)) {
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
			assertTargetKeepsConnection(current, parsed.data);
			assertTargetOwner(parsed.data, this.connections);
			if (this.globals.master?.targetId === id && !isPrivateTarget(parsed.data)) {
				throw ConfigValidationError.invalid("targets", MASTER_TARGET_IN_USE);
			}
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

	async recordTargetReachability(
		id: string,
		reachability: TargetReachability,
	): Promise<PushTarget> {
		const result = await this.runScoped("targets", async () => {
			const idx = this.targets.findIndex((t) => t.id === id);
			if (idx < 0) {
				throw ConfigValidationError.notFound("targets", `没有 id 为 ${id} 的推送目标`);
			}
			const next = [...this.targets];
			next[idx] = { ...(this.targets[idx] as PushTarget), reachability };
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
			if (this.globals.master?.targetId === id) {
				throw ConfigValidationError.conflict("targets", `不能直接删，${MASTER_TARGET_IN_USE}`);
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
			// 目标不再自带平台,连接的平台与目标的归属得靠这里守:一条统一的规矩,见函数注释。
			assertRetainedTargetsKeepOwner(this.targets, effTargets, this.connections, effConnections);
			assertMasterTarget((globals ?? this.globals).master, effTargets, "globals");
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
				// 恢复是「以这一份为准」的整体替换:本机的坏格一起换掉、问题清掉,不比值、不放回。
				if (globals) await this.writeGlobals(globals, "replace");
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
				for (const [key, value] of integrations ?? []) {
					this.integrationSettings.set(key, value);
					// 恢复是「以这一份为准」:本机的坏格与读不懂的原因一起清,不比值、不放回。
					this.integrationInvalid.delete(key);
					this.integrationUnreadable.delete(key);
				}
				for (const { id, value } of extensionSettings) {
					this.extensionSettings.set(id, value);
					this.extensionSettingsIssues.delete(id);
				}
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
		this.announceInvalidSettings();
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

/**
 * 读盘时的一条连接:只有**外壳**(id / name / enabled / adapterKey / platform)坏了才抛、挡开机
 * (SV 规矩 9)。`settings` 原样留着(不解、不补默认值)—— 它过不过得了适配器的规则要等适配器在场才知道
 * (读盘那一刻一个适配器都不在场),所以「隔离」不存在配置仓里,用的时候现算。
 * `platformSnapshot` / `probeState` 是宿主自己写的派生物,坏了在内存里退成中性快照 / 没探过,盘上不动。
 */
function readConnection(raw: unknown, idx: number, warn: (msg: string) => void): Connection {
	const shell = ConnectionShellSchema.safeParse(raw);
	if (!shell.success) {
		throw ConfigValidationError.fromZod("connections", shell.error, {
			subject: `connections.json 第 ${idx + 1} 行`,
			prefix: [idx],
		});
	}
	const record = raw as Record<string, unknown>;
	const snapshot = PlatformSnapshotSchema.safeParse(record.platformSnapshot);
	if (!snapshot.success) {
		warn(`[config] 连接「${shell.data.name}」的 platformSnapshot 读不了,先按认不出的平台画`);
	}
	const probe = ConnectionProbeStateSchema.safeParse(record.probeState);
	return {
		...shell.data,
		settings: record.settings,
		platformSnapshot: snapshot.success
			? snapshot.data
			: neutralPlatformSnapshot(shell.data.platform),
		...(probe.success ? { probeState: probe.data } : {}),
	};
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
 * (写到一半的临时文件、手放的别的东西)不认。
 *
 * 读盘本身出错(没权限、路径是个目录)是开机报错,同别的配置文件;但**内容不是合法 JSON**只算那一个拓展的
 * 事 —— 一个拓展的手改坏了不该让整台起不来。所以 `readFile` 与 `JSON.parse` 分开,只认后者抛的
 * `SyntaxError`;文件不动,留给主人重存或卸载。
 */
async function readExtensionSettingsDir(dir: string): Promise<{
	settings: Array<[string, unknown]>;
	unreadable: Array<[string, Issue]>;
}> {
	let names: string[];
	try {
		names = await readdir(dir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { settings: [], unreadable: [] };
		throw err;
	}
	const settings: Array<[string, unknown]> = [];
	const unreadable: Array<[string, Issue]> = [];
	for (const name of names.sort()) {
		if (!name.endsWith(".json")) continue;
		const id = name.slice(0, -".json".length);
		if (!ExtensionIdSchema.safeParse(id).success) continue;
		const text = await readFile(join(dir, name), "utf8");
		try {
			settings.push([id, JSON.parse(text) as unknown]);
		} catch (err) {
			if (!(err instanceof SyntaxError)) throw err;
			unreadable.push([id, { message: jsonSyntaxMessage(err) }]);
		}
	}
	return { settings, unreadable };
}

/** 把设置文件的文字读成对象;读不懂(不是合法 JSON、顶层不是对象)回原因,原因里不带文件内容。 */
function readJsonObject(text: string): { value: Record<string, unknown> } | { issue: Issue } {
	let value: unknown;
	try {
		value = JSON.parse(text) as unknown;
	} catch (err) {
		if (!(err instanceof SyntaxError)) throw err;
		return { issue: { message: jsonSyntaxMessage(err) } };
	}
	return isPlainObject(value) ? { value } : { issue: { message: "顶层不是一个对象" } };
}

/**
 * `JSON.parse` 的报错话。有的写法会把文件开头那一截抄进报错(`Unexpected token 'x', "…" is not valid
 * JSON`),这里不带文件内容 —— 设置里可能有密钥,而这句话会进面板与日志。
 */
function jsonSyntaxMessage(err: SyntaxError): string {
	return /is not valid JSON$/.test(err.message) ? "Unexpected token (not valid JSON)" : err.message;
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
		if (!segment.schema.safeParse({}).success) {
			throw new Error(`集成设置「${segment.key}」的格式过不了空对象(每一格都得有默认值或可选)`);
		}
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
