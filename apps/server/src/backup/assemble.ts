import type { Connection, GlobalConfig, PushTarget, Subscription } from "@bilibili-notify/internal";
import { applyAiSecrets, collectAiSecrets } from "../config/ai-secrets.js";
import { type BackupSecretBag, openSecrets, sealSecrets } from "./crypto.js";
import { type BackupEnvelope, type BackupSections, buildBackup } from "./envelope.js";
import { redactSecretKeys } from "./sanitize.js";

/**
 * Full-backup assembly — ties envelope + sanitize + PIN crypto together.
 *
 * A full backup keeps the SAME redacted plaintext sections as a sanitized one
 * (so even the full backup's cleartext leaks nothing), and carries the real
 * credential values — apiKey, cookie/refreshToken, and each connection's full
 * config — inside the PIN-encrypted `secrets` block. `openFullBackup`
 * decrypts and merges those back to rebuild the ready-to-persist config.
 */

export interface FullBackupInput {
	globals?: GlobalConfig;
	subscriptions?: Subscription[];
	connections?: Connection[];
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
	// 每家两把,全收。`redactSecretKeys` 会按键名把明文段里的 apiKey 一律抹平
	// (它是深度遍历的,桶里那些自动覆盖到),所以真值只存在于这个加密袋里。
	if (input.globals) {
		const aiApiKeys = collectAiSecrets(input.globals);
		if (Object.keys(aiApiKeys).length > 0) bag.aiApiKeys = aiApiKeys;
	}
	if (input.cookies?.cookiesJson) bag.cookiesJson = input.cookies.cookiesJson;
	if (input.cookies?.refreshToken) bag.refreshToken = input.cookies.refreshToken;
	if (input.connections?.length) {
		bag.connectionConfigs = {};
		for (const c of input.connections) bag.connectionConfigs[c.id] = c.config;
	}

	// redactSecretKeys deep-clones, so `input` is left intact and the plaintext
	// sections come out credential-free.
	const sections = redactSecretKeys<BackupSections>({
		globals: input.globals,
		subscriptions: input.subscriptions,
		connections: input.connections,
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

	if (sections.globals) {
		// 老备份里是单把 aiApiKey → 落 custom 槽(那份备份的配置本身也是扁平的,
		// schema 迁移会把它整份放进 providers.custom,两边对得上)。
		const keys = {
			...(bag.aiApiKey !== undefined ? { custom: bag.aiApiKey } : {}),
			...(bag.aiApiKeys ?? {}),
		};
		sections.globals = applyAiSecrets(sections.globals, keys);
	}
	// 老备份的袋子里这一格叫 `adapterConfigs`。
	const connectionConfigs = bag.connectionConfigs ?? bag.adapterConfigs;
	if (sections.connections && connectionConfigs) {
		for (const c of sections.connections) {
			const cfg = connectionConfigs[c.id];
			if (cfg !== undefined) (c as { config: unknown }).config = cfg;
		}
	}

	return {
		sections,
		cookies: { cookiesJson: bag.cookiesJson, refreshToken: bag.refreshToken },
	};
}
