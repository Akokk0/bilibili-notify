import { join } from "node:path";
import type { ServiceContext } from "@bilibili-notify/internal";
import { CookieStore } from "./cookie-store";
import { KeyManager } from "./key-manager";

export type { CookieData } from "./cookie-store";
export { CookieStore } from "./cookie-store";
export { KeyManager } from "./key-manager";
export type { EncryptedFile, StoredCookies } from "./types";

export interface StorageManagerOptions {
	serviceCtx: ServiceContext;
	dataDir: string;
	/**
	 * Override default file locations; missing fields fall back to
	 * `<dataDir>/bilibili-notify/{master.key,cookies.json}`. The standalone end
	 * passes `<dataDir>/secrets/...` per plan §4.1; the koishi shell omits this
	 * to keep the historical layout.
	 */
	paths?: { keyPath?: string; cookiePath?: string };
}

export class StorageManager {
	readonly cookieStore: CookieStore;

	constructor(opts: StorageManagerOptions) {
		const keyPath = opts.paths?.keyPath ?? join(opts.dataDir, "bilibili-notify", "master.key");
		const cookiePath =
			opts.paths?.cookiePath ?? join(opts.dataDir, "bilibili-notify", "cookies.json");
		const keyManager = new KeyManager(keyPath, opts.serviceCtx.logger);
		this.cookieStore = new CookieStore(cookiePath, keyManager, opts.serviceCtx.logger);
	}

	async init(): Promise<void> {
		await this.cookieStore.init();
	}
}
