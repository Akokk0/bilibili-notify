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
 * `BN_COOKIE_KEY` protects everything). A missing / legacy / undecryptable
 * file degrades to an empty bag (never throws) so a key change can't brick the
 * server — the user just re-enters the apiKey in the dashboard.
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
			} catch {
				return {}; // first run — no secrets yet
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
			const tmp = `${opts.filePath}.tmp`;
			await writeFile(tmp, JSON.stringify(blob), "utf8");
			await rename(tmp, opts.filePath);
		},
	};
}
