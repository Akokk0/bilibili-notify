import { readFile } from "node:fs/promises";
import { fail, type Json, type Logger, ok, type Result } from "@bilibili-notify/internal";
import {
	atomicWriteFile,
	atomicWriteJson,
	gcmDecrypt,
	gcmEncrypt,
	type KeyProvider,
	quarantineFile,
	readJsonFile,
} from "@bilibili-notify/storage";
import { t as serverText } from "../i18n/index.js";
import { type DataRootKey, dataPath } from "../runtime/roots.js";
import { errorMessageOf } from "../util/error-message.js";
import { parseStoredEntries, STORE_FILE_VERSION, serializeEntries } from "./key-value-store.js";

/**
 * 两种文件的路径与读写。格式只有这一个真源:
 * - `state.json`:`{ "version": 1, "entries": { 键: Json } }`,明文;
 * - `secrets.enc`:一个 GCM 块(与 `config-secrets.enc` 同法、同一把主密钥),明文是同样那段 JSON。
 * 落盘只经 `@bilibili-notify/storage` 的原子写。
 */

type DataSegments = readonly [DataRootKey, ...string[]];

/** 内置集成的键 → 目录在数据根下一级;拓展 id 归在 `extensions/` 底下(两边撞不上:拓展 id 进不了保留 id)。 */
function homeSegments(key: string, reservedIntegrationKeys: readonly string[]): string[] {
	return reservedIntegrationKeys.includes(key) ? [key] : ["extensions", key];
}

export function integrationStateDir(
	key: string,
	reservedIntegrationKeys: readonly string[],
): DataSegments {
	return ["runtime", ...homeSegments(key, reservedIntegrationKeys)];
}

export function integrationSecretsDir(
	key: string,
	reservedIntegrationKeys: readonly string[],
): DataSegments {
	return ["secrets", ...homeSegments(key, reservedIntegrationKeys)];
}

export function integrationStateFile(
	key: string,
	reservedIntegrationKeys: readonly string[],
): DataSegments {
	return ["runtime", ...homeSegments(key, reservedIntegrationKeys), "state.json"];
}

export function integrationSecretsFile(
	key: string,
	reservedIntegrationKeys: readonly string[],
): DataSegments {
	return ["secrets", ...homeSegments(key, reservedIntegrationKeys), "secrets.enc"];
}

/** 读盘的结果:读得出(没有这个文件、内容不认都算空袋)或在但读不了。 */
export type StoreFileReadResult =
	| { kind: "ok"; entries: Map<string, Json> }
	| { kind: "unreadable"; message: string };

interface ReadContext {
	reservedIntegrationKeys: readonly string[];
	dataRoot: string;
	key: string;
	logger: Logger;
}

/** 读 `state.json`。在但读不了回 `unreadable`(不抛),内容不认的隔离改名、当空袋、记 warn。 */
export async function readIntegrationStateFile(opts: ReadContext): Promise<StoreFileReadResult> {
	const path = dataPath(
		opts.dataRoot,
		...integrationStateFile(opts.key, opts.reservedIntegrationKeys),
	);
	let read: Awaited<ReturnType<typeof readJsonFile>>;
	try {
		read = await readJsonFile(path);
	} catch (err) {
		return { kind: "unreadable", message: errorMessageOf(err) };
	}
	if (read.kind === "missing") return { kind: "ok", entries: new Map() };
	if (read.kind === "corrupt") {
		opts.logger.warn(
			`[integration-store] ${opts.key} 的 state.json 不是合法 JSON(${read.message}),已隔离为 ${read.quarantinedPath},按空处理`,
		);
		return { kind: "ok", entries: new Map() };
	}
	const entries = parseStoredEntries(read.value);
	if (entries) return { kind: "ok", entries };
	try {
		const quarantined = await quarantineFile(path);
		opts.logger.warn(
			`[integration-store] ${opts.key} 的 state.json 形状不认,已隔离为 ${quarantined},按空处理`,
		);
		return { kind: "ok", entries: new Map() };
	} catch (err) {
		return { kind: "unreadable", message: errorMessageOf(err) };
	}
}

export async function writeIntegrationStateFile(
	dataRoot: string,
	key: string,
	entries: ReadonlyMap<string, Json>,
	reservedIntegrationKeys: readonly string[],
): Promise<Result> {
	try {
		await atomicWriteJson(
			dataPath(dataRoot, ...integrationStateFile(key, reservedIntegrationKeys)),
			{
				version: STORE_FILE_VERSION,
				entries: Object.fromEntries(entries),
			},
		);
		return ok();
	} catch (err) {
		return fail(
			"unavailable",
			serverText("service.integration-store.files.text.1", { value0: errorMessageOf(err) }),
		);
	}
}

/**
 * 读 `secrets.enc`。文件不在是空袋;解不开(换了密钥、被改过)或解开后形状不对:当空袋、记 warn,文件原地留着、
 * 下次写盖掉 —— 与 `config-secrets.enc` 同一个口径。在但读不了(权限、IO)回 `unreadable`:盖掉它会毁掉盘上
 * 还好着的密文,所以这一袋读一律空、写一律拒,而不是抛 —— 抛了会让一个集成的读不了挡住开机。
 */
export async function readIntegrationSecretsFile(
	opts: ReadContext & { keyProvider: KeyProvider },
): Promise<StoreFileReadResult> {
	const path = dataPath(
		opts.dataRoot,
		...integrationSecretsFile(opts.key, opts.reservedIntegrationKeys),
	);
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "ok", entries: new Map() };
		return { kind: "unreadable", message: errorMessageOf(err) };
	}
	let key: Buffer;
	try {
		key = await opts.keyProvider.getKey();
	} catch (err) {
		return {
			kind: "unreadable",
			message: serverText("service.integration-store.files.text.2", {
				value0: errorMessageOf(err),
			}),
		};
	}
	try {
		const entries = parseStoredEntries(JSON.parse(gcmDecrypt(key, JSON.parse(raw))));
		if (entries) return { kind: "ok", entries };
		opts.logger.warn(
			`[integration-store] ${opts.key} 的 secrets.enc 解开了但形状不认,按空处理(下次写入会盖掉它)`,
		);
	} catch (err) {
		opts.logger.warn(
			`[integration-store] ${opts.key} 的 secrets.enc 无法解密(换了密钥或被改过),按空处理(下次写入会盖掉它):${errorMessageOf(err)}`,
		);
	}
	return { kind: "ok", entries: new Map() };
}

export async function writeIntegrationSecretsFile(
	opts: {
		dataRoot: string;
		key: string;
		keyProvider: KeyProvider;
		reservedIntegrationKeys: readonly string[];
	},
	entries: ReadonlyMap<string, Json>,
): Promise<Result> {
	try {
		const blob = gcmEncrypt(await opts.keyProvider.getKey(), serializeEntries(entries));
		// 只许 owner 读(0o600)。临时名 / fsync / 失败清理都在原语里。
		await atomicWriteFile(
			dataPath(opts.dataRoot, ...integrationSecretsFile(opts.key, opts.reservedIntegrationKeys)),
			JSON.stringify(blob),
			{ mode: 0o600 },
		);
		return ok();
	} catch (err) {
		return fail(
			"unavailable",
			serverText("service.integration-store.files.text.3", { value0: errorMessageOf(err) }),
		);
	}
}
