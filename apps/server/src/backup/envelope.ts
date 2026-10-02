import type {
	Connection,
	GlobalConfig,
	PushTarget,
	Subscription,
	SubscriptionTag,
} from "@bilibili-notify/internal";
import type { EncryptedSecrets } from "./crypto.js";
import { BackupRejectedError } from "./rejected-error.js";

/**
 * Backup envelope — the single-file, self-describing container for the
 * "一键备份 / 恢复" feature.
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
/**
 * 3 = 1.0 起导出的备份(设置按集成分文件以后,各集成的设置单独一节 `integrations`;2 只在开发期用过、没发布)。
 * 1.0 之前(0.x 导出的 1)一律拒收(ADR-0022 决策 6):要恢复就先装 0.12 恢复,再升级到 1.0 走迁移 —— 0.x 的形状
 * 只有迁移器认得。
 */
export const BACKUP_SCHEMA_VERSION = 3 as const;

export type BackupKind = "full" | "sanitized";

/** Non-secret config payload carried in plaintext in every backup. */
export interface BackupSections {
	globals?: GlobalConfig;
	/** 各集成的设置(今天只有 B 站),按集成的键;与 `globals` 同一个勾选(「设置」)。 */
	integrations?: Record<string, unknown>;
	/**
	 * 各拓展的设置,按拓展 id(盘上 `config/settings/extensions/<id>.json`);同一个勾选。开关不在这儿,在
	 * `globals.extensions`。脱敏照拓展各自声明的密钥键(`sanitize.ts`)。
	 */
	extensionSettings?: Record<string, unknown>;
	/** 订阅:B 站与拓展同一节,行行带 `identity`(ADR-0021 决策 15)。 */
	subscriptions?: Subscription[];
	/** 订阅标签表(ADR-0034):跟订阅同一个勾选、同进同出;订阅上挂的 `tagIds` 指的就是它。 */
	subscriptionTags?: SubscriptionTag[];
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
 *     silently down-migrate).
 *   - `schemaVersion` older → refuse too: a pre-1.0 backup carries 0.x shapes
 *     only the migrator understands (ADR-0022 决策 6).
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
	if (o.schemaVersion < BACKUP_SCHEMA_VERSION) {
		throw new BackupRejectedError(
			"unsupported",
			"这是 1.0 之前导出的备份，1.0 不能直接恢复：请先装 0.12 恢复这份备份，再升级到 1.0，旧数据会自动迁移过来",
		);
	}
	return o as BackupEnvelope;
}

/** Parse a backup document from JSON text, then {@link validateBackup} it. */
export function parseBackup(json: string): BackupEnvelope {
	return validateBackup(JSON.parse(json));
}
