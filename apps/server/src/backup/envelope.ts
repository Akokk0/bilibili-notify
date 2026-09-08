import type { Connection, GlobalConfig, PushTarget, Subscription } from "@bilibili-notify/internal";
import type { EncryptedSecrets } from "./crypto.js";

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
 * on anything that is not a well-formed, this-build-understands-it envelope:
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
		throw new Error("not a bilibili-notify backup file");
	}
	if (o.kind !== "full" && o.kind !== "sanitized") {
		throw new Error(`unknown backup kind: ${String(o.kind)}`);
	}
	if (typeof o.schemaVersion !== "number") {
		throw new Error("backup is missing schemaVersion");
	}
	if (o.schemaVersion > BACKUP_SCHEMA_VERSION) {
		throw new Error(
			`backup schemaVersion ${o.schemaVersion} is newer than this build supports ` +
				`(max ${BACKUP_SCHEMA_VERSION}); please update bilibili-notify before restoring`,
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
