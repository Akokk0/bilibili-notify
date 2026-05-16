import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger } from "@bilibili-notify/internal";
import type { KeyProvider } from "./key-provider";
import { gcmDecrypt, gcmEncrypt } from "./secret-box";
import type { StoredCookies } from "./types";

export interface CookieData {
	cookiesJson: string;
	refreshToken?: string;
}

/**
 * Encrypted bilibili-cookie persistence.
 *
 * As of the GCM migration the file is AES-256-GCM (authenticated) keyed off a
 * {@link KeyProvider}. Legacy AES-256-CBC files written by an older build are
 * intentionally NOT migrated: {@link load} detects the non-`v2` shape (or any
 * decrypt/auth failure) and returns `null`, which drives the auth layer back
 * to a fresh QR login. This is a deliberate one-time re-login, not data loss
 * the user can avoid (the legacy random key gave ~no real protection anyway).
 *
 * IO-error policy (P1 hardening, mirrors {@link import("../../apps/server/src/config/secret-store")}):
 * file ABSENT (`ENOENT`) → `null` (legit first run); file PRESENT but
 * undecryptable → `null` + warn (by-design re-login); file PRESENT but
 * unreadable (`EACCES`/`EIO`/…) → THROW. A transient read failure must not
 * masquerade as "logged out" and let a later refresh-save quietly overwrite
 * the still-valid encrypted cookie on disk.
 */
export class CookieStore {
	private key: Buffer | null = null;

	constructor(
		private readonly cookiePath: string,
		private readonly keyProvider: KeyProvider,
		private readonly logger: Logger,
	) {}

	async init(): Promise<void> {
		this.key = await this.keyProvider.getKey();
	}

	async save(data: CookieData): Promise<void> {
		const key = this.requireKey();
		const stored: StoredCookies = {
			cookiesJson: gcmEncrypt(key, data.cookiesJson),
		};
		if (data.refreshToken) {
			stored.refreshToken = gcmEncrypt(key, data.refreshToken);
		}
		await mkdir(dirname(this.cookiePath), { recursive: true });
		await writeFile(this.cookiePath, JSON.stringify(stored), "utf8");
		this.logger.info("[cookie] Cookie 已保存到磁盘");
	}

	async load(): Promise<CookieData | null> {
		const key = this.requireKey();
		let raw: string;
		try {
			raw = await readFile(this.cookiePath, "utf8");
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") {
				this.logger.info("[cookie] 未找到 Cookie 文件，跳过加载（首次运行）");
				return null;
			}
			// EACCES/EIO/EBUSY…:文件存在但读不了。不能伪装成"未登录"——
			// 否则后续 refresh→save() 会用新 cookie 覆盖盘上仍有效的密文。
			this.logger.error(`[cookie] Cookie 文件读取失败（非缺失）: ${(e as Error).message}`);
			throw e;
		}
		try {
			const stored = JSON.parse(raw) as StoredCookies;
			const cookiesJson = gcmDecrypt(key, stored.cookiesJson);
			const refreshToken = stored.refreshToken ? gcmDecrypt(key, stored.refreshToken) : undefined;
			this.logger.info("[cookie] Cookie 加载成功");
			return { cookiesJson, refreshToken };
		} catch (e) {
			// Legacy CBC file / wrong key / tampered ciphertext all land here.
			this.logger.warn(
				`[cookie] Cookie 文件无法解密（旧格式或密钥变更），将重新登录: ${(e as Error).message}`,
			);
			return null;
		}
	}

	async clear(): Promise<void> {
		try {
			await unlink(this.cookiePath);
			this.logger.info("[cookie] Cookie 文件已清除");
		} catch {
			// 文件不存在，无需处理
		}
	}

	async resetKey(): Promise<void> {
		await this.clear();
		if (this.keyProvider.resettable) {
			this.key = await this.keyProvider.resetKey();
			this.logger.info("[cookie] 密钥已重置");
		} else {
			// Injected passphrase can't be rotated server-side; wiping the cookie
			// is the meaningful action (next login re-encrypts under the same key).
			this.key = await this.keyProvider.getKey();
			this.logger.info("[cookie] Cookie 已清除（注入密钥不可在服务端轮换）");
		}
	}

	private requireKey(): Buffer {
		if (!this.key) throw new Error("CookieStore not initialized");
		return this.key;
	}
}
