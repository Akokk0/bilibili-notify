import { randomBytes } from "node:crypto";
import {
	deriveKeyFromPassphrase,
	type GcmBlob,
	gcmDecrypt,
	gcmEncrypt,
} from "@bilibili-notify/storage";

/**
 * The secret payload of a full backup — everything that must never sit in the
 * plaintext sections. Assembled at the service layer from the config store
 * (每家两把 apiKey、adapter configs) 与 cookie store (cookiesJson/refreshToken)。
 */
export interface BackupSecretBag {
	/**
	 * 上一版备份里的**单把** AI 密钥(那时全局只有一套 AI 连接)。只读不写:
	 * 恢复老备份时迁进 {@link aiApiKeys} 的 `custom` 槽,与 schema 那边
	 * 「扁平旧配置整份落进 providers.custom」对上。
	 */
	aiApiKey?: string;
	/**
	 * 各家各自的 AI 密钥,键是自描述路径(`"<provider>"` / `"<provider>:vision"`,
	 * 见 `../config/ai-secrets.ts`)。最多 5 家 × 2 把。
	 */
	aiApiKeys?: Record<string, string>;
	cookiesJson?: string;
	refreshToken?: string;
	/** Full per-adapter connection configs keyed by adapter id (they carry credentials). */
	adapterConfigs?: Record<string, unknown>;
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

/** Thrown when a full backup cannot be opened: wrong PIN, or tampered/corrupt blob. */
export class BackupPinError extends Error {
	constructor(message = "备份 PIN 错误，或文件已损坏") {
		super(message);
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
