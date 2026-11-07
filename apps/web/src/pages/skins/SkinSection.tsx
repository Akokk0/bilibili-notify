import type {
	ResourceImportPreviewResponse,
	SkinListEntry,
	SkinManifest,
	SkinManifestResponse,
	SkinsListResponse,
} from "@bilibili-notify/contract";
import {
	AddFileButton,
	Btn,
	ConfirmDialog,
	ErrorNote,
	GlassBox,
	HintNote,
	Icon,
	LoadingBlock,
	ModalShell,
	Pill,
	WarnNote,
} from "@bilibili-notify/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Picker } from "../../components/forms";
import { ManageResourcesButton } from "../../components/library/manage-resources-button";
import { ResourceImportDialog } from "../../components/library/resource-import-dialog";
import { useResourceImport } from "../../components/library/use-resource-import";
import { useT } from "../../i18n";
import { api } from "../../services/api";
import { errorTextOf } from "../../services/error-text";
import { downloadResource } from "../../services/resource-download";
import { syncActiveSkinToStore } from "../../services/skin-active";
import { useSkinStore } from "../../store/skin";
import { SkinEditor } from "./SkinEditor";
import { MODE_LABEL } from "./skin-edit";

/** 上传响应(POST /api/dashboard/skins)。 */
interface UploadResult {
	ok: boolean;
	id: string;
	warnings: string[];
}

async function fetchManifest(id: string): Promise<SkinManifest> {
	const res = await api.get<SkinManifestResponse>(`/api/dashboard/skins/${id}/manifest`);
	return res.manifest;
}

/**
 * 皮肤库。列表操作(试穿/启用/删除)走服务端;试穿只写 store 的
 * preview(SkinRoot 负责真正注入),应用/取消由全局的 SkinPreviewBar 承接。
 */
function useDashboardSkins() {
	return useQuery({
		queryKey: ["dashboard", "skins"],
		queryFn: () => api.get<SkinsListResponse>("/api/dashboard/skins"),
	});
}

export function SkinSection({ mode = "select" }: { mode?: "select" | "manage" } = {}) {
	return mode === "select" ? <SkinSelection /> : <SkinManagement />;
}

function SkinManagement() {
	const tx = useT();

	const qc = useQueryClient();
	const [error, setError] = useState<string | null>(null);
	const [warnings, setWarnings] = useState<string[]>([]);
	/** 待确认删除的那套。带上 `modes` —— 双色皮肤要给「只删一色」的选项。 */
	const [confirmRemove, setConfirmRemove] = useState<{
		id: string;
		name: string;
		modes: Array<"light" | "dark">;
	} | null>(null);
	const [editing, setEditing] = useState<{
		id: string;
		manifest: SkinManifest;
		assets: string[];
		/** 生成名 → 主人上传时的原文件名,给抽屉里两个下拉当标签。 */
		assetNames: Record<string, string>;
	} | null>(null);

	const listQuery = useDashboardSkins();
	const activeIds = listQuery.data?.active ?? { light: null, dark: null };

	function refresh(): void {
		void qc.invalidateQueries({ queryKey: ["dashboard", "skins"] });
	}

	const remove = useMutation({
		mutationFn: (id: string) => api.delete<{ ok: boolean }>(`/api/dashboard/skins/${id}`),
		onSuccess: async () => {
			setError(null);
			await syncActiveSkinToStore();
			refresh();
		},
		onError: (e) => setError(String((e as Error).message)),
	});

	/**
	 * 只删一色。服务端会顺手把指着这一色的启用槽卸下来,所以这里同样要
	 * `syncActiveSkinToStore()` —— 不同步的话页面上还穿着一套已经没了的模式。
	 */
	const removeMode = useMutation({
		mutationFn: (req: { id: string; theme: "light" | "dark" }) =>
			api.delete<{ ok: boolean }>(`/api/dashboard/skins/${req.id}/modes/${req.theme}`),
		onSuccess: async () => {
			setError(null);
			await syncActiveSkinToStore();
			refresh();
		},
		onError: (e) => setError(String((e as Error).message)),
	});

	const importer = useResourceImport({
		previewFile: (file) => {
			const form = new FormData();
			form.set("file", file);
			return api.upload<ResourceImportPreviewResponse>("/api/dashboard/skins/import-preview", form);
		},
		importFile: (file) => {
			const form = new FormData();
			form.set("file", file);
			return api.upload<UploadResult>("/api/dashboard/skins", form);
		},
		onImported: (data) => {
			setError(null);
			setWarnings(data.warnings);
			refresh();
		},
	});
	const download = useMutation({
		mutationFn: (entry: SkinListEntry) =>
			downloadResource(`/api/dashboard/skins/${entry.id}/export`, `${entry.name}.zip`),
		onError: (e) => setError(errorTextOf(e)),
	});

	async function tryOn(id: string): Promise<void> {
		try {
			const manifest = await fetchManifest(id);
			useSkinStore.getState().setPreview({ id, manifest });
			setError(null);
		} catch (e) {
			setError(String((e as Error).message));
		}
	}

	/** 打开调整抽屉:拉 manifest + 包内资产清单(两个下拉的可选项)与它们的原名。 */
	async function openEditor(id: string): Promise<void> {
		try {
			const res = await api.get<SkinManifestResponse>(`/api/dashboard/skins/${id}/manifest`);
			setEditing({
				id,
				manifest: res.manifest,
				assets: res.assets ?? [],
				assetNames: res.assetNames ?? {},
			});
			setError(null);
		} catch (e) {
			setError(String((e as Error).message));
		}
	}

	const entries = listQuery.data?.list ?? [];

	return (
		<GlassBox
			title={tx("skinUi.SkinSection.1")}
			subtitle={tx("skinUi.SkinSection.2")}
			accent="var(--color-bn-purple)"
			icon={<Icon.palette size={14} />}
			badge={
				activeIds.light || activeIds.dark ? tx("skinUi.SkinSection.3") : tx("skinUi.SkinSection.4")
			}
			right={
				<AddFileButton
					accept=".zip,application/zip"
					uploading={importer.busy}
					onFile={(file) => {
						if (file) importer.pick(file);
					}}
					className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-bn-sm"
				>
					{tx("skinUi.SkinSection.6")}
				</AddFileButton>
			}
		>
			{importer.error && !importer.review ? <ErrorNote>{importer.error}</ErrorNote> : null}
			{importer.imported ? <HintNote>{tx("resourceImport.saved")}</HintNote> : null}
			{importer.review ? (
				<ResourceImportDialog
					file={importer.review.file}
					name={importer.review.preview.name}
					warnings={importer.review.preview.warnings}
					conflict={importer.review.preview.conflict}
					pending={importer.busy}
					error={importer.error}
					onCancel={importer.cancel}
					onConfirm={importer.confirm}
				/>
			) : null}
			{error ? (
				<ErrorNote className="mb-3">
					{tx("skinUi.SkinSection.8")}
					{error}
				</ErrorNote>
			) : null}
			{warnings.length > 0 ? (
				<WarnNote className="mb-3 leading-5">
					{warnings.map((w) => (
						<div key={w}>{w}</div>
					))}
				</WarnNote>
			) : null}

			{listQuery.isPending ? (
				<LoadingBlock label={tx("skinUi.CardSkinSection.15")} variant="inset" />
			) : null}
			{listQuery.isError ? (
				<ErrorNote>
					{tx("library.skinsReadFailed")}{" "}
					<Btn size="sm" onClick={() => void listQuery.refetch()}>
						{tx("library.retry")}
					</Btn>
				</ErrorNote>
			) : null}
			<div className="space-y-2">
				{(listQuery.isError ? [] : entries).map((entry) => {
					const usage = (["light", "dark"] as const).filter((t) => activeIds[t] === entry.id);
					return (
						<SkinRow
							key={entry.id}
							name={entry.name}
							desc={[entry.author ? `by ${entry.author}` : null, entry.description ?? null]
								.filter(Boolean)
								.join(" · ")}
							tags={
								<>
									{entry.modes.map((m) => (
										<Pill key={m} subtle color="var(--color-bn-blue)">
											{MODE_LABEL[m]}
										</Pill>
									))}
									{entry.hasWallpaper ? (
										<Pill subtle color="var(--color-bn-purple)">
											{tx("skinUi.SkinSection.12")}
										</Pill>
									) : null}
								</>
							}
							usage={usage}
							onTryOn={() => void tryOn(entry.id)}
							onEdit={() => void openEditor(entry.id)}
							onExport={() => download.mutate(entry)}
							onRemove={() =>
								setConfirmRemove({ id: entry.id, name: entry.name, modes: entry.modes })
							}
							busy={remove.isPending || removeMode.isPending}
						/>
					);
				})}
			</div>

			<p className="mt-3 text-bn-xs leading-5 text-bn-text-tertiary">
				{tx("skinUi.SkinSection.13")}{" "}
				<code className="rounded-sm bg-bn-code-bg px-1">?skin=off</code>{" "}
				{tx("skinUi.SkinSection.14")}
			</p>

			{confirmRemove ? (
				confirmRemove.modes.length > 1 ? (
					<RemoveSkinDialog
						name={confirmRemove.name}
						onPickMode={(theme) => {
							removeMode.mutate({ id: confirmRemove.id, theme });
							setConfirmRemove(null);
						}}
						onRemoveAll={() => {
							remove.mutate(confirmRemove.id);
							setConfirmRemove(null);
						}}
						onCancel={() => setConfirmRemove(null)}
					/>
				) : (
					// 只有一色时「只删这一色」就等于「删整套」,摆出来只会让人犹豫
					// 该点哪个 —— 那时照旧是一句「确定删除吗」。
					<ConfirmDialog
						title={tx("skinUi.SkinSection.15")}
						message={tx("skinUi.SkinSection.16", { value0: confirmRemove.name })}
						danger
						confirmLabel={tx("skinUi.SkinSection.17")}
						onConfirm={() => {
							remove.mutate(confirmRemove.id);
							setConfirmRemove(null);
						}}
						onCancel={() => setConfirmRemove(null)}
					/>
				)
			) : null}

			{editing ? (
				<SkinEditor
					id={editing.id}
					manifest={editing.manifest}
					assets={editing.assets}
					assetNames={editing.assetNames}
					onClose={() => setEditing(null)}
				/>
			) : null}
		</GlassBox>
	);
}

function SkinSelection() {
	const tx = useT(),
		qc = useQueryClient();
	const [error, setError] = useState<string | null>(null);
	const listQuery = useDashboardSkins();
	const activeIds = listQuery.data?.active ?? { light: null, dark: null };
	const entries = listQuery.data?.list ?? [];
	function refresh() {
		void qc.invalidateQueries({ queryKey: ["dashboard", "skins"] });
	}
	const activate = useMutation({
		// 深浅槽各自设置;id:null = 该槽回默认装。
		mutationFn: (req: { id: string | null; theme: "light" | "dark" }) =>
			api.put<{ ok: boolean }>("/api/dashboard/skins/active", req),
		onSuccess: async () => {
			setError(null);
			await syncActiveSkinToStore();
			useSkinStore.getState().setPreview(null);
			refresh();
		},
		onError: (e) => setError(String((e as Error).message)),
	});

	return (
		<GlassBox
			title={tx("skinUi.SkinSection.1")}
			subtitle={tx("library.dashboardSelectHint")}
			accent="var(--color-bn-purple)"
			icon={<Icon.palette size={14} />}
			right={<ManageResourcesButton category="dashboard-skins" />}
		>
			{error ? <ErrorNote>{error}</ErrorNote> : null}
			{listQuery.isPending ? (
				<LoadingBlock label={tx("skinUi.CardSkinSection.15")} variant="inset" />
			) : listQuery.isError ? (
				<ErrorNote>
					{tx("library.skinsReadFailed")}{" "}
					<Btn size="sm" onClick={() => void listQuery.refetch()}>
						{tx("library.retry")}
					</Btn>
				</ErrorNote>
			) : (
				<fieldset disabled={activate.isPending}>
					{/* 换装 Picker(分段按钮组):深浅色各自挑一套,只列具备该模式的皮肤;
			    点「默认装」即卸下该槽。 */}
					<div className="mb-3 space-y-2">
						{(["light", "dark"] as const).map((theme) => (
							<fieldset
								key={theme}
								aria-label={tx("skinUi.SkinSection.9", { value0: MODE_LABEL[theme] })}
								className="flex flex-wrap items-center gap-2"
							>
								<span className="w-14 shrink-0 text-bn-sm font-semibold text-bn-text-secondary">
									{MODE_LABEL[theme]}
									{tx("skinUi.SkinSection.10")}
								</span>
								<Picker
									value={activeIds[theme] ?? ""}
									onChange={(id) => {
										if (id === (activeIds[theme] ?? "")) return;
										activate.mutate({ theme, id: id === "" ? null : id });
									}}
									options={[
										{ value: "", label: tx("skinUi.SkinSection.11") },
										...entries
											.filter((entry) => entry.modes.includes(theme))
											.map((entry) => ({ value: entry.id, label: entry.name })),
									]}
								/>
							</fieldset>
						))}
					</div>
				</fieldset>
			)}
		</GlassBox>
	);
}

/**
 * 双色皮肤的删除对话框:删整套,还是只删其中一色。
 *
 * 不复用 `ConfirmDialog` —— 那是「确认 / 取消」两颗钮的原语,这里要三选一。
 * 两条排版上的取舍:**「只删一色」摆在上面、用 outline**,「删除整套」在下面、
 * 用 danger 红 —— 主人点开这个窗多半是冲着「留一色」来的(冲着删整套来的从前
 * 一路就有),破坏力最大的那颗不该是最顺手的那颗。
 */
function RemoveSkinDialog(props: {
	name: string;
	onPickMode: (theme: "light" | "dark") => void;
	onRemoveAll: () => void;
	onCancel: () => void;
}) {
	const tx = useT();

	return (
		<ModalShell
			onCancel={props.onCancel}
			width={340}
			bodyClassName="p-5"
			title={tx("skinUi.SkinSection.18")}
			description={tx("skinUi.SkinSection.19", { value0: props.name })}
		>
			<div className="flex flex-col gap-2">
				{(["light", "dark"] as const).map((theme) => (
					<Btn key={theme} variant="outline" size="sm" onClick={() => props.onPickMode(theme)}>
						{tx("skinUi.SkinSection.20")}
						{MODE_LABEL[theme]}
						{tx("skinUi.SkinSection.21")}
						{MODE_LABEL[theme === "light" ? "dark" : "light"]})
					</Btn>
				))}
				<Btn variant="danger" size="sm" onClick={props.onRemoveAll}>
					{tx("skinUi.SkinSection.22")}
				</Btn>
				<Btn variant="ghost" size="sm" onClick={props.onCancel}>
					{tx("skinUi.SkinSection.23")}
				</Btn>
			</div>
		</ModalShell>
	);
}

function SkinRow(props: {
	name: string;
	desc?: string;
	tags?: React.ReactNode;
	/** 正占用的槽位;「浅色·使用中」等徽标按此渲染。启用/卸下都走上方的 picker。 */
	usage: Array<"light" | "dark">;
	busy: boolean;
	onTryOn: () => void;
	onEdit: () => void;
	onExport: () => void;
	onRemove: () => void;
}) {
	const tx = useT();

	return (
		<div className="flex flex-col gap-3 rounded-bn-sm border border-bn-border-subtle bg-bn-surface-muted/60 px-3 py-2.5 sm:flex-row sm:items-center">
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-1.5">
					<span className="min-w-0 break-words text-bn-base font-semibold text-bn-text-primary">
						{props.name}
					</span>
					{props.tags}
					{props.usage.length > 0 ? (
						<Pill color="var(--color-bn-pink)">
							{props.usage.length === 2
								? tx("skinUi.SkinSection.24")
								: tx("skinUi.SkinSection.25", { value0: MODE_LABEL[props.usage[0]] })}
						</Pill>
					) : null}
				</div>
				{props.desc ? (
					<div className="mt-0.5 truncate text-bn-xs text-bn-text-secondary">{props.desc}</div>
				) : null}
			</div>
			<div className="flex shrink-0 flex-wrap items-center gap-1.5">
				<Btn size="sm" variant="ghost" onClick={props.onTryOn}>
					{tx("skinUi.SkinSection.26")}
				</Btn>
				<Btn size="sm" variant="ghost" onClick={props.onEdit}>
					{tx("skinUi.SkinSection.27")}
				</Btn>
				<Btn size="sm" variant="ghost" onClick={props.onExport}>
					{tx("skinUi.SkinSection.28")}
				</Btn>
				<Btn size="sm" variant="danger" onClick={props.onRemove} disabled={props.busy}>
					{tx("skinUi.SkinSection.29")}
				</Btn>
			</div>
		</div>
	);
}
