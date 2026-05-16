import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * AES-256-GCM authenticated-encryption primitive for at-rest secrets
 * (cookie blob, config secrets). Replaces the legacy AES-256-CBC path which
 * had no integrity tag (a tampered ciphertext decrypted to garbage instead of
 * failing loudly).
 *
 * Blob layout (all fields base64):
 *   { v: 2, iv, tag, data }
 *
 * `v` is the format marker. Anything that is not a `v:2` GCM blob (legacy CBC
 * `{ iv, data }`, or a corrupt file) is rejected by {@link gcmDecrypt} so the
 * caller can fall back to "no secret on disk" (→ re-login) rather than crash.
 */
export interface GcmBlob {
	v: 2;
	iv: string;
	tag: string;
	data: string;
}

const GCM_IV_BYTES = 12; // NIST-recommended GCM nonce length
const KEY_BYTES = 32; // AES-256
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;

export function isGcmBlob(x: unknown): x is GcmBlob {
	if (!x || typeof x !== "object") return false;
	const o = x as Record<string, unknown>;
	return (
		o.v === 2 &&
		typeof o.iv === "string" &&
		typeof o.tag === "string" &&
		typeof o.data === "string"
	);
}

export function gcmEncrypt(key: Buffer, plaintext: string): GcmBlob {
	assertKey(key);
	const iv = randomBytes(GCM_IV_BYTES);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const data = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
	const tag = cipher.getAuthTag();
	return {
		v: 2,
		iv: iv.toString("base64"),
		tag: tag.toString("base64"),
		data: data.toString("base64"),
	};
}

/**
 * Decrypt a {@link GcmBlob}. Throws if the blob shape is not a `v:2` GCM blob
 * or if the auth tag does not verify (wrong key / tampered ciphertext).
 */
export function gcmDecrypt(key: Buffer, blob: unknown): string {
	assertKey(key);
	if (!isGcmBlob(blob)) {
		throw new Error("not a v2 GCM blob (legacy/corrupt secret — re-auth required)");
	}
	const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "base64"));
	decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
	const out = Buffer.concat([
		decipher.update(Buffer.from(blob.data, "base64")),
		decipher.final(), // throws on auth-tag mismatch
	]);
	return out.toString("utf8");
}

/**
 * Derive a 32-byte AES key from a user-supplied passphrase + a per-install
 * salt (the salt is NOT secret — it only prevents identical passphrases across
 * installs producing identical keys, and rainbow-table reuse).
 */
export function deriveKeyFromPassphrase(passphrase: string, salt: Buffer): Buffer {
	if (!passphrase) throw new Error("empty passphrase");
	return scryptSync(passphrase, salt, KEY_BYTES, {
		N: SCRYPT_PARAMS.N,
		r: SCRYPT_PARAMS.r,
		p: SCRYPT_PARAMS.p,
		maxmem: 64 * 1024 * 1024,
	});
}

function assertKey(key: Buffer): void {
	if (key.length !== KEY_BYTES) {
		throw new Error(`AES-256 key must be ${KEY_BYTES} bytes, got ${key.length}`);
	}
}
