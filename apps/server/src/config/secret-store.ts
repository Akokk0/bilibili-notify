import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger } from "@bilibili-notify/internal";
import { gcmDecrypt, gcmEncrypt, type KeyProvider } from "@bilibili-notify/storage";

/**
 * Encrypted at-rest bag for runtime config secrets that must never sit in the
 * plaintext `state/*.json` files. Currently just the AI apiKey.
 *
 * On disk: `<dataDir>/secrets/config-secrets.enc` — a single AES-256-GCM blob
 * keyed off the same {@link KeyProvider} as the cookie store (so one
 * `BN_COOKIE_KEY` protects everything).
 *
 * IO-error policy (P1 hardening — data-loss class):
 *   - file ABSENT (`ENOENT`) → empty bag (legit first run).
 *   - file PRESENT but undecryptable (legacy CBC / key change / corrupt) →
 *     empty bag + warn. By-design per the GCM session: a key change must not
 *     brick the server; the user just re-enters the apiKey in the dashboard.
 *   - file PRESENT but unreadable (`EACCES`/`EIO`/`EBUSY`/…) → THROW. Never
 *     swallow to `{}`: a subsequent `save()` would atomically overwrite the
 *     real on-disk secret with an empty bag and permanently destroy a stored
 *     `aiApiKey` the user never asked to drop.
 */
export interface ConfigSecrets {
	aiApiKey?: string;
}

export interface SecretStore {
	load(): Promise<ConfigSecrets>;
	save(next: ConfigSecrets): Promise<void>;
}

export interface CreateSecretStoreOptions {
	/** `<dataDir>/secrets/config-secrets.enc` */
	filePath: string;
	keyProvider: KeyProvider;
	logger: Logger;
}

export function createSecretStore(opts: CreateSecretStoreOptions): SecretStore {
	let keyPromise: Promise<Buffer> | null = null;
	const key = () => {
		keyPromise ??= opts.keyProvider.getKey();
		return keyPromise;
	};

	return {
		async load(): Promise<ConfigSecrets> {
			let raw: string;
			try {
				raw = await readFile(opts.filePath, "utf8");
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code === "ENOENT") return {}; // first run — no secrets yet
				// EACCES/EIO/EBUSY…:文件存在但读不了。绝不能静默退化为 {} ——
				// 随后任一 writeGlobals → save() 会用空 bag 原子覆盖,永久销毁
				// 已存 aiApiKey。响亮抛出,让调用方据此中止而非毁数据。
				throw e;
			}
			try {
				const blob = JSON.parse(raw);
				const plain = gcmDecrypt(await key(), blob);
				const bag = JSON.parse(plain) as ConfigSecrets;
				return bag && typeof bag === "object" ? bag : {};
			} catch (e) {
				opts.logger.warn(
					`[secrets] config-secrets 无法解密（旧格式或密钥变更），按空处理: ${(e as Error).message}`,
				);
				return {};
			}
		},

		async save(next: ConfigSecrets): Promise<void> {
			const blob = gcmEncrypt(await key(), JSON.stringify(next));
			await mkdir(dirname(opts.filePath), { recursive: true });
			// P2 fold-in: 固定 `.tmp` 名在并发 save() 下两进程/两调用会互踩同一
			// 临时文件。改 `.tmp.{pid}.{rand}`,对齐 store.ts#atomicWriteJson。
			const tmp = `${opts.filePath}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
			await writeFile(tmp, JSON.stringify(blob), "utf8");
			await rename(tmp, opts.filePath);
		},
	};
}
