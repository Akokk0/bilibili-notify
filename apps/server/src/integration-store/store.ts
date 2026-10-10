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
	RESERVED_INTEGRATION_KEYS,
	type Result,
} from "@bilibili-notify/internal";
import { type KeyProvider, removeDirectory } from "@bilibili-notify/storage";
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
	dataRoot: string;
	/** runtime 那一个,与 `config-secrets.enc` 同一把主密钥。 */
	keyProvider: KeyProvider;
	logger: Logger;
}

export interface IntegrationStore {
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
	/** 密钥被 `restoreSecrets` 整袋换了之后叫;按登记的先后逐个等。 */
	onSecretsReplaced(fn: () => void | Promise<void>): Disposable;
	/** 集成停下时关:此后四个存储的写一律回 `unavailable`;文件留着。幂等。 */
	close(): void;
}

interface OpenEntry {
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

function isKnownKey(key: string): boolean {
	return RESERVED_INTEGRATION_KEYS.includes(key) || ExtensionIdSchema.safeParse(key).success;
}

export function createIntegrationStore(opts: CreateIntegrationStoreOptions): IntegrationStore {
	const { dataRoot, keyProvider, logger } = opts;
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
		return `${key} 的 ${file} 读不了(${read.message}),写入一律拒绝`;
	}

	async function open(key: string): Promise<IntegrationStoreHandle> {
		if (!isKnownKey(key)) throw new Error(`集成键不合法,开不了存储:${key}`);
		if (opened.has(key) || opening.has(key)) {
			throw new Error(`集成 ${key} 的存储已经开着,同一个集成不能同时开两份`);
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
				readIntegrationStateFile({ dataRoot, key, logger }),
				readIntegrationSecretsFile({ dataRoot, key, logger, keyProvider }),
			]);
			const stateUnreadable = unreadableNote("state.json", key, stateRead);
			const secretsUnreadable = unreadableNote("secrets.enc", key, secretsRead);

			let closed = false;
			const closedNote = () => (closed ? `集成 ${key} 已停下,存储不再接受写入` : undefined);

			const state = createKeyValueStores({
				initial: stateRead.kind === "ok" ? stateRead.entries : undefined,
				limits: STATE_LIMITS,
				persist: (entries) => writeIntegrationStateFile(dataRoot, key, entries),
				lane: (task) => queue.run(stateLane(key), task),
				blocked: () => closedNote() ?? stateUnreadable,
			});
			const secrets = createKeyValueStores({
				initial: secretsRead.kind === "ok" ? secretsRead.entries : undefined,
				limits: SECRETS_LIMITS,
				persist: (entries) => writeIntegrationSecretsFile({ dataRoot, key, keyProvider }, entries),
				lane: (task) => queue.run(secretsLane(key), task),
				blocked: () => closedNote() ?? secretsUnreadable,
			});
			const entry: OpenEntry = { secrets, replacedHooks: [] };
			opened.set(key, entry);
			return {
				state: state.integration,
				secrets: secrets.integration,
				hostState: state.host,
				hostSecrets: secrets.host,
				commitSecrets: secrets.commit,
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
					if (opened.get(key) === entry) opened.delete(key);
				},
			};
		} finally {
			opening.delete(key);
		}
	}

	async function remove(key: string): Promise<Result> {
		if (RESERVED_INTEGRATION_KEYS.includes(key)) {
			return fail("invalid", `${key} 是内置集成,没有卸载`);
		}
		if (!isKnownKey(key)) return fail("invalid", `集成键不合法:${key}`);
		if (opened.has(key) || opening.has(key)) {
			return fail("conflict", `集成 ${key} 的存储还开着,先让它停下再删`);
		}
		// 排在各自写道的末尾:在途的写先落完,再删目录。
		const removals = [
			queue.run(stateLane(key), () =>
				removeDirectory(dataPath(dataRoot, ...integrationStateDir(key))),
			),
			queue.run(secretsLane(key), () =>
				removeDirectory(dataPath(dataRoot, ...integrationSecretsDir(key))),
			),
		];
		try {
			await Promise.all(removals);
			return ok();
		} catch (err) {
			return fail("unavailable", `清不掉集成 ${key} 存的状态与密钥:${errorMessageOf(err)}`);
		}
	}

	/** 盘上 `secrets/extensions/` 底下认得的拓展 id(别的残留不当集成)。 */
	async function extensionDirsOnDisk(): Promise<string[]> {
		try {
			const names = await readdir(dataPath(dataRoot, "secrets", "extensions"));
			return names.filter((name) => ExtensionIdSchema.safeParse(name).success);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
			logger.warn(`[integration-store] 列不了 secrets/extensions/:${errorMessageOf(err)}`);
			return [];
		}
	}

	async function exportSecrets(): Promise<Record<string, Record<string, Json>>> {
		const keys = new Set<string>([
			...RESERVED_INTEGRATION_KEYS,
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
				const read = await readIntegrationSecretsFile({ dataRoot, key, logger, keyProvider });
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
		if (!live) return fail("unavailable", `集成 ${key} 现在没在运行,密钥带不回来`);
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
		isOpen: (key) => opened.has(key),
		remove,
		exportSecrets,
		restoreSecrets,
		close: () => queue.close(),
	};
}
