import type { ServiceContext } from "@bilibili-notify/internal";
import { CookieStore } from "./cookie-store";
import { createKeyProvider, type KeyProvider } from "./key-provider";

export { appendJsonl, appendLines } from "./append-jsonl";
export {
	type AtomicWriteOptions,
	atomicWriteFile,
	atomicWriteFileSync,
	atomicWriteJson,
	atomicWriteJsonSync,
	syncDirectory,
} from "./atomic-file";
export type { CookieData } from "./cookie-store";
export { CookieStore } from "./cookie-store";
export { copyFileAtomic } from "./copy-file";
export { KeyManager } from "./key-manager";
export {
	createKeyProvider,
	FileKeyProvider,
	type KeyMaterialRead,
	type KeyProvider,
	PassphraseKeyProvider,
	readKeyMaterial,
} from "./key-provider";
export {
	type JsonFileRead,
	quarantineFile,
	quarantineFileSync,
	readJsonFile,
	readJsonFileSync,
} from "./read-json";
export { removeDirectory } from "./remove-directory";
export { type ReplaceDirectoryOptions, replaceDirectory } from "./replace-directory";
export {
	deriveKeyFromPassphrase,
	type GcmBlob,
	gcmDecrypt,
	gcmEncrypt,
	isGcmBlob,
} from "./secret-box";
export { isLeftoverName, type SweepOptions, type SweepReport, sweepTempFiles } from "./sweep";
export type { StoredCookies } from "./types";

export interface StorageManagerOptions {
	serviceCtx: ServiceContext;
	/**
	 * 主密钥、cookie、口令派生盐三个文件放在哪。布局归宿主(独立端在数据根的 `secrets/` 下),
	 * storage 不替它另安排一处。
	 */
	paths: { keyPath: string; cookiePath: string; saltPath: string };
	/**
	 * Injected at-rest encryption passphrase (standalone:
	 * `bootstrap.cookieEncryptionKey` ← `BN_COOKIE_KEY`). When present, the AES
	 * key is scrypt-derived from it and never written to disk → real at-rest
	 * protection. When absent, falls back to a co-located random key file
	 * (legacy behaviour).
	 */
	encryptionKey?: string;
	/**
	 * Pre-built KeyProvider to share with other stores (standalone passes the
	 * same instance to its config SecretStore so cookie + config secrets derive
	 * one key). When given it wins over `encryptionKey`.
	 */
	keyProvider?: KeyProvider;
}

export class StorageManager {
	readonly cookieStore: CookieStore;
	readonly keyProvider: KeyProvider;

	constructor(opts: StorageManagerOptions) {
		const { keyPath, cookiePath, saltPath } = opts.paths;
		this.keyProvider =
			opts.keyProvider ??
			createKeyProvider({
				passphrase: opts.encryptionKey,
				keyPath,
				saltPath,
				logger: opts.serviceCtx.logger,
			});
		this.cookieStore = new CookieStore(cookiePath, this.keyProvider, opts.serviceCtx.logger);
	}

	async init(): Promise<void> {
		await this.cookieStore.init();
	}
}
