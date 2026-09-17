import type {
	SkinListEntry,
	SkinManifest,
	SkinManifestResponse,
	SkinsListResponse,
} from "@bilibili-notify/contract";
import {
	Btn,
	ConfirmDialog,
	ErrorNote,
	GlassBox,
	Icon,
	ModalShell,
	Pill,
	WarnNote,
} from "@bilibili-notify/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ChangeEvent, useRef, useState } from "react";
import { Picker } from "../../components/forms";
import { api } from "../../services/api";
import { syncActiveSkinToStore } from "../../services/skin-active";
import { useSkinStore } from "../../store/skin";
import { SkinEditor } from "./SkinEditor";
import { MODE_LABEL } from "./skin-edit";

/** 上传响应(POST /api/skins)。 */
interface UploadResult {
	ok: boolean;
	id: string;
	warnings: string[];
}

async function fetchManifest(id: string): Promise<SkinManifest> {
	const res = await api.get<SkinManifestResponse>(`/api/skins/${id}/manifest`);
	return res.manifest;
}

/**
 * 皮肤库。列表操作(试穿/启用/删除)走服务端;试穿只写 store 的
 * preview(SkinRoot 负责真正注入),应用/取消由全局的 SkinPreviewBar 承接。
 */
export function SkinSection() {
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
	const uploadInputRef = useRef<HTMLInputElement | null>(null);

	const listQuery = useQuery({
		queryKey: ["skins"],
		queryFn: () => api.get<SkinsListResponse>("/api/skins"),
	});
	const activeIds = listQuery.data?.active ?? { light: null, dark: null };

	function refresh(): void {
		void qc.invalidateQueries({ queryKey: ["skins"] });
	}

	const activate = useMutation({
		// 深浅槽各自设置;id:null = 该槽回默认装。
		mutationFn: (req: { id: string | null; theme: "light" | "dark" }) =>
			api.put<{ ok: boolean }>("/api/skins/active", req),
		onSuccess: async () => {
			setError(null);
			await syncActiveSkinToStore();
			useSkinStore.getState().setPreview(null);
			refresh();
		},
		onError: (e) => setError(String((e as Error).message)),
	});

	const remove = useMutation({
		mutationFn: (id: string) => api.delete<{ ok: boolean }>(`/api/skins/${id}`),
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
			api.delete<{ ok: boolean }>(`/api/skins/${req.id}/modes/${req.theme}`),
		onSuccess: async () => {
			setError(null);
			await syncActiveSkinToStore();
			refresh();
		},
		onError: (e) => setError(String((e as Error).message)),
	});

	const upload = useMutation({
		mutationFn: (file: File) => {
			const form = new FormData();
			form.set("file", file);
			return api.upload<UploadResult>("/api/skins", form);
		},
		onSuccess: async (data) => {
			setError(null);
			setWarnings(data.warnings);
			refresh();
			// 传完直接试穿:所见即所得,喜欢再点「应用」。
			const manifest = await fetchManifest(data.id);
			useSkinStore.getState().setPreview({ id: data.id, manifest });
		},
		onError: (e) => setError(String((e as Error).message)),
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
			const res = await api.get<SkinManifestResponse>(`/api/skins/${id}/manifest`);
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

	function onUploadPick(e: ChangeEvent<HTMLInputElement>): void {
		const file = e.target.files?.[0];
		e.target.value = "";
		if (file) upload.mutate(file);
	}

	const entries = listQuery.data?.list ?? [];

	return (
		<GlassBox
			title="界面皮肤 · skins"
			subtitle="给面板换装 —— 上传皮肤包,或到女仆聊天侧栏点「新建皮肤工坊」让她做一套"
			accent="var(--color-bn-purple)"
			icon={<Icon.palette size={14} />}
			badge={activeIds.light || activeIds.dark ? "已换装" : "原生外观"}
			right={
				<div className="flex items-center gap-2">
					<Btn
						size="sm"
						onClick={() => uploadInputRef.current?.click()}
						disabled={upload.isPending}
					>
						{upload.isPending ? "上传中…" : "上传皮肤包"}
					</Btn>
					<input
						ref={uploadInputRef}
						type="file"
						accept=".zip,application/zip"
						className="hidden"
						onChange={onUploadPick}
						aria-label="选择皮肤包 zip 文件"
					/>
				</div>
			}
		>
			{error ? <ErrorNote className="mb-3">操作失败:{error}</ErrorNote> : null}
			{warnings.length > 0 ? (
				<WarnNote className="mb-3 leading-5">
					{warnings.map((w) => (
						<div key={w}>{w}</div>
					))}
				</WarnNote>
			) : null}

			{/* 换装 Picker(分段按钮组):深浅色各自挑一套,只列具备该模式的皮肤;
			    点「默认装」即卸下该槽。 */}
			<div className="mb-3 space-y-2">
				{(["light", "dark"] as const).map((theme) => (
					<fieldset
						key={theme}
						aria-label={`${MODE_LABEL[theme]}模式皮肤`}
						className="flex flex-wrap items-center gap-2"
					>
						<span className="w-14 shrink-0 text-bn-sm font-semibold text-bn-text-secondary">
							{MODE_LABEL[theme]}模式
						</span>
						<Picker
							value={activeIds[theme] ?? ""}
							onChange={(id) => {
								if (id === (activeIds[theme] ?? "")) return;
								activate.mutate({ theme, id: id === "" ? null : id });
							}}
							options={[
								{ value: "", label: "默认装" },
								...entries
									.filter((entry) => entry.modes.includes(theme))
									.map((entry) => ({ value: entry.id, label: entry.name })),
							]}
						/>
					</fieldset>
				))}
			</div>

			<div className="space-y-2">
				{entries.map((entry) => {
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
											壁纸
										</Pill>
									) : null}
								</>
							}
							usage={usage}
							onTryOn={() => void tryOn(entry.id)}
							onEdit={() => void openEditor(entry.id)}
							onExport={() => downloadSkin(entry)}
							onRemove={() =>
								setConfirmRemove({ id: entry.id, name: entry.name, modes: entry.modes })
							}
							busy={remove.isPending || removeMode.isPending}
						/>
					);
				})}
			</div>

			<p className="mt-3 text-bn-xs leading-5 text-bn-text-tertiary">
				万一皮肤把界面弄得看不清:在地址栏加上{" "}
				<code className="rounded-sm bg-bn-code-bg px-1">?skin=off</code>{" "}
				访问,本次会话会强制默认装,再回这里恢复默认即可。
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
						title="删除皮肤"
						message={`确定删除「${confirmRemove.name}」吗?删除后不可恢复。`}
						danger
						confirmLabel="删除"
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

/** 皮肤导出:直接开导出端点,浏览器按 content-disposition 落文件(会话 cookie 同源自带)。 */
function downloadSkin(entry: SkinListEntry): void {
	const a = document.createElement("a");
	a.href = `/api/skins/${entry.id}/export`;
	a.download = `${entry.name}.zip`;
	a.click();
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
	return (
		<ModalShell
			onCancel={props.onCancel}
			width={340}
			bodyClassName="p-5"
			title="删除皮肤"
			description={`「${props.name}」有浅色和深色两套。要删哪一部分?删除后不可恢复。`}
		>
			<div className="flex flex-col gap-2">
				{(["light", "dark"] as const).map((theme) => (
					<Btn key={theme} variant="outline" size="sm" onClick={() => props.onPickMode(theme)}>
						只删{MODE_LABEL[theme]}(留下{MODE_LABEL[theme === "light" ? "dark" : "light"]})
					</Btn>
				))}
				<Btn variant="danger" size="sm" onClick={props.onRemoveAll}>
					删除整套
				</Btn>
				<Btn variant="ghost" size="sm" onClick={props.onCancel}>
					取消
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
	return (
		<div className="flex items-center gap-3 rounded-bn-sm border border-bn-border-subtle bg-bn-surface-muted/60 px-3 py-2.5">
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-1.5">
					<span className="text-bn-base font-semibold text-bn-text-primary">{props.name}</span>
					{props.tags}
					{props.usage.length > 0 ? (
						<Pill color="var(--color-bn-pink)">
							{props.usage.length === 2 ? "使用中" : `${MODE_LABEL[props.usage[0]]}·使用中`}
						</Pill>
					) : null}
				</div>
				{props.desc ? (
					<div className="mt-0.5 truncate text-bn-xs text-bn-text-secondary">{props.desc}</div>
				) : null}
			</div>
			<div className="flex shrink-0 items-center gap-1.5">
				<Btn size="sm" variant="ghost" onClick={props.onTryOn}>
					试穿
				</Btn>
				<Btn size="sm" variant="ghost" onClick={props.onEdit}>
					调整
				</Btn>
				<Btn size="sm" variant="ghost" onClick={props.onExport}>
					导出
				</Btn>
				<Btn size="sm" variant="danger" onClick={props.onRemove} disabled={props.busy}>
					删除
				</Btn>
			</div>
		</div>
	);
}
