import { join } from "node:path";
import { CookieStore } from "./cookie-store";
import { KeyManager } from "./key-manager";

export type { CookieData } from "./cookie-store";
export { CookieStore } from "./cookie-store";
export { KeyManager } from "./key-manager";
export type { EncryptedFile, StoredCookies } from "./types";

export class StorageManager {
	readonly cookieStore: CookieStore;

	constructor(dataDir: string) {
		const keyPath = join(dataDir, "bilibili-notify", "master.key");
		const cookiePath = join(dataDir, "bilibili-notify", "cookies.json");
		const keyManager = new KeyManager(keyPath);
		this.cookieStore = new CookieStore(cookiePath, keyManager);
	}

	async init(): Promise<void> {
		await this.cookieStore.init();
	}
}
