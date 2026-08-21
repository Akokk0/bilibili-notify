import { Btn, ErrorNote, ModalShell } from "@bilibili-notify/ui";
import { type ChangeEvent, useState } from "react";
import { type ClientBackup, isValidPin, looksLikeBackup, readFileAsText } from "./backup-file";
import { ChoiceCard, PinField } from "./dialog-bits";

type Mode = "overwrite" | "merge";

export interface BackupImportDialogProps {
	onCancel: () => void;
	onImport: (opts: { backup: unknown; mode: Mode; pin?: string }) => void;
	busy?: boolean;
}

export function BackupImportDialog({ onCancel, onImport, busy }: BackupImportDialogProps) {
	const [backup, setBackup] = useState<ClientBackup | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [mode, setMode] = useState<Mode>("overwrite");
	const [pin, setPin] = useState("");

	async function onFile(e: ChangeEvent<HTMLInputElement>): Promise<void> {
		const file = e.target.files?.[0];
		if (!file) return;
		setError(null);
		try {
			const obj: unknown = JSON.parse(await readFileAsText(file));
			if (!looksLikeBackup(obj)) {
				setBackup(null);
				setError("这不是一个 bilibili-notify 备份文件");
				return;
			}
			setBackup(obj);
			// Smart default: a full backup is a disaster snapshot → overwrite; a
			// sanitized share is additive → merge. The user can still flip it.
			setMode(obj.kind === "full" ? "overwrite" : "merge");
		} catch {
			setBackup(null);
			setError("文件解析失败，请确认选择的是备份文件");
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
		<ModalShell onCancel={onCancel} width={400} bodyClassName="p-5" title="导入 / 恢复备份">
			<label className="mb-3 flex cursor-pointer items-center justify-center rounded-lg border border-dashed border-bn-border bg-bn-surface px-3 py-4 text-bn-base text-bn-text-secondary transition hover:border-bn-pink/50 hover:text-bn-text-primary">
				<span>选择备份文件（.bnbackup / .json）…</span>
				<input
					aria-label="选择备份文件"
					type="file"
					accept=".json,.bnbackup,application/json"
					onChange={onFile}
					className="sr-only"
				/>
			</label>

			{error ? <ErrorNote className="mb-3">{error}</ErrorNote> : null}

			{backup ? (
				<>
					<div className="mb-3 text-bn-sm text-bn-text-secondary">
						检测到：{isFull ? "完整备份（含机密）" : "脱敏导出（无机密）"}
						{backup.createdAt ? ` · ${backup.createdAt.slice(0, 10)}` : ""}
					</div>

					<div className="mb-1 text-bn-sm font-semibold text-bn-text-secondary">落地方式</div>
					<div className="mb-3 grid grid-cols-2 gap-2">
						<ChoiceCard
							active={mode === "overwrite"}
							title="覆盖"
							sub="回到快照 · 删多余"
							onClick={() => setMode("overwrite")}
						/>
						<ChoiceCard
							active={mode === "merge"}
							title="合并"
							sub="并入现有 · 不删"
							onClick={() => setMode("merge")}
						/>
					</div>

					{isFull ? (
						<PinField
							className="mb-1"
							value={pin}
							onChange={setPin}
							placeholder="输入 6 位数字 PIN"
						/>
					) : null}
				</>
			) : null}

			<div className="mt-4 flex justify-end gap-2">
				<Btn variant="outline" size="sm" onClick={onCancel} disabled={busy}>
					取消
				</Btn>
				<Btn variant="primary" size="sm" onClick={submit} disabled={!canImport}>
					{busy ? "导入中…" : "导入"}
				</Btn>
			</div>
		</ModalShell>
	);
}
