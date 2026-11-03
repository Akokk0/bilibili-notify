import { AddFileButton, Btn, ErrorNote, ModalShell, OptionCard } from "@bilibili-notify/ui";
import { useState } from "react";
import { useT } from "../../i18n";
import { type ClientBackup, isValidPin, looksLikeBackup, readFileAsText } from "./backup-file";
import { PinField } from "./dialog-bits";

type Mode = "overwrite" | "merge";

export interface BackupImportDialogProps {
	onCancel: () => void;
	onImport: (opts: { backup: unknown; mode: Mode; pin?: string }) => void;
	busy?: boolean;
}

export function BackupImportDialog({ onCancel, onImport, busy }: BackupImportDialogProps) {
	const tx = useT();

	const [backup, setBackup] = useState<ClientBackup | null>(null);
	const [error, setError] = useState<"invalid" | "unreadable" | null>(null);
	const [mode, setMode] = useState<Mode>("overwrite");
	const [pin, setPin] = useState("");

	async function onFile(file: File | undefined): Promise<void> {
		if (!file) return;
		setError(null);
		try {
			const obj: unknown = JSON.parse(await readFileAsText(file));
			if (!looksLikeBackup(obj)) {
				setBackup(null);
				setError("invalid");
				return;
			}
			setBackup(obj);
			// Smart default: a full backup is a disaster snapshot → overwrite; a
			// sanitized share is additive → merge. The user can still flip it.
			setMode(obj.kind === "full" ? "overwrite" : "merge");
		} catch {
			setBackup(null);
			setError("unreadable");
		}
	}

	const isFull = backup?.kind === "full";
	const pinOk = !isFull || isValidPin(pin);
	const canImport = !busy && backup !== null && pinOk;

	function submit(): void {
		if (!backup) return;
		onImport({ backup, mode, pin: isFull ? pin : undefined });
	}

	return (
		<ModalShell
			onCancel={onCancel}
			width={400}
			bodyClassName="p-5"
			title={tx("panelUi.pages.backup.BackupImportDialog.3")}
		>
			{/* 「这里还能塞一个文件」的虚线空位 —— 收编前是手写 label,说的还是家族统一
			    前的老方言(bn-border 淡边 + 实底 + hover 不变粉)。 */}
			<AddFileButton
				accept=".json,.bnbackup,application/json"
				onFile={onFile}
				className="mb-3 flex items-center justify-center rounded-lg px-3 py-4 text-bn-base"
			>
				{tx("panelUi.pages.backup.BackupImportDialog.4")}
			</AddFileButton>

			{error ? (
				<ErrorNote className="mb-3">
					{error === "invalid"
						? tx("panelUi.pages.backup.BackupImportDialog.1")
						: tx("panelUi.pages.backup.BackupImportDialog.2")}
				</ErrorNote>
			) : null}

			{backup ? (
				<>
					<div className="mb-3 text-bn-sm text-bn-text-secondary">
						{tx("panelUi.pages.backup.BackupImportDialog.5")}
						{isFull
							? tx("panelUi.pages.backup.BackupImportDialog.6")
							: tx("panelUi.pages.backup.BackupImportDialog.7")}
						{backup.createdAt ? ` · ${backup.createdAt.slice(0, 10)}` : ""}
					</div>

					<div className="mb-1 text-bn-sm font-semibold text-bn-text-secondary">
						{tx("panelUi.pages.backup.BackupImportDialog.8")}
					</div>
					<div className="mb-3 grid grid-cols-2 gap-2">
						<OptionCard
							active={mode === "overwrite"}
							label={tx("panelUi.pages.backup.BackupImportDialog.9")}
							description={tx("panelUi.pages.backup.BackupImportDialog.10")}
							onSelect={() => setMode("overwrite")}
						/>
						<OptionCard
							active={mode === "merge"}
							label={tx("panelUi.pages.backup.BackupImportDialog.11")}
							description={tx("panelUi.pages.backup.BackupImportDialog.12")}
							onSelect={() => setMode("merge")}
						/>
					</div>

					{isFull ? (
						<PinField
							className="mb-1"
							value={pin}
							onChange={setPin}
							placeholder={tx("panelUi.pages.backup.BackupImportDialog.13")}
						/>
					) : null}
				</>
			) : null}

			<div className="mt-4 flex justify-end gap-2">
				<Btn variant="outline" size="sm" onClick={onCancel} disabled={busy}>
					{tx("panelUi.pages.backup.BackupImportDialog.14")}
				</Btn>
				<Btn variant="primary" size="sm" onClick={submit} disabled={!canImport}>
					{busy
						? tx("panelUi.pages.backup.BackupImportDialog.15")
						: tx("panelUi.pages.backup.BackupImportDialog.16")}
				</Btn>
			</div>
		</ModalShell>
	);
}
