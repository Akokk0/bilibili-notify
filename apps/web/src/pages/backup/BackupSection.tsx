import { Btn, ConfirmDialog, ErrorNote, GlassBox, Icon } from "@bilibili-notify/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, api } from "../../services/api";
import { BackupExportDialog } from "./BackupExportDialog";
import { BackupImportDialog } from "./BackupImportDialog";
import { type BackupKind, type BackupSectionSelection, backupFilename } from "./backup-file";
import { downloadJson } from "./download";
import { type ImportResult, summarizeImport } from "./summary";

/** The envelope as the client handles it — opaque except for the download filename. */
interface ExportedEnvelope {
	kind: BackupKind;
	createdAt?: string;
}

/** What the dashboard sends to `/api/backup/import`. */
interface ImportRequest {
	backup: unknown;
	mode: "overwrite" | "merge";
	pin?: string;
}

/** 信封自报的档次。脱敏档要在回执里多交代一句「凭据是空的」——见 summarizeImport。 */
function kindOf(backup: unknown): BackupKind {
	return (backup as { kind?: unknown } | null)?.kind === "sanitized" ? "sanitized" : "full";
}

/** The scopes a plan would delete, e.g. ["订阅 1 项", "推送目标 2 项"]. */
function deletions(r: ImportResult): string[] {
	return [
		["订阅", r.subscriptions.deleted] as const,
		["推送目标", r.targets.deleted] as const,
		["推送适配器", r.adapters.deleted] as const,
	]
		.filter(([, n]) => n > 0)
		.map(([label, n]) => `${label} ${n} 项`);
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
	/** A planned import waiting for the user to confirm its deletions. */
	const [pending, setPending] = useState<{ req: ImportRequest; plan: ImportResult } | null>(null);

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

	/**
	 * 导入分两拍。第一拍 dryRun:后端算出计划但不写,顺带在写任何东西之前把 PIN 错
	 * 暴露出来。计划里若有删除(只可能是覆盖模式),必须先拿真实数字向主人确认 ——
	 * 删除不可撤销。没有删除就直接落地,不拿多余的弹框烦主人。
	 */
	async function doImport(req: ImportRequest): Promise<void> {
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const plan = await api.post<ImportResult>("/api/backup/import", { ...req, dryRun: true });
			if (deletions(plan).length > 0) {
				setPending({ req, plan });
				return;
			}
			await apply(req);
		} catch (err) {
			fail(err);
		} finally {
			setBusy(false);
		}
	}

	/** Second beat: actually write. */
	async function apply(req: ImportRequest): Promise<void> {
		setBusy(true);
		setError(null);
		try {
			const result = await api.post<ImportResult>("/api/backup/import", { ...req, dryRun: false });
			setPending(null);
			setDialog(null);
			setNotice(summarizeImport(result, kindOf(req.backup)));
			await qc.invalidateQueries();
		} catch (err) {
			fail(err);
			setPending(null);
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
				：含机密（B 站 Cookie、AI Key、适配器凭据），用 6 位 PIN 加密，用于换机 / 灾备还原。
				<br />
				<span className="font-semibold text-bn-text-primary">脱敏导出</span>
				：机密位置留空，纯明文 JSON，可存档、可分享给别人抄配置。
			</div>

			{error ? <ErrorNote className="mt-3">{error}</ErrorNote> : null}
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
			{pending ? (
				<ConfirmDialog
					danger
					title="覆盖导入会删除现有配置"
					message={
						<>
							这份备份里没有的东西会被删掉：
							<span className="font-bold text-bn-danger-text">
								{deletions(pending.plan).join("、")}
							</span>
							。删除不可撤销，确定要继续吗？
						</>
					}
					confirmLabel="确认覆盖"
					cancelLabel="再想想"
					onConfirm={() => void apply(pending.req)}
					onCancel={() => setPending(null)}
				/>
			) : null}
		</GlassBox>
	);
}
