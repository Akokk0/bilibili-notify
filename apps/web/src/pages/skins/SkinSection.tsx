import type { SkinManifest, SkinsListResponse } from "@bilibili-notify/contract";
import {
	Btn,
	ConfirmDialog,
	ErrorNote,
	GlassBox,
	Icon,
	ModalShell,
	Pill,
} from "@bilibili-notify/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ChangeEvent, useRef, useState } from "react";
import { api } from "../../services/api";
import { buildSkinPrompt, makeSkinZip } from "../../services/skin-pack";
import { useSkinStore } from "../../store/skin";

const MODE_LABEL: Record<"light" | "dark", string> = { light: "浅色", dark: "深色" };

/** 上传响应(POST /api/skins)。 */
interface UploadResult {
	ok: boolean;
	id: string;
	warnings: string[];
}

async function fetchManifest(id: string): Promise<SkinManifest> {
	const res = await api.get<{ manifest: SkinManifest }>(`/api/skins/${id}/manifest`);
	return res.manifest;
}

/**
 * 皮肤库 + 制作引导。列表操作(试穿/启用/删除)走服务端;试穿只写 store 的
 * preview(SkinRoot 负责真正注入),应用/取消由全局的 SkinPreviewBar 承接。
 */
export function SkinSection() {
	const qc = useQueryClient();
	const [error, setError] = useState<string | null>(null);
	const [warnings, setWarnings] = useState<string[]>([]);
	const [confirmRemove, setConfirmRemove] = useState<{ id: string; name: string } | null>(null);
	const [guideOpen, setGuideOpen] = useState(false);
	const uploadInputRef = useRef<HTMLInputElement | null>(null);

	const listQuery = useQuery({
		queryKey: ["skins"],
		queryFn: () => api.get<SkinsListResponse>("/api/skins"),
	});
	const activeId = listQuery.data?.activeId ?? null;

	function refresh(): void {
		void qc.invalidateQueries({ queryKey: ["skins"] });
	}

	/** 启用/恢复默认后,把 store 的 active 同步到服务端新状态(SkinRoot 即时换装)。 */
	async function syncActiveToStore(id: string | null): Promise<void> {
		if (id === null) {
			useSkinStore.getState().setActive(null);
			return;
		}
		const manifest = await fetchManifest(id);
		useSkinStore.getState().setActive({ id, manifest });
	}

	const activate = useMutation({
		mutationFn: (id: string | null) => api.put<{ ok: boolean }>("/api/skins/active", { id }),
		onSuccess: async (_data, id) => {
			setError(null);
			await syncActiveToStore(id);
			useSkinStore.getState().setPreview(null);
			refresh();
		},
		onError: (e) => setError(String((e as Error).message)),
	});

	const remove = useMutation({
		mutationFn: (id: string) => api.delete<{ ok: boolean }>(`/api/skins/${id}`),
		onSuccess: async (_data, id) => {
			setError(null);
			if (useSkinStore.getState().active?.id === id) {
				useSkinStore.getState().setActive(null);
			}
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

	function onUploadPick(e: ChangeEvent<HTMLInputElement>): void {
		const file = e.target.files?.[0];
		e.target.value = "";
		if (file) upload.mutate(file);
	}

	const entries = listQuery.data?.list ?? [];

	return (
		<GlassBox
			title="界面皮肤 · skins"
			subtitle="给面板换装 —— 上传皮肤包,或让任意 AI 帮你做一套"
			accent="#a29bfe"
			icon={<Icon.palette size={14} />}
			badge={activeId ? "已换装" : "原生外观"}
			right={
				<div className="flex items-center gap-2">
					<Btn size="sm" variant="outline" onClick={() => setGuideOpen(true)}>
						制作皮肤
					</Btn>
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
				<div className="mb-3 rounded-lg border border-bn-warning/40 bg-bn-warning/10 px-3 py-2 text-[11.5px] leading-5 text-bn-warning">
					{warnings.map((w) => (
						<div key={w}>{w}</div>
					))}
				</div>
			) : null}

			<div className="space-y-2">
				<SkinRow
					name="默认装"
					desc="bilibili-notify 的原生粉蓝玻璃装"
					current={activeId === null}
					onActivate={() => activate.mutate(null)}
					busy={activate.isPending}
				/>
				{entries.map((entry) => (
					<SkinRow
						key={entry.id}
						name={entry.name}
						desc={[entry.author ? `by ${entry.author}` : null, entry.description ?? null]
							.filter(Boolean)
							.join(" · ")}
						tags={
							<>
								{entry.modes.map((m) => (
									<Pill key={m} subtle color="#00aeec">
										{MODE_LABEL[m]}
									</Pill>
								))}
								{entry.hasWallpaper ? (
									<Pill subtle color="#a29bfe">
										壁纸
									</Pill>
								) : null}
							</>
						}
						current={activeId === entry.id}
						onTryOn={() => void tryOn(entry.id)}
						onActivate={() => activate.mutate(entry.id)}
						onRemove={() => setConfirmRemove({ id: entry.id, name: entry.name })}
						busy={activate.isPending || remove.isPending}
					/>
				))}
			</div>

			<p className="mt-3 text-[11px] leading-5 text-bn-text-tertiary">
				万一皮肤把界面弄得看不清:在地址栏加上{" "}
				<code className="rounded bg-bn-code-bg px-1">?skin=off</code>{" "}
				访问,本次会话会强制默认装,再回这里恢复默认即可。
			</p>

			{confirmRemove ? (
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
			) : null}

			{guideOpen ? <SkinGuideModal onClose={() => setGuideOpen(false)} /> : null}
		</GlassBox>
	);
}

function SkinRow(props: {
	name: string;
	desc?: string;
	tags?: React.ReactNode;
	current: boolean;
	busy: boolean;
	onActivate: () => void;
	onTryOn?: () => void;
	onRemove?: () => void;
}) {
	return (
		<div className="flex items-center gap-3 rounded-[10px] border border-bn-border-subtle bg-bn-surface-muted/60 px-3 py-2.5">
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-1.5">
					<span className="text-[13px] font-semibold text-bn-text-primary">{props.name}</span>
					{props.tags}
					{props.current ? <Pill color="#fb7299">使用中</Pill> : null}
				</div>
				{props.desc ? (
					<div className="mt-0.5 truncate text-[11px] text-bn-text-secondary">{props.desc}</div>
				) : null}
			</div>
			<div className="flex shrink-0 items-center gap-1.5">
				{props.onTryOn ? (
					<Btn size="sm" variant="ghost" onClick={props.onTryOn}>
						试穿
					</Btn>
				) : null}
				{!props.current ? (
					<Btn size="sm" variant="outline" onClick={props.onActivate} disabled={props.busy}>
						启用
					</Btn>
				) : null}
				{props.onRemove ? (
					<Btn size="sm" variant="danger" onClick={props.onRemove} disabled={props.busy}>
						删除
					</Btn>
				) : null}
			</div>
		</div>
	);
}

/** 制作引导:复制提示词 → 粘给任意 AI → 粘回 JSON(+可选壁纸)→ 前端组包上传。 */
function SkinGuideModal({ onClose }: { onClose: () => void }) {
	const qc = useQueryClient();
	const [json, setJson] = useState("");
	const [wallpaper, setWallpaper] = useState<File | null>(null);
	const [copied, setCopied] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [warnings, setWarnings] = useState<string[]>([]);

	async function copyPrompt(): Promise<void> {
		const readVar = (name: string) =>
			getComputedStyle(document.documentElement).getPropertyValue(name);
		await navigator.clipboard.writeText(buildSkinPrompt(readVar));
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	}

	const submit = useMutation({
		mutationFn: async (input: { json: string; wallpaper: File | null }) => {
			let wp: { ext: string; data: Uint8Array } | undefined;
			if (input.wallpaper) {
				const ext = input.wallpaper.name.split(".").pop()?.toLowerCase() ?? "";
				if (!["webp", "jpg", "jpeg", "png"].includes(ext)) {
					throw new Error("壁纸只支持 webp / jpg / png");
				}
				wp = { ext, data: new Uint8Array(await input.wallpaper.arrayBuffer()) };
			}
			const packed = makeSkinZip(input.json, wp);
			if (!packed.ok) throw new Error(packed.error);
			const form = new FormData();
			form.set(
				"file",
				new File([packed.zip.slice().buffer as ArrayBuffer], "skin.zip", {
					type: "application/zip",
				}),
			);
			const res = await api.upload<UploadResult>("/api/skins", form);
			return { res, packWarnings: packed.warnings };
		},
		onSuccess: async ({ res, packWarnings }) => {
			setWarnings([...packWarnings, ...res.warnings]);
			setError(null);
			void qc.invalidateQueries({ queryKey: ["skins"] });
			const manifest = await fetchManifest(res.id);
			useSkinStore.getState().setPreview({ id: res.id, manifest });
			onClose();
		},
		onError: (e) => setError(String((e as Error).message)),
	});

	return (
		<ModalShell onCancel={onClose} width={520}>
			<div className="space-y-3 text-[12.5px] leading-6 text-bn-text-primary">
				<div className="text-[15px] font-bold">制作皮肤</div>
				<ol className="list-decimal space-y-1 pl-5">
					<li>点「复制提示词」,粘给任意 AI(ChatGPT / Claude / 豆包都行)</li>
					<li>把 AI 回复的 JSON 原样粘到下面的框里</li>
					<li>想要壁纸就再选一张图,最后点「打包上传」—— 传完自动试穿</li>
				</ol>
				<div>
					<Btn size="sm" variant="outline" onClick={() => void copyPrompt()}>
						{copied ? "已复制 ✓" : "复制提示词"}
					</Btn>
				</div>
				<textarea
					value={json}
					onChange={(e) => setJson(e.target.value)}
					placeholder='把 AI 给的 skin.json 粘到这里,形如 {"schemaVersion":1,...}'
					className="h-40 w-full resize-y rounded-lg border border-bn-border bg-bn-field p-2.5 font-mono text-[11.5px] text-bn-text-primary outline-none focus:border-bn-pink"
				/>
				<label className="flex items-center gap-2 text-[12px] text-bn-text-secondary">
					<span className="shrink-0">壁纸(可选):</span>
					<input
						type="file"
						accept=".webp,.jpg,.jpeg,.png,image/webp,image/jpeg,image/png"
						onChange={(e) => setWallpaper(e.target.files?.[0] ?? null)}
					/>
				</label>
				{error ? <ErrorNote>打包上传失败:{error}</ErrorNote> : null}
				{warnings.length > 0 ? (
					<div className="text-[11.5px] text-bn-warning">{warnings.join(";")}</div>
				) : null}
				<div className="flex justify-end gap-2">
					<Btn variant="outline" onClick={onClose}>
						取消
					</Btn>
					<Btn
						onClick={() => submit.mutate({ json, wallpaper })}
						disabled={submit.isPending || json.trim().length === 0}
					>
						{submit.isPending ? "上传中…" : "打包上传"}
					</Btn>
				</div>
			</div>
		</ModalShell>
	);
}
