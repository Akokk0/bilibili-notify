import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Btn } from "../../components/atoms";
import { GlassBox } from "../../components/glass-box";
import { Icon } from "../../components/icons";
import { ApiError, api } from "../../services/api";
import { BackupExportDialog } from "./BackupExportDialog";
import { BackupImportDialog } from "./BackupImportDialog";
import { type BackupKind, type BackupSectionSelection, backupFilename } from "./backup-file";
import { downloadJson } from "./download";

/** The envelope as the client handles it — opaque except for the download filename. */
interface ExportedEnvelope {
	kind: BackupKind;
	createdAt?: string;
}

interface ImportResult {
	subscriptions: { upserted: number; deleted: number };
	adapters: { upserted: number; deleted: number };
	targets: { upserted: number; deleted: number };
	globalsApplied: boolean;
	cookiesRestored: boolean;
}

function summarize(r: ImportResult): string {
	const scope = (label: string, s: { upserted: number; deleted: number }) =>
		s.upserted || s.deleted
			? `${label} ${s.upserted} 项${s.deleted ? `、删除 ${s.deleted} 项` : ""}`
			: null;
	const parts = [
		scope("订阅", r.subscriptions),
		scope("推送目标", r.targets),
		scope("适配器", r.adapters),
		r.globalsApplied ? "全局设置已应用" : null,
		r.cookiesRestored ? "B 站登录已恢复" : null,
	].filter(Boolean);
	return parts.length > 0
		? `导入完成：${parts.join(" · ")}`
		: "导入完成：备份内容与当前一致，无改动";
}

/**
 * 系统页「备份与恢复」一节。导出把后端组装好的信封直接落成本地文件;导入把选中的
 * 文件原样回传给后端(客户端只做格式嗅探,真正的校验/解密在服务端),落地后 invalidate
 * 全部查询 —— 后端已经通过 config-changed 热重载,前端只需重新拉一次即可对齐。
 */
export function BackupSection() {
	const qc = useQueryClient();
	const [dialog, setDialog] = useState<"export" | "import" | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	function fail(err: unknown): void {
		setError(err instanceof ApiError ? err.message : String(err));
		setNotice(null);
	}

	async function doExport(opts: {
		kind: BackupKind;
		sections: BackupSectionSelection;
		pin?: string;
	}): Promise<void> {
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const env = await api.post<ExportedEnvelope>("/api/backup/export", opts);
			downloadJson(backupFilename(opts.kind, env.createdAt ?? ""), env);
			setDialog(null);
			setNotice(
				opts.kind === "full"
					? "完整备份已下载 —— 里面有你的账号与密码，请妥善保管、切勿外发。"
					: "脱敏备份已下载。",
			);
		} catch (err) {
			fail(err);
		} finally {
			setBusy(false);
		}
	}

	async function doImport(opts: {
		backup: unknown;
		mode: "overwrite" | "merge";
		pin?: string;
	}): Promise<void> {
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const result = await api.post<ImportResult>("/api/backup/import", opts);
			setDialog(null);
			setNotice(summarize(result));
			await qc.invalidateQueries();
		} catch (err) {
			fail(err);
		} finally {
			setBusy(false);
		}
	}

	return (
		<GlassBox
			title="备份与恢复 · backup"
			subtitle="一键导出订阅 / 目标 / 适配器 / 全局设置 · 完整备份另含 B 站登录与密钥"
			accent="#8b5cf6"
			icon={<Icon.download size={14} />}
			badge="导出 / 导入"
		>
			<div className="text-[12px] leading-relaxed text-bn-text-secondary">
				<span className="font-semibold text-bn-text-primary">完整备份</span>
				：含机密（B 站 Cookie、AI Key、适配器凭据），用 4 位 PIN 加密，用于换机 / 灾备还原。
				<br />
				<span className="font-semibold text-bn-text-primary">脱敏导出</span>
				：机密位置留空，纯明文 JSON，可存档、可分享给别人抄配置。
			</div>

			{error ? (
				<div className="mt-3 rounded border border-bn-danger-border bg-bn-danger-soft p-2.5 text-xs text-bn-danger-text">
					{error}
				</div>
			) : null}
			{notice ? (
				<div className="mt-3 rounded border border-bn-border bg-bn-surface/60 p-2.5 text-xs text-bn-text-secondary">
					{notice}
				</div>
			) : null}

			<div className="mt-3.5 flex flex-wrap gap-2 border-t border-bn-border-subtle pt-3">
				<Btn variant="primary" disabled={busy} onClick={() => setDialog("export")}>
					导出备份
				</Btn>
				<Btn variant="outline" disabled={busy} onClick={() => setDialog("import")}>
					导入备份
				</Btn>
			</div>

			{dialog === "export" ? (
				<BackupExportDialog
					busy={busy}
					onCancel={() => setDialog(null)}
					onExport={(opts) => void doExport(opts)}
				/>
			) : null}
			{dialog === "import" ? (
				<BackupImportDialog
					busy={busy}
					onCancel={() => setDialog(null)}
					onImport={(opts) => void doImport(opts)}
				/>
			) : null}
		</GlassBox>
	);
}
