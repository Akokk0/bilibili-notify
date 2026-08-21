import { Btn, CheckRow, ErrorNote, Icon, ModalShell } from "@bilibili-notify/ui";
import { useState } from "react";
import { type BackupKind, type BackupSectionSelection, isValidPin } from "./backup-file";
import { ChoiceCard, PinField } from "./dialog-bits";

export interface BackupExportDialogProps {
	onCancel: () => void;
	onExport: (opts: { kind: BackupKind; sections: BackupSectionSelection; pin?: string }) => void;
	busy?: boolean;
}

const SECTIONS: { key: keyof BackupSectionSelection; label: string }[] = [
	{ key: "subscriptions", label: "订阅 + 分组" },
	{ key: "targets", label: "推送目标" },
	{ key: "adapters", label: "推送适配器" },
	{ key: "globals", label: "全局设置" },
];

const ALL_SELECTED: BackupSectionSelection = {
	globals: true,
	subscriptions: true,
	adapters: true,
	targets: true,
};

export function BackupExportDialog({ onCancel, onExport, busy }: BackupExportDialogProps) {
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
		<ModalShell onCancel={onCancel} width={400} bodyClassName="p-5" title="导出备份">
			<div className="mb-4 grid grid-cols-2 gap-2">
				<ChoiceCard
					active={kind === "full"}
					title="完整备份"
					sub="含机密 · 用于灾备还原"
					onClick={() => setKind("full")}
				/>
				<ChoiceCard
					active={kind === "sanitized"}
					title="脱敏导出"
					sub="无机密 · 可存档/分享"
					onClick={() => setKind("sanitized")}
				/>
			</div>

			{kind === "full" ? (
				<ErrorNote icon={<Icon.warning size={14} />} className="mb-4">
					此文件 = 你的 B 站账号与面板密码，请妥善保管、切勿外发；6 位 PIN
					仅防手滑，真正的安全靠保管好文件本身。
				</ErrorNote>
			) : null}

			{kind === "full" ? (
				<PinField className="mb-4" value={pin} onChange={setPin} placeholder="设置 6 位数字 PIN" />
			) : null}

			<div className="mb-1 text-bn-sm font-semibold text-bn-text-secondary">备份内容</div>
			<div className="flex flex-col gap-1.5">
				{SECTIONS.map(({ key, label }) => (
					<CheckRow key={key} checked={sections[key]} onChange={() => toggle(key)}>
						{label}
					</CheckRow>
				))}
			</div>

			<div className="mt-4 flex justify-end gap-2">
				<Btn variant="outline" size="sm" onClick={onCancel} disabled={busy}>
					取消
				</Btn>
				<Btn variant="primary" size="sm" onClick={submit} disabled={!canExport}>
					{busy ? "导出中…" : "导出"}
				</Btn>
			</div>
		</ModalShell>
	);
}
