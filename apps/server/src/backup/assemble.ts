import type {
	Connection,
	GlobalConfig,
	Json,
	PushTarget,
	Subscription,
	SubscriptionTag,
} from "@bilibili-notify/internal";
import { t as serverText } from "../i18n/index.js";
import type { SecretCellsReader } from "../push/connection-settings.js";
import { type BackupSecretBag, openSecrets, sealSecrets } from "./crypto.js";
import { type BackupEnvelope, type BackupSections, buildBackup } from "./envelope.js";
import { BackupRejectedError } from "./rejected-error.js";
import { applyRedactions, collectRedactions, redactBackupSections } from "./sanitize.js";

/**
 * Full-backup assembly — ties envelope + sanitize + PIN crypto together.
 *
 * A full backup keeps the SAME redacted plaintext sections as a sanitized one
 * (so even the full backup's cleartext leaks nothing), and carries the real
 * credential values — apiKey, each integration's secrets bag, and each connection's full
 * config — inside the PIN-encrypted `secrets` block. `openFullBackup`
 * decrypts and merges those back to rebuild the ready-to-persist config.
 */

export interface FullBackupInput {
	globals?: GlobalConfig;
	integrations?: Record<string, unknown>;
	extensionSettings?: Record<string, unknown>;
	subscriptions?: Subscription[];
	subscriptionTags?: SubscriptionTag[];
	connections?: Connection[];
	targets?: PushTarget[];
	/** 各集成的 `secrets` 整袋(键是集成键);空袋的集成不用列。 */
	integrationSecrets?: Record<string, Record<string, Json>>;
}

export interface OpenedFullBackup {
	sections: BackupSections;
	/** 各集成的 `secrets` 整袋,键是集成键;备份里没有就是 `{}`。 */
	integrationSecrets: Record<string, Record<string, Json>>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 开袋时核密钥袋里集成那一格的形状:「集成键 → 键值对的普通对象」。袋子是 `JSON.parse` 出来的,值天然是 JSON,
 * 所以只核两层是不是普通对象;不对的整份拒收,不挑能用的恢复 —— 半份密钥比没有更难查。
 */
function readIntegrationSecrets(raw: unknown): Record<string, Record<string, Json>> {
	if (raw === undefined) return {};
	if (!isPlainRecord(raw)) {
		throw new BackupRejectedError("invalid", serverText("service.backup.assemble.text.1"));
	}
	for (const [key, bag] of Object.entries(raw)) {
		if (!isPlainRecord(bag)) {
			throw new BackupRejectedError(
				"invalid",
				serverText("service.backup.assemble.text.2", { value0: key }),
			);
		}
	}
	return raw as Record<string, Record<string, Json>>;
}

export function assembleFullBackup(
	input: FullBackupInput,
	pin: string,
	createdAt: string,
	/** 连接的 settings 与拓展设置里哪些格是密钥(适配器的 schema 标记 + 拓展声明的键)—— 明文段照它一并抹平。 */
	lookup?: SecretCellsReader,
): BackupEnvelope {
	const bag: BackupSecretBag = {};
	if (Object.keys(input.integrationSecrets ?? {}).length > 0) {
		bag.integrationSecrets = input.integrationSecrets;
	}

	const original: BackupSections = {
		globals: input.globals,
		integrations: input.integrations,
		extensionSettings: input.extensionSettings,
		subscriptions: input.subscriptions,
		subscriptionTags: input.subscriptionTags,
		connections: input.connections,
		targets: input.targets,
	};
	// redactBackupSections deep-clones, so `input` is left intact and the plaintext
	// sections come out credential-free.
	const sections = redactBackupSections<BackupSections>(original, lookup);
	// 🔴 **不变式:凡是明文段被抹掉的,袋子里都要有对应项**(见 `collectRedactions`)。照着脱敏的结果现算,
	// 以后脱敏那边再加规则,恢复自动跟上 —— apiKey、连接与拓展的凭据都在这一格里,不另手抄。从前另抄过
	// apiKey 与连接 config 两格,是为了旧版本也打得开新备份;1.0 的备份版本是 2,旧版本见了就拒,那两格没用了。
	const redacted = collectRedactions(original, sections);
	if (redacted.length > 0) bag.redacted = redacted;

	return buildBackup({ kind: "full", createdAt, sections, secrets: sealSecrets(pin, bag) });
}

export function openFullBackup(env: BackupEnvelope, pin: string): OpenedFullBackup {
	if (env.kind !== "full" || !env.secrets) {
		throw new BackupRejectedError("invalid", serverText("service.backup.assemble.text.3"));
	}
	const bag = openSecrets(pin, env.secrets);
	const integrationSecrets = readIntegrationSecrets(bag.integrationSecrets);
	const sections: BackupSections = structuredClone(env.sections);

	// 照不变式那一份把**所有**被抹掉的地方填回去(apiKey、连接与拓展的凭据,以及往后新加的任何规则)。
	if (bag.redacted) applyRedactions(sections, bag.redacted);

	return { sections, integrationSecrets };
}
