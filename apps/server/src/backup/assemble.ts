import type {
	GlobalConfig,
	PushAdapter,
	PushTarget,
	Subscription,
} from "@bilibili-notify/internal";
import { type BackupSecretBag, openSecrets, sealSecrets } from "./crypto.js";
import { type BackupEnvelope, type BackupSections, buildBackup } from "./envelope.js";
import { redactSecretKeys } from "./sanitize.js";

/**
 * Full-backup assembly — ties envelope + sanitize + PIN crypto together.
 *
 * A full backup keeps the SAME redacted plaintext sections as a sanitized one
 * (so even the full backup's cleartext leaks nothing), and carries the real
 * credential values — apiKey, cookie/refreshToken, and each adapter's full
 * connection config — inside the PIN-encrypted `secrets` block. `openFullBackup`
 * decrypts and merges those back to rebuild the ready-to-persist config.
 */

export interface FullBackupInput {
	globals?: GlobalConfig;
	subscriptions?: Subscription[];
	adapters?: PushAdapter[];
	targets?: PushTarget[];
	cookies?: { cookiesJson?: string; refreshToken?: string };
}

export interface OpenedFullBackup {
	sections: BackupSections;
	cookies: { cookiesJson?: string; refreshToken?: string };
}

export function assembleFullBackup(
	input: FullBackupInput,
	pin: string,
	createdAt: string,
): BackupEnvelope {
	const bag: BackupSecretBag = {};
	if (input.globals?.defaults?.ai?.apiKey) bag.aiApiKey = input.globals.defaults.ai.apiKey;
	if (input.cookies?.cookiesJson) bag.cookiesJson = input.cookies.cookiesJson;
	if (input.cookies?.refreshToken) bag.refreshToken = input.cookies.refreshToken;
	if (input.adapters?.length) {
		bag.adapterConfigs = {};
		for (const a of input.adapters) bag.adapterConfigs[a.id] = a.config;
	}

	// redactSecretKeys deep-clones, so `input` is left intact and the plaintext
	// sections come out credential-free.
	const sections = redactSecretKeys<BackupSections>({
		globals: input.globals,
		subscriptions: input.subscriptions,
		adapters: input.adapters,
		targets: input.targets,
	});

	return buildBackup({ kind: "full", createdAt, sections, secrets: sealSecrets(pin, bag) });
}

export function openFullBackup(env: BackupEnvelope, pin: string): OpenedFullBackup {
	if (env.kind !== "full" || !env.secrets) {
		throw new Error("not a full backup (no encrypted secrets block)");
	}
	const bag = openSecrets(pin, env.secrets);
	const sections: BackupSections = structuredClone(env.sections);

	if (sections.globals && bag.aiApiKey !== undefined) {
		sections.globals.defaults.ai.apiKey = bag.aiApiKey;
	}
	if (sections.adapters && bag.adapterConfigs) {
		for (const a of sections.adapters) {
			const cfg = bag.adapterConfigs[a.id];
			if (cfg !== undefined) (a as { config: unknown }).config = cfg;
		}
	}

	return {
		sections,
		cookies: { cookiesJson: bag.cookiesJson, refreshToken: bag.refreshToken },
	};
}
