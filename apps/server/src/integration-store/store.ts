import { readdir } from "node:fs/promises";
import {
	createSerialQueue,
	type Disposable,
	ExtensionIdSchema,
	fail,
	type Json,
	type KeyValueOp,
	type KeyValueStore,
	type Logger,
	ok,
	type Result,
} from "@bilibili-notify/internal";
import { type KeyProvider, removeDirectory } from "@bilibili-notify/storage";
import { t as serverText } from "../i18n/index.js";
import { stringLeaves, type ValueRedactor } from "../logs/value-redactor.js";
import { dataPath } from "../runtime/roots.js";
import { errorMessageOf } from "../util/error-message.js";
import {
	integrationSecretsDir,
	integrationStateDir,
	readIntegrationSecretsFile,
	readIntegrationStateFile,
	type StoreFileReadResult,
	writeIntegrationSecretsFile,
	writeIntegrationStateFile,
} from "./files.js";
import { HTTP_IDENTITY_KEY } from "./host-keys.js";
import {
	createKeyValueStores,
	type KeyValueStoreHandle,
	SECRETS_LIMITS,
	STATE_LIMITS,
} from "./key-value-store.js";

/**
 * 集成的 state / secrets 存储宿主(ADR-0025 决策 9、10):按集成键开 / 关 / 删,备份的导出与恢复,
 * 整个宿主一条写道、关停时关门。内置集成与拓展用同一套,差别只在落在哪个目录(见 `files.ts`)。
 */

export interface CreateIntegrationStoreOptions {
	reservedIntegrationKeys: readonly string[];
	dataRoot: string;
	/** runtime 那一个,与 `config-secrets.enc` 同一把主密钥。 */
	keyProvider: KeyProvider;
	logger: Logger;
	/**
	 * 日志按值打码的登记册(运行时只建一个,日志出口按它遮):每个集成 `secrets` 里的每一段字符串(含宿主那一面的
	 * `http.` 键)在开把手时、每次落盘成功后、恢复备份整袋换之后登记;其它值经把手的 `redact` 登记;
	 * 把手关了全撤。`state` 不登记(明文、不是凭据)。
	 */
	redactor: Pick<ValueRedactor, "replace" | "clear">;
}

export interface IntegrationStore {
	/** Clear only the stored HTTP identity; the live client retains its current identity. */
	resetHttpIdentity(key: string): Promise<Result>;
	/** 把这个集成的两份文件读进内存,交回它的把手。同一个键已经开着就抛(那是装配的 bug)。 */
	open(key: string): Promise<IntegrationStoreHandle>;
	isOpen(key: string): boolean;
	/** 卸载时用:两份文件连目录一起删。还开着的拒(`conflict`);保留键(内置集成)也拒(`invalid`),内置没有卸载。 */
	remove(key: string): Promise<Result>;
	/**
	 * 备份用:每个有内容的集成一格。开着的读内存,没开的读盘;读不了或解不开的那一份跳过、记 warn。
	 * 带的是整袋,**包括宿主那一面写的 `http.` 开头的键**(登录的 cookie 就在 `http.cookies`,完整备份必须带走)。
	 */
	exportSecrets(): Promise<Record<string, Record<string, Json>>>;
	/** 恢复备份用:把这个集成的密钥整袋换掉(内存与盘一起),再叫它登记的「被换了」。没开着回 `unavailable`。 */
	restoreSecrets(key: string, entries: Record<string, Json>): Promise<Result>;
	/** 关停的 `flush` 段:等在路上的写落完,之后的写一律回 `unavailable`。 */
	close(): Promise<void>;
}

/** 经把手 `redact` 登记的值的种类(闭集;宿主自己的 `secrets` 那一种不经这个口)。 */
export type RedactKind = "cookies" | "redact";

export interface IntegrationStoreHandle {
	/** 集成那一面:`http.` 开头的键拒。 */
	readonly state: KeyValueStore;
	readonly secrets: KeyValueStore;
	/** 宿主自己那一面(同一袋):只许 `http.` 开头的键,别的拒 —— 宿主也不许碰集成的键。 */
	readonly hostState: KeyValueStore;
	readonly hostSecrets: KeyValueStore;
	/**
	 * **只在 `integration-store/` 与 `integrations/http.ts` 之间用**:宿主那一面的 `http.` 键(罐子)与集成自己的
	 * `secrets` 改动合成**一次**原子写(`KeyValueStoreHandle.commit`,一个写道任务、一次落盘),绝不是先后两次。
	 * 宿主那一组是函数,进了写道才调。
	 */
	commitSecrets(
		hostOps: () => readonly KeyValueOp[],
		integrationOps: readonly KeyValueOp[],
	): Promise<Result>;
	/**
	 * 登记要在日志里按值遮的值。归属就是这个把手的集成,不另传;`kind` 是这批值的种类,同一种**整批换**
	 * (旧的不再遮,给空就是撤掉这一种);少于 8 个字符的值不遮。把手 `close()` 时这个集成名下所有种类一起撤,
	 * 关了之后再登记的不收。种类是闭集:`cookies` 是罐子里的 cookie 值(`integrations/http.ts`),`redact` 是
	 * 集成经 `ctx.redact` 登记的临时凭据(`integrations/context.ts` 攒住全部、每次整批交)。
	 * `secrets` 袋里的字符串宿主自己登记(种类 `secrets`),不经这个口。
	 */
	redact(kind: RedactKind, values: Iterable<string>): void;
	/** 密钥被 `restoreSecrets` 整袋换了之后叫;按登记的先后逐个等。 */
	onSecretsReplaced(fn: () => void | Promise<void>): Disposable;
	/** 集成停下时关:此后四个存储的写一律回 `unavailable`;文件留着。幂等。 */
	close(): void;
}

interface OpenEntry {
	hostState: IntegrationStoreHandle["hostState"];
	secrets: KeyValueStoreHandle;
	replacedHooks: Array<() => void | Promise<void>>;
}

/** 集成的上下文收摊之后再关它的存储把手 —— 内置适配器与拓展装载器都是这个次序,别在各处各写一遍。 */
export async function disposeThenClose(
	integration: { dispose(): Promise<void> },
	handle: Pick<IntegrationStoreHandle, "close">,
): Promise<void> {
	try {
		await integration.dispose();
	} finally {
		handle.close();
	}
}

/**
 * 登记册里 `secrets` 这一种的名字,归存储宿主自己(`secrets` 袋有变就整批换)。别的种类(罐子的 `cookies` 之类)
 * 经把手的 `redact` 登记,不要再用这个名字。
 */
const SECRETS_KIND = "secrets";

export function createIntegrationStore(opts: CreateIntegrationStoreOptions): IntegrationStore {
	const { dataRoot, keyProvider, logger, redactor } = opts;
	const reservedIntegrationKeys = [...opts.reservedIntegrationKeys];
	const isKnownKey = (key: string) =>
		reservedIntegrationKeys.includes(key) || ExtensionIdSchema.safeParse(key).success;
	/** 整个宿主一条写道:键是 `<集成键>:state` / `<集成键>:secrets`。 */
	const queue = createSerialQueue();
	const opened = new Map<string, OpenEntry>();
	/** 正在读盘、还没交回把手的键:并发开同一个也算「已经开着」。 */
	const opening = new Set<string>();

	const stateLane = (key: string) => `${key}:state`;
	const secretsLane = (key: string) => `${key}:secrets`;

	function unreadableNote(
		file: string,
		key: string,
		read: StoreFileReadResult,
	): string | undefined {
		if (read.kind === "ok") return undefined;
		logger.error(
			`[integration-store] ${key} 的 ${file} 在盘上但读不了(${read.message}):这一份读一律空、写一律拒,盘上原文件不动`,
		);
		return serverText("service.integration-store.store.text.1", {
			value0: key,
			value1: file,
			value2: read.message,
		});
	}

	async function open(key: string): Promise<IntegrationStoreHandle> {
		if (!isKnownKey(key))
			throw new Error(serverText("service.integration-store.store.text.2", { value0: key }));
		if (opened.has(key) || opening.has(key)) {
			throw new Error(serverText("service.integration-store.store.text.3", { value0: key }));
		}
		opening.add(key);
		try {
			// 上一份把手关了之后它在路上的写可能还没落完:先等到这个集成的写道走空,免得读到旧盘面。
			await Promise.all([
				queue.run(stateLane(key), () => undefined),
				queue.run(secretsLane(key), () => undefined),
			]).catch(() => {
				// 写道关了(关停之后才来开):读照读,写会被拒。
			});
			const [stateRead, secretsRead] = await Promise.all([
				readIntegrationStateFile({ dataRoot, key, logger, reservedIntegrationKeys }),
				readIntegrationSecretsFile({ dataRoot, key, logger, keyProvider, reservedIntegrationKeys }),
			]);
			const stateUnreadable = unreadableNote("state.json", key, stateRead);
			const secretsUnreadable = unreadableNote("secrets.enc", key, secretsRead);

			let closed = false;
			const closedNote = () =>
				closed ? serverText("service.integration-store.store.text.4", { value0: key }) : undefined;

			const state = createKeyValueStores({
				initial: stateRead.kind === "ok" ? stateRead.entries : undefined,
				limits: STATE_LIMITS,
				persist: (entries) =>
					writeIntegrationStateFile(dataRoot, key, entries, reservedIntegrationKeys),
				lane: (task) => queue.run(stateLane(key), task),
				blocked: () => closedNote() ?? stateUnreadable,
			});
			const secrets = createKeyValueStores({
				initial: secretsRead.kind === "ok" ? secretsRead.entries : undefined,
				limits: SECRETS_LIMITS,
				persist: (entries) =>
					writeIntegrationSecretsFile(
						{ dataRoot, key, keyProvider, reservedIntegrationKeys },
						entries,
					),
				lane: (task) => queue.run(secretsLane(key), task),
				blocked: () => closedNote() ?? secretsUnreadable,
				// 把手关了之后才落完的写(关之前已经排上的)不再登记:关的那一刻已经撤干净了。
				onChange: (entries) => {
					if (closed) return;
					redactor.replace(key, SECRETS_KIND, [...entries.values()].flatMap(stringLeaves));
				},
			});
			const entry: OpenEntry = { secrets, hostState: state.host, replacedHooks: [] };
			opened.set(key, entry);
			return {
				state: state.integration,
				secrets: secrets.integration,
				hostState: state.host,
				hostSecrets: secrets.host,
				commitSecrets: secrets.commit,
				redact(kind, values) {
					// 关了之后不再收:关的那一刻已经撤干净了,晚来的登记会变成永远撤不掉的残留。
					if (closed) return;
					redactor.replace(key, kind, values);
				},
				onSecretsReplaced(fn) {
					entry.replacedHooks.push(fn);
					return {
						dispose() {
							const at = entry.replacedHooks.indexOf(fn);
							if (at >= 0) entry.replacedHooks.splice(at, 1);
						},
					};
				},
				close() {
					if (closed) return;
					closed = true;
					// 这个集成名下所有种类的值一起撤(`secrets` 的、罐子的、以后 `ctx.redact` 的)。
					redactor.clear(key);
					if (opened.get(key) === entry) opened.delete(key);
				},
			};
		} finally {
			opening.delete(key);
		}
	}

	async function remove(key: string): Promise<Result> {
		if (reservedIntegrationKeys.includes(key)) {
			return fail("invalid", serverText("service.integration-store.store.text.5", { value0: key }));
		}
		if (!isKnownKey(key))
			return fail("invalid", serverText("service.integration-store.store.text.6", { value0: key }));
		if (opened.has(key) || opening.has(key)) {
			return fail(
				"conflict",
				serverText("service.integration-store.store.text.7", { value0: key }),
			);
		}
		// 排在各自写道的末尾:在途的写先落完,再删目录。
		const removals = [
			queue.run(stateLane(key), () =>
				removeDirectory(dataPath(dataRoot, ...integrationStateDir(key, reservedIntegrationKeys))),
			),
			queue.run(secretsLane(key), () =>
				removeDirectory(dataPath(dataRoot, ...integrationSecretsDir(key, reservedIntegrationKeys))),
			),
		];
		try {
			await Promise.all(removals);
			return ok();
		} catch (err) {
			return fail(
				"unavailable",
				serverText("service.integration-store.store.text.8", {
					value0: key,
					value1: errorMessageOf(err),
				}),
			);
		}
	}

	/** 盘上 `secrets/extensions/` 底下认得的拓展 id(别的残留不当集成)。 */
	async function extensionDirsOnDisk(): Promise<string[]> {
		try {
			const names = await readdir(dataPath(dataRoot, "secrets", "extensions"));
			return names.filter(
				(name) =>
					!reservedIntegrationKeys.includes(name) && ExtensionIdSchema.safeParse(name).success,
			);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
			logger.warn(`[integration-store] 列不了 secrets/extensions/:${errorMessageOf(err)}`);
			return [];
		}
	}

	async function exportSecrets(): Promise<Record<string, Record<string, Json>>> {
		const keys = new Set<string>([
			...reservedIntegrationKeys,
			...(await extensionDirsOnDisk()),
			...opened.keys(),
		]);
		const out: Record<string, Record<string, Json>> = {};
		for (const key of keys) {
			const live = opened.get(key);
			let entries: Map<string, Json>;
			if (live) {
				entries = live.secrets.snapshot();
			} else {
				const read = await readIntegrationSecretsFile({
					dataRoot,
					key,
					logger,
					keyProvider,
					reservedIntegrationKeys,
				});
				if (read.kind === "unreadable") {
					logger.warn(`[integration-store] 备份跳过 ${key} 的密钥:${read.message}`);
					continue;
				}
				entries = read.entries;
			}
			if (entries.size > 0) out[key] = Object.fromEntries(entries);
		}
		return out;
	}

	async function restoreSecrets(key: string, entries: Record<string, Json>): Promise<Result> {
		const live = opened.get(key);
		if (!live)
			return fail(
				"unavailable",
				serverText("service.integration-store.store.text.9", { value0: key }),
			);
		const replaced = await live.secrets.replace(new Map(Object.entries(entries)));
		if (!replaced.ok) return replaced;
		for (const hook of [...live.replacedHooks]) {
			try {
				await hook();
			} catch (err) {
				logger.error(
					`[integration-store] ${key} 登记的「密钥被换了」回调抛了:${errorMessageOf(err)}`,
				);
			}
		}
		return ok();
	}

	return {
		open,
		async resetHttpIdentity(key) {
			const live = opened.get(key);
			if (!live) return fail("unavailable", serverText("settings.identity.unavailable"));
			return live.hostState.delete(HTTP_IDENTITY_KEY);
		},
		isOpen: (key) => opened.has(key),
		remove,
		exportSecrets,
		restoreSecrets,
		close: () => queue.close(),
	};
}
