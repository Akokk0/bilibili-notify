import type {
	GlobalConfig,
	PushAdapter,
	PushTarget,
	Subscription,
} from "@bilibili-notify/internal";

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
 * shapes `ConfigStore` reads/writes). Secret-bearing residue (apiKey, adapter
 * credentials) is stripped from these plaintext sections and, for `full`
 * backups, re-homed into the encrypted block — never left in the clear here.
 */

export const BACKUP_FORMAT = "bilibili-notify-backup" as const;
export const BACKUP_SCHEMA_VERSION = 1 as const;

export type BackupKind = "full" | "sanitized";

/** Non-secret config payload carried in plaintext in every backup. */
export interface BackupSections {
	globals?: GlobalConfig;
	subscriptions?: Subscription[];
	adapters?: PushAdapter[];
	targets?: PushTarget[];
}

export interface BackupEnvelope {
	format: typeof BACKUP_FORMAT;
	schemaVersion: number;
	kind: BackupKind;
	/** ISO-8601 timestamp, supplied by the caller (keeps builders pure/testable). */
	createdAt: string;
	sections: BackupSections;
}

export interface BuildBackupInput {
	kind: BackupKind;
	createdAt: string;
	sections: BackupSections;
}

/** Assemble a backup envelope from already-prepared sections. Pure. */
export function buildBackup(input: BuildBackupInput): BackupEnvelope {
	return {
		format: BACKUP_FORMAT,
		schemaVersion: BACKUP_SCHEMA_VERSION,
		kind: input.kind,
		createdAt: input.createdAt,
		sections: input.sections,
	};
}

/**
 * Parse a backup document — the import trust boundary. Throws on anything that
 * is not a well-formed, this-build-understands-it backup envelope:
 *   - wrong/absent `format` marker → not our file
 *   - unknown `kind`
 *   - `schemaVersion` newer than {@link BACKUP_SCHEMA_VERSION} → refuse (a newer
 *     export may carry fields/semantics this build cannot safely apply; never
 *     silently down-migrate). Older versions are accepted and would run through
 *     a forward migration once one exists (v1 is the floor, so none yet).
 */
export function parseBackup(json: string): BackupEnvelope {
	const raw = JSON.parse(json) as Partial<BackupEnvelope>;
	if (raw.format !== BACKUP_FORMAT) {
		throw new Error("not a bilibili-notify backup file");
	}
	if (raw.kind !== "full" && raw.kind !== "sanitized") {
		throw new Error(`unknown backup kind: ${String(raw.kind)}`);
	}
	if (typeof raw.schemaVersion !== "number") {
		throw new Error("backup is missing schemaVersion");
	}
	if (raw.schemaVersion > BACKUP_SCHEMA_VERSION) {
		throw new Error(
			`backup schemaVersion ${raw.schemaVersion} is newer than this build supports ` +
				`(max ${BACKUP_SCHEMA_VERSION}); please update bilibili-notify before restoring`,
		);
	}
	return raw as BackupEnvelope;
}
