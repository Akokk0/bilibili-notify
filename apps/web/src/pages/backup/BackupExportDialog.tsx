import { useState } from "react";
import { Btn, CheckRow } from "../../components/atoms";
import { ModalShell } from "../../components/dialog";
import { Icon } from "../../components/icons";
import { type BackupKind, type BackupSectionSelection, isValidPin } from "./backup-file";

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
		<ModalShell onCancel={onCancel} width={400} bodyClassName="p-5">
			<div className="mb-3 text-base font-bold text-bn-text-primary">导出备份</div>

			<div className="mb-4 grid grid-cols-2 gap-2">
				<KindCard
					active={kind === "full"}
					title="完整备份"
					sub="含机密 · 用于灾备还原"
					onClick={() => setKind("full")}
				/>
				<KindCard
					active={kind === "sanitized"}
					title="脱敏导出"
					sub="无机密 · 可存档/分享"
					onClick={() => setKind("sanitized")}
				/>
			</div>

			{kind === "full" ? (
				<div className="mb-4 flex items-start gap-1.5 rounded-lg border border-bn-danger-border bg-bn-danger-soft px-3 py-2.5 text-[12px] leading-relaxed text-bn-danger-text">
					<Icon.warning size={14} className="mt-0.5 shrink-0" />
					<span>
						此文件 = 你的 B 站账号与面板密码，请妥善保管、切勿外发；6 位 PIN
						仅防手滑，真正的安全靠保管好文件本身。
					</span>
				</div>
			) : null}

			{kind === "full" ? (
				<label className="mb-4 block">
					<span className="mb-1 block text-[12px] font-semibold text-bn-text-secondary">
						备份 PIN（6 位数字）
					</span>
					<input
						type="password"
						inputMode="numeric"
						maxLength={6}
						value={pin}
						onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
						placeholder="设置 6 位数字 PIN"
						className="w-full rounded-md border border-bn-border bg-bn-surface px-3 py-2 text-[13px] tracking-[0.4em] text-bn-text-primary outline-none focus:border-bn-pink"
					/>
				</label>
			) : null}

			<div className="mb-1 text-[12px] font-semibold text-bn-text-secondary">备份内容</div>
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

function KindCard(props: { active: boolean; title: string; sub: string; onClick: () => void }) {
	return (
		<button
			type="button"
			onClick={props.onClick}
			className={`rounded-lg border px-3 py-2.5 text-left transition ${
				props.active
					? "border-bn-pink/60 bg-bn-pink/10"
					: "border-bn-border bg-bn-surface hover:border-bn-pink/40"
			}`}
		>
			<div className="text-[13px] font-bold text-bn-text-primary">{props.title}</div>
			<div className="text-[11px] text-bn-text-tertiary">{props.sub}</div>
		</button>
	);
}
