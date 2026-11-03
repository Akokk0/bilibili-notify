import type { BackupExportPreviewResponse } from "@bilibili-notify/contract";
import { Btn, ConfirmDialog, ErrorNote, GlassBox, Icon } from "@bilibili-notify/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { SECTION_ACCENT } from "../../config/section-accents";
import { INVALID_SETTINGS_QUERY_PREFIX } from "../../hooks/useInvalidSettings";
import { i18n, useT, useTextOptions } from "../../i18n";
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

/** What the dashboard sends to `/api/system/backup/import`. */
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
		[i18n.t("panelUi.pages.backup.BackupSection.1"), r.subscriptions.deleted] as const,
		[i18n.t("panelUi.pages.backup.BackupSection.2"), r.targets.deleted] as const,
		[i18n.t("panelUi.pages.backup.BackupSection.3"), r.connections.deleted] as const,
	]
		.filter(([, n]) => n > 0)
		.map(([label, n]) =>
			i18n.t("panelUi.pages.backup.BackupSection.4", { value0: label, count: n }),
		);
}

/**
 * 系统页「备份与恢复」一节。导出把后端组装好的信封直接落成本地文件;导入把选中的
 * 文件原样回传给后端(客户端只做格式嗅探,真正的校验/解密在服务端),落地后 invalidate
 * 全部查询 —— 后端已经通过 config-changed 热重载,前端只需重新拉一次即可对齐。
 */
export function BackupSection() {
	const tx = useT();

	const qc = useQueryClient();
	const [dialog, setDialog] = useState<"export" | "import" | null>(null);
	const { locale, voice } = useTextOptions();
	const preview = useQuery({
		queryKey: [...INVALID_SETTINGS_QUERY_PREFIX, "backup-preview", locale, voice],
		queryFn: () => api.get<BackupExportPreviewResponse>("/api/system/backup/preview"),
		enabled: dialog === "export",
		retry: false,
		staleTime: 0,
	});
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<
		| { kind: "export"; backupKind: BackupKind }
		| { kind: "import"; backupKind: BackupKind; result: ImportResult }
		| null
	>(null);
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
			const env = await api.post<ExportedEnvelope>("/api/system/backup/export", opts);
			downloadJson(backupFilename(opts.kind, env.createdAt ?? ""), env);
			setDialog(null);
			setNotice({ kind: "export", backupKind: opts.kind });
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
			const plan = await api.post<ImportResult>("/api/system/backup/import", {
				...req,
				dryRun: true,
			});
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
			const result = await api.post<ImportResult>("/api/system/backup/import", {
				...req,
				dryRun: false,
			});
			setPending(null);
			setDialog(null);
			setNotice({ kind: "import", backupKind: kindOf(req.backup), result });
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
			title={tx("panelUi.pages.backup.BackupSection.7")}
			subtitle={tx("panelUi.pages.backup.BackupSection.8")}
			accent={SECTION_ACCENT.system}
			icon={<Icon.download size={14} />}
			badge={tx("panelUi.pages.backup.BackupSection.9")}
		>
			<div className="text-bn-sm leading-relaxed text-bn-text-secondary">
				<span className="font-semibold text-bn-text-primary">
					{tx("panelUi.pages.backup.BackupSection.10")}
				</span>
				{tx("panelUi.pages.backup.BackupSection.11")}
				<br />
				<span className="font-semibold text-bn-text-primary">
					{tx("panelUi.pages.backup.BackupSection.12")}
				</span>
				{tx("panelUi.pages.backup.BackupSection.13")}
			</div>

			{error ? <ErrorNote className="mt-3">{error}</ErrorNote> : null}
			{notice ? (
				<div className="mt-3 rounded-sm border border-bn-border bg-bn-surface/60 p-2.5 text-bn-sm text-bn-text-secondary">
					{notice.kind === "import"
						? summarizeImport(notice.result, notice.backupKind)
						: notice.backupKind === "full"
							? tx("panelUi.pages.backup.BackupSection.5")
							: tx("panelUi.pages.backup.BackupSection.6")}
				</div>
			) : null}

			<div className="mt-3.5 flex flex-wrap gap-2 border-t border-bn-border-subtle pt-3">
				<Btn variant="primary" disabled={busy} onClick={() => setDialog("export")}>
					{tx("panelUi.pages.backup.BackupSection.14")}
				</Btn>
				<Btn variant="outline" disabled={busy} onClick={() => setDialog("import")}>
					{tx("panelUi.pages.backup.BackupSection.15")}
				</Btn>
			</div>

			{dialog === "export" ? (
				<BackupExportDialog
					previewPaths={preview.data?.defaultedSettings ?? []}
					previewPending={preview.isPending || preview.isFetching}
					previewError={preview.error?.message}
					onRetryPreview={() => void preview.refetch()}
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
					title={tx("panelUi.pages.backup.BackupSection.16")}
					message={
						<>
							{tx("panelUi.pages.backup.BackupSection.17")}
							<span className="font-bold text-bn-danger-text">
								{deletions(pending.plan).join("、")}
							</span>
							{tx("panelUi.pages.backup.BackupSection.18")}
						</>
					}
					confirmLabel={tx("panelUi.pages.backup.BackupSection.19")}
					cancelLabel={tx("panelUi.pages.backup.BackupSection.20")}
					onConfirm={() => void apply(pending.req)}
					onCancel={() => setPending(null)}
				/>
			) : null}
		</GlassBox>
	);
}
