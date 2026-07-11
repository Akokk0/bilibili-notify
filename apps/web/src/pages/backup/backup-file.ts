/**
 * Client-side backup helpers. The web package can't import the server's backup
 * types, so it mirrors the small pieces it needs.
 */

export type BackupKind = "full" | "sanitized";

/** Format marker mirrored from the server envelope, used to sniff an imported file. */
export const BACKUP_FORMAT = "bilibili-notify-backup";

/** A parsed backup document as the client cares about it (opaque otherwise). */
export interface ClientBackup {
	format: string;
	kind: BackupKind;
	createdAt?: string;
}

/** Client-side sniff: is this parsed JSON a recognizable backup envelope? */
export function looksLikeBackup(obj: unknown): obj is ClientBackup {
	if (!obj || typeof obj !== "object") return false;
	const o = obj as Record<string, unknown>;
	return o.format === BACKUP_FORMAT && (o.kind === "full" || o.kind === "sanitized");
}

/** Which config scopes to include in an export (the sanitized-档 checkboxes). */
export interface BackupSectionSelection {
	globals: boolean;
	subscriptions: boolean;
	adapters: boolean;
	targets: boolean;
}

/**
 * Download filename for an exported backup. Full backups use `.bnbackup` (they
 * carry the PIN-encrypted secret block); sanitized backups use `.json` (plain,
 * readable, diff-able). The date stem lets the user tell backups apart.
 */
export function backupFilename(kind: BackupKind, createdAt: string): string {
	const date = /^\d{4}-\d{2}-\d{2}/.test(createdAt) ? createdAt.slice(0, 10) : "backup";
	const ext = kind === "full" ? "bnbackup" : "json";
	return `bilibili-notify-${kind}-${date}.${ext}`;
}

/** The backup PIN is exactly four digits (a bank-card-style convenience lock). */
export function isValidPin(pin: string): boolean {
	return /^\d{4}$/.test(pin);
}

/**
 * Read a picked file as text. Goes through FileReader rather than `Blob.text()`
 * because jsdom implements the former but not the latter.
 */
export function readFileAsText(file: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result ?? ""));
		reader.onerror = () => reject(reader.error ?? new Error("读取文件失败"));
		reader.readAsText(file);
	});
}
