import { join } from "node:path";
import type { Context } from "koishi";
import { CookieStore } from "./cookie-store";
import { KeyManager } from "./key-manager";

export type { CookieData } from "./cookie-store";
export { CookieStore } from "./cookie-store";
export { KeyManager } from "./key-manager";
export type { EncryptedFile, StoredCookies } from "./types";

export class StorageManager {
	readonly cookieStore: CookieStore;

	constructor(dataDir: string, ctx: Context) {
		const logger = ctx.logger("bilibili-notify-storage");
		const keyPath = join(dataDir, "bilibili-notify", "master.key");
		const cookiePath = join(dataDir, "bilibili-notify", "cookies.json");
		const keyManager = new KeyManager(keyPath, logger);
		this.cookieStore = new CookieStore(cookiePath, keyManager, logger);
	}

	async init(): Promise<void> {
		await this.cookieStore.init();
	}
}
