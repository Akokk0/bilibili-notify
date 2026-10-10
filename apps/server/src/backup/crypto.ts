import { randomBytes } from "node:crypto";
import type { Json } from "@bilibili-notify/internal";
import {
	deriveKeyFromPassphrase,
	type GcmBlob,
	gcmDecrypt,
	gcmEncrypt,
} from "@bilibili-notify/storage";
import { BackupRejectedError } from "./rejected-error.js";

/**
 * The secret payload of a full backup — everything that must never sit in the
 * plaintext sections: every integration's `secrets` bag (B 站登录、各集成存的凭据)
 * plus every value the plaintext sections had redacted (apiKey、连接与拓展的凭据)。
 */
export interface BackupSecretBag {
	/** 各集成的 `secrets` 整袋,键是集成键。只装有内容的。 */
	integrationSecrets?: Record<string, Record<string, Json>>;
	/**
	 * 明文段**每一处**被脱敏改掉的地方(路径 + 原值),见 `./sanitize.ts` 的
	 * `collectRedactions`:照脱敏结果现算的全集,apiKey、连接与拓展的凭据都在这里 ——
	 * 完整档「原样恢复」这件事由它兜底。
	 */
	redacted?: Array<{ path: ReadonlyArray<string | number>; value: unknown }>;
}

/**
 * The PIN-encrypted block carried by a `kind:"full"` backup. `kdf.salt` is not
 * secret — it only stops identical PINs across backups deriving the same key.
 * The scrypt cost parameters are fixed inside {@link deriveKeyFromPassphrase}.
 *
 * NOTE (by design, per the grilling): a 4-digit PIN gives ~13 bits of entropy,
 * so this encryption is a speed-bump, not real protection of a leaked file. The
 * backup file itself is the secret and must be guarded; the UI states this. The
 * PIN only stops a casual peek and lets GCM authenticate a correct unlock.
 */
export interface EncryptedSecrets {
	kdf: { algo: "scrypt"; salt: string };
	cipher: GcmBlob;
}

/**
 * Thrown when a full backup cannot be opened: wrong PIN, or tampered/corrupt blob.
 * 是一种 {@link BackupRejectedError}(`invalid`):GCM 认证失败分不出「PIN 错了」与「密文被改过」,
 * 所以话里两种都说。
 */
export class BackupPinError extends BackupRejectedError {
	constructor(message = "备份 PIN 错误，或文件已损坏") {
		super("invalid", message);
		this.name = "BackupPinError";
	}
}

const SALT_BYTES = 16;

/** Encrypt a secret bag under `pin` with a fresh random salt. */
export function sealSecrets(pin: string, bag: BackupSecretBag): EncryptedSecrets {
	const salt = randomBytes(SALT_BYTES);
	const key = deriveKeyFromPassphrase(pin, salt);
	const cipher = gcmEncrypt(key, JSON.stringify(bag));
	return { kdf: { algo: "scrypt", salt: salt.toString("base64") }, cipher };
}

/** Decrypt a secret bag. Throws {@link BackupPinError} on a wrong PIN or tampered blob. */
export function openSecrets(pin: string, enc: EncryptedSecrets): BackupSecretBag {
	const salt = Buffer.from(enc.kdf.salt, "base64");
	const key = deriveKeyFromPassphrase(pin, salt);
	let json: string;
	try {
		json = gcmDecrypt(key, enc.cipher);
	} catch {
		throw new BackupPinError();
	}
	return JSON.parse(json) as BackupSecretBag;
}
