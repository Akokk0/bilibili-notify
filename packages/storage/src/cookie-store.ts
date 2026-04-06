import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { KeyManager } from "./key-manager";
import type { EncryptedFile, StoredCookies } from "./types";

export interface CookieData {
	cookiesJson: string;
	refreshToken?: string;
}

export class CookieStore {
	private key: Buffer | null = null;

	constructor(
		private readonly cookiePath: string,
		private readonly keyManager: KeyManager,
	) {}

	async init(): Promise<void> {
		this.key = await this.keyManager.loadOrCreate();
	}

	async save(data: CookieData): Promise<void> {
		if (!this.key) throw new Error("CookieStore not initialized");

		const stored: StoredCookies = {
			cookiesJson: this.encrypt(data.cookiesJson),
		};
		if (data.refreshToken) {
			stored.refreshToken = this.encrypt(data.refreshToken);
		}

		await mkdir(dirname(this.cookiePath), { recursive: true });
		await writeFile(this.cookiePath, JSON.stringify(stored), "utf8");
	}

	async load(): Promise<CookieData | null> {
		if (!this.key) throw new Error("CookieStore not initialized");
		let raw: string;
		try {
			raw = await readFile(this.cookiePath, "utf8");
		} catch {
			// 文件不存在属于正常情况（首次运行）
			return null;
		}
		try {
			const stored: StoredCookies = JSON.parse(raw);
			const cookiesJson = this.decrypt(stored.cookiesJson);
			const refreshToken = stored.refreshToken ? this.decrypt(stored.refreshToken) : undefined;
			return { cookiesJson, refreshToken };
		} catch (e) {
			console.warn(`[bilibili-notify] Cookie 文件解析失败，将重新登录: ${(e as Error).message}`);
			return null;
		}
	}

	async clear(): Promise<void> {
		try {
			await unlink(this.cookiePath);
		} catch {
			// file doesn't exist, that's fine
		}
	}

	async resetKey(): Promise<void> {
		await this.clear();
		this.key = await this.keyManager.createNew();
	}

	private encrypt(text: string): EncryptedFile {
		if (!this.key) throw new Error("CookieStore not initialized");
		const iv = randomBytes(16);
		const cipher = createCipheriv("aes-256-cbc", this.key, iv);
		const encrypted = Buffer.concat([cipher.update(Buffer.from(text, "utf8")), cipher.final()]);
		return {
			iv: iv.toString("hex"),
			data: encrypted.toString("hex"),
		};
	}

	private decrypt(file: EncryptedFile): string {
		if (!this.key) throw new Error("CookieStore not initialized");
		const iv = Buffer.from(file.iv, "hex");
		const decipher = createDecipheriv("aes-256-cbc", this.key, iv);
		const decrypted = Buffer.concat([
			decipher.update(Buffer.from(file.data, "hex")),
			decipher.final(),
		]);
		return decrypted.toString("utf8");
	}
}
