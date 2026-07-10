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
 * (apiKey, adapter configs) and the cookie store (cookiesJson/refreshToken).
 */
export interface BackupSecretBag {
	aiApiKey?: string;
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
