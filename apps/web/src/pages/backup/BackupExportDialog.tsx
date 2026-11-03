import { Btn, CheckRow, ErrorNote, Icon, ModalShell, OptionCard } from "@bilibili-notify/ui";
import { useState } from "react";
import { i18n, useT } from "../../i18n";
import { type BackupKind, type BackupSectionSelection, isValidPin } from "./backup-file";
import { PinField } from "./dialog-bits";

export interface BackupExportDialogProps {
	onCancel: () => void;
	onExport: (opts: { kind: BackupKind; sections: BackupSectionSelection; pin?: string }) => void;
	busy?: boolean;
}

const SECTIONS: { key: keyof BackupSectionSelection; label: string }[] = [
	{
		key: "subscriptions",
		get label() {
			return i18n.t("panelUi.pages.backup.BackupExportDialog.1");
		},
	},
	{
		key: "targets",
		get label() {
			return i18n.t("panelUi.pages.backup.BackupExportDialog.2");
		},
	},
	{
		key: "connections",
		get label() {
			return i18n.t("panelUi.pages.backup.BackupExportDialog.3");
		},
	},
	{
		key: "globals",
		get label() {
			return i18n.t("panelUi.pages.backup.BackupExportDialog.4");
		},
	},
];

const ALL_SELECTED: BackupSectionSelection = {
	globals: true,
	subscriptions: true,
	connections: true,
	targets: true,
};

export function BackupExportDialog({ onCancel, onExport, busy }: BackupExportDialogProps) {
	const tx = useT();

	const [kind, setKind] = useState<BackupKind>("full");
	const [sections, setSections] = useState<BackupSectionSelection>(ALL_SELECTED);
	const [pin, setPin] = useState("");

	const pinOk = kind !== "full" || isValidPin(pin);
	const anySection = Object.values(sections).some(Boolean);
	const canExport = !busy && pinOk && anySection;

	function toggle(key: keyof BackupSectionSelection): void {
		setSections((s) => ({ ...s, [key]: !s[key] }));
	}

	function submit(): void {
		onExport({ kind, sections, pin: kind === "full" ? pin : undefined });
	}

	return (
		<ModalShell
			onCancel={onCancel}
			width={400}
			bodyClassName="p-5"
			title={tx("panelUi.pages.backup.BackupExportDialog.5")}
		>
			<div className="mb-4 grid grid-cols-2 gap-2">
				<OptionCard
					active={kind === "full"}
					label={tx("panelUi.pages.backup.BackupExportDialog.6")}
					description={tx("panelUi.pages.backup.BackupExportDialog.7")}
					onSelect={() => setKind("full")}
				/>
				<OptionCard
					active={kind === "sanitized"}
					label={tx("panelUi.pages.backup.BackupExportDialog.8")}
					description={tx("panelUi.pages.backup.BackupExportDialog.9")}
					onSelect={() => setKind("sanitized")}
				/>
			</div>

			{kind === "full" ? (
				<ErrorNote icon={<Icon.warning size={14} />} className="mb-4">
					{tx("panelUi.pages.backup.BackupExportDialog.10")}
				</ErrorNote>
			) : null}

			{kind === "full" ? (
				<PinField
					className="mb-4"
					value={pin}
					onChange={setPin}
					placeholder={tx("panelUi.pages.backup.BackupExportDialog.11")}
				/>
			) : null}

			<div className="mb-1 text-bn-sm font-semibold text-bn-text-secondary">
				{tx("panelUi.pages.backup.BackupExportDialog.12")}
			</div>
			<div className="flex flex-col gap-1.5">
				{SECTIONS.map(({ key, label }) => (
					<CheckRow key={key} checked={sections[key]} onChange={() => toggle(key)}>
						{label}
					</CheckRow>
				))}
			</div>

			<div className="mt-4 flex justify-end gap-2">
				<Btn variant="outline" size="sm" onClick={onCancel} disabled={busy}>
					{tx("panelUi.pages.backup.BackupExportDialog.13")}
				</Btn>
				<Btn variant="primary" size="sm" onClick={submit} disabled={!canExport}>
					{busy
						? tx("panelUi.pages.backup.BackupExportDialog.14")
						: tx("panelUi.pages.backup.BackupExportDialog.15")}
				</Btn>
			</div>
		</ModalShell>
	);
}
