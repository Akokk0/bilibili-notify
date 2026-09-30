import type {
	Connection,
	ExtensionSubscription,
	GlobalConfig,
	PushTarget,
	Subscription,
} from "@bilibili-notify/internal";
import type { EncryptedSecrets } from "./crypto.js";
import { BackupRejectedError } from "./rejected-error.js";

/**
 * Backup envelope — the single-file, self-describing container for the
 * standalone end's "一键备份 / 恢复" feature.
 *
 * A backup is one JSON document with a stable {@link BACKUP_FORMAT} marker and
 * a {@link BACKUP_SCHEMA_VERSION}. Two kinds:
 *   - `sanitized` — non-secret business config only (subscriptions/targets/…),
 *     safe to share / commit to git. No `secrets` block.
 *   - `full` — the same plaintext sections PLUS a PIN-encrypted `secrets` block
 *     (cookie / apiKey / bot tokens). See the `secrets` slice for that shape.
 *
 * `sections` carries the platform-neutral config scopes verbatim (the same
 * shapes `ConfigStore` reads/writes). Secret-bearing residue (apiKey, connection
 * credentials) is stripped from these plaintext sections and, for `full`
 * backups, re-homed into the encrypted block — never left in the clear here.
 */

export const BACKUP_FORMAT = "bilibili-notify-backup" as const;
export const BACKUP_SCHEMA_VERSION = 1 as const;

export type BackupKind = "full" | "sanitized";

/** Non-secret config payload carried in plaintext in every backup. */
export interface BackupSections {
	globals?: GlobalConfig;
	/** B 站订阅。 */
	subscriptions?: Subscription[];
	/**
	 * 拓展订阅(ADR-0019 决策 48)。**单独一节,不抬 `schemaVersion`**:旧版 BN 不认识这一节,
	 * 整个跳过、照常恢复其余几节;混进 `subscriptions` 的话,旧版恢复时那几行过不了 uid 校验,
	 * 整份恢复被拒。导出时与 `subscriptions` 同一个勾选管着;勾了就一定有这一节(哪怕是空的),
	 * 这样「新备份里一条拓展订阅都没有」与「老备份根本不知道拓展订阅」分得开。
	 */
	extensionSubscriptions?: ExtensionSubscription[];
	connections?: Connection[];
	targets?: PushTarget[];
}

export interface BackupEnvelope {
	format: typeof BACKUP_FORMAT;
	schemaVersion: number;
	kind: BackupKind;
	/** ISO-8601 timestamp, supplied by the caller (keeps builders pure/testable). */
	createdAt: string;
	sections: BackupSections;
	/** PIN-encrypted credential block. Present only in `kind:"full"` backups. */
	secrets?: EncryptedSecrets;
}

export interface BuildBackupInput {
	kind: BackupKind;
	createdAt: string;
	sections: BackupSections;
	secrets?: EncryptedSecrets;
}

/** Assemble a backup envelope from already-prepared sections. Pure. */
export function buildBackup(input: BuildBackupInput): BackupEnvelope {
	const env: BackupEnvelope = {
		format: BACKUP_FORMAT,
		schemaVersion: BACKUP_SCHEMA_VERSION,
		kind: input.kind,
		createdAt: input.createdAt,
		sections: input.sections,
	};
	if (input.secrets) env.secrets = input.secrets;
	return env;
}

/**
 * Validate an already-parsed backup object — the import trust boundary. Throws
 * a {@link BackupRejectedError} (自带码、message 是给人看的中文)on anything that is
 * not a well-formed, this-build-understands-it envelope:
 *   - wrong/absent `format` marker → not our file
 *   - unknown `kind`
 *   - `schemaVersion` newer than {@link BACKUP_SCHEMA_VERSION} → refuse (a newer
 *     export may carry fields/semantics this build cannot safely apply; never
 *     silently down-migrate). Older versions are accepted and would run through
 *     a forward migration once one exists (v1 is the floor, so none yet).
 *
 * It is also where the plaintext sections get their **key** normalised: the
 * connections section used to be called `adapters`. Folding it here rather than
 * at each reader means the rest of the import path — plan, migrate, apply —
 * only ever sees one name, and a full backup's encrypted block is folded the
 * same way where it is opened.
 *
 * Use this on the JSON body of an import request (already parsed by the HTTP
 * layer); {@link parseBackup} is the string convenience wrapper.
 */
export function validateBackup(raw: unknown): BackupEnvelope {
	const o = (raw ?? {}) as Partial<BackupEnvelope>;
	if (o.format !== BACKUP_FORMAT) {
		throw new BackupRejectedError("invalid", "这不是 bilibili-notify 导出的备份文件");
	}
	if (o.kind !== "full" && o.kind !== "sanitized") {
		throw new BackupRejectedError(
			"invalid",
			"备份文件里的类型不认识（只有 full 与 sanitized 两种）",
		);
	}
	if (typeof o.schemaVersion !== "number") {
		throw new BackupRejectedError("invalid", "备份文件缺少格式版本号（schemaVersion）");
	}
	if (o.schemaVersion > BACKUP_SCHEMA_VERSION) {
		throw new BackupRejectedError(
			"unsupported",
			`这份备份的格式版本（${o.schemaVersion}）比当前版本认得的（最高 ${BACKUP_SCHEMA_VERSION}）新，请先升级 bilibili-notify 再恢复`,
		);
	}
	return foldLegacySectionKeys(o as BackupEnvelope);
}

/** 连接那一段从前叫 `adapters`。老备份里只有老键,新的只写新键。 */
function foldLegacySectionKeys(env: BackupEnvelope): BackupEnvelope {
	const sections = env.sections as (BackupSections & { adapters?: Connection[] }) | undefined;
	if (!sections?.adapters) return env;
	const { adapters, ...rest } = sections;
	return { ...env, sections: { ...rest, connections: rest.connections ?? adapters } };
}

/** Parse a backup document from JSON text, then {@link validateBackup} it. */
export function parseBackup(json: string): BackupEnvelope {
	return validateBackup(JSON.parse(json));
}
