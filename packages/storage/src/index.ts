import { join } from "node:path";
import type { ServiceContext } from "@bilibili-notify/internal";
import { CookieStore } from "./cookie-store";
import { createKeyProvider, type KeyProvider } from "./key-provider";

export type { CookieData } from "./cookie-store";
export { CookieStore } from "./cookie-store";
export { KeyManager } from "./key-manager";
export {
	createKeyProvider,
	FileKeyProvider,
	type KeyProvider,
	PassphraseKeyProvider,
} from "./key-provider";
export {
	deriveKeyFromPassphrase,
	gcmDecrypt,
	gcmEncrypt,
	type GcmBlob,
	isGcmBlob,
} from "./secret-box";
export type { StoredCookies } from "./types";

export interface StorageManagerOptions {
	serviceCtx: ServiceContext;
	dataDir: string;
	/**
	 * Override default file locations; missing fields fall back to
	 * `<dataDir>/bilibili-notify/{master.key,cookies.json,kdf.salt}`. The
	 * standalone end passes `<dataDir>/secrets/...` per plan §4.1; the koishi
	 * shell omits this to keep the historical layout.
	 */
	paths?: { keyPath?: string; cookiePath?: string; saltPath?: string };
	/**
	 * Injected at-rest encryption passphrase (standalone:
	 * `bootstrap.cookieEncryptionKey` ← `BN_COOKIE_KEY`). When present, the AES
	 * key is scrypt-derived from it and never written to disk → real at-rest
	 * protection. When absent, falls back to a co-located random key file
	 * (legacy behaviour; the only mode the koishi shell uses).
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
		const base = join(opts.dataDir, "bilibili-notify");
		const keyPath = opts.paths?.keyPath ?? join(base, "master.key");
		const cookiePath = opts.paths?.cookiePath ?? join(base, "cookies.json");
		const saltPath = opts.paths?.saltPath ?? join(base, "kdf.salt");
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
