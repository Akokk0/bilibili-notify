import type { Connection, GlobalConfig, PushTarget, Subscription } from "@bilibili-notify/internal";
import { type BackupSecretBag, openSecrets, sealSecrets } from "./crypto.js";
import { type BackupEnvelope, type BackupSections, buildBackup } from "./envelope.js";
import { BackupRejectedError } from "./rejected-error.js";
import {
	applyRedactions,
	collectRedactions,
	type ExtensionSecretCodes,
	redactBackupSections,
} from "./sanitize.js";

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
	integrations?: Record<string, unknown>;
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
	/** 拓展声明成密钥的 config 键,按拓展 id 分格 —— 明文段照它一并抹平。 */
	extensionSecrets: ExtensionSecretCodes = new Map(),
): BackupEnvelope {
	const bag: BackupSecretBag = {};
	if (input.cookies?.cookiesJson) bag.cookiesJson = input.cookies.cookiesJson;
	if (input.cookies?.refreshToken) bag.refreshToken = input.cookies.refreshToken;

	const original: BackupSections = {
		globals: input.globals,
		integrations: input.integrations,
		subscriptions: input.subscriptions,
		connections: input.connections,
		targets: input.targets,
	};
	// redactBackupSections deep-clones, so `input` is left intact and the plaintext
	// sections come out credential-free.
	const sections = redactBackupSections<BackupSections>(original, extensionSecrets);
	// 🔴 **不变式:凡是明文段被抹掉的,袋子里都要有对应项**(见 `collectRedactions`)。照着脱敏的结果现算,
	// 以后脱敏那边再加规则,恢复自动跟上 —— apiKey、连接与拓展的凭据都在这一格里,不另手抄。从前另抄过
	// apiKey 与连接 config 两格,是为了旧版本也打得开新备份;1.0 的备份版本是 2,旧版本见了就拒,那两格没用了。
	const redacted = collectRedactions(original, sections);
	if (redacted.length > 0) bag.redacted = redacted;

	return buildBackup({ kind: "full", createdAt, sections, secrets: sealSecrets(pin, bag) });
}

export function openFullBackup(env: BackupEnvelope, pin: string): OpenedFullBackup {
	if (env.kind !== "full" || !env.secrets) {
		throw new BackupRejectedError("invalid", "这份完整备份缺少加密的密钥段，文件可能被改动过");
	}
	const bag = openSecrets(pin, env.secrets);
	const sections: BackupSections = structuredClone(env.sections);

	// 照不变式那一份把**所有**被抹掉的地方填回去(apiKey、连接与拓展的凭据,以及往后新加的任何规则)。
	if (bag.redacted) applyRedactions(sections, bag.redacted);

	return {
		sections,
		cookies: { cookiesJson: bag.cookiesJson, refreshToken: bag.refreshToken },
	};
}
