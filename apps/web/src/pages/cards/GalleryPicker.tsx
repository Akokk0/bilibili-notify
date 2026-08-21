/**
 * 背景图廊选择器 —— 多选已上传的背景图(选中顺序 = 每次推送的轮换顺序),支持上传与删盘。
 * 取代旧的单图 BackgroundImagePicker。`value` = cardStyle.backgroundImages:空 = 渐变,
 * 1 = 单张,>1 = 轮换。删被引用的图被服务端 409 拦截,这里把 referencedBy 提示出来。
 */

import { Icon } from "@bilibili-notify/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, api } from "../../services/api";
import { removeFromGallery, toggleSelected } from "./gallery-ops";
import { useAssetObjectUrl } from "./useAssetObjectUrl";

interface GalleryListResponse {
	ok: boolean;
	ids: string[];
}

/** 单张缩略图:点击切换选中(角标显示轮换序号),hover 出现删盘按钮。 */
function Thumb({
	id,
	order,
	onToggle,
	onDelete,
}: {
	id: string;
	/** 在轮换序列中的位置(0 基);null = 未选中。 */
	order: number | null;
	onToggle: () => void;
	onDelete: () => void;
}) {
	const url = useAssetObjectUrl(id);
	const selected = order !== null;
	return (
		<div
			className={`group relative aspect-[16/10] w-24 shrink-0 overflow-hidden rounded-lg border transition ${
				selected ? "border-bn-pink ring-1 ring-bn-pink/40" : "border-bn-border-subtle"
			}`}
		>
			<button
				type="button"
				onClick={onToggle}
				className="block h-full w-full"
				title="点击选用/取消"
			>
				{url ? (
					<img src={url} alt="背景图" className="h-full w-full object-cover" />
				) : (
					<span className="grid h-full w-full place-items-center bg-bn-surface-muted text-[10px] text-bn-text-tertiary">
						…
					</span>
				)}
			</button>
			{selected ? (
				<span className="absolute left-1 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-bn-pink px-1 text-[9px] font-bold text-white">
					{order + 1}
				</span>
			) : null}
			<button
				type="button"
				title="从图廊删除"
				aria-label="从图廊删除"
				onClick={onDelete}
				data-bn="btn"
				className="absolute right-1 top-1 hidden h-4 w-4 place-items-center rounded-bn-pill bg-black/55 text-white transition hover:bg-bn-danger-text group-hover:grid"
			>
				<Icon.close size={10} />
			</button>
		</div>
	);
}

export function GalleryPicker({
	value,
	onChange,
	onAssetDeleted,
	emptyHint,
	singleHint,
}: {
	value: string[];
	onChange: (next: string[]) => void;
	/**
	 * 删盘成功后的回调(在本 picker 自身 onChange 剔除之外)。Cards 页借它清扫页面上
	 * 其他仍引用该 id 的样式状态 —— 否则那些字段带着悬空 id 落盘成幽灵引用。
	 */
	onAssetDeleted?: (id: string) => void;
	/** 空选时的底部文案(缺省背景语义「未选择(用渐变背景)」;封面上下文应传封面语义)。 */
	emptyHint?: string;
	/** 单张选中时的底部文案(缺省「单张固定背景」)。 */
	singleHint?: string;
}) {
	const qc = useQueryClient();
	const [uploading, setUploading] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const gallery = useQuery({
		queryKey: ["card-assets"],
		queryFn: () => api.get<GalleryListResponse>("/api/cards/assets"),
	});
	const ids = gallery.data?.ids ?? [];

	const onFile = async (file: File | undefined) => {
		if (!file) return;
		setErr(null);
		setUploading(true);
		try {
			const form = new FormData();
			form.append("file", file);
			const res = await api.upload<{ ok: boolean; id?: string; err?: string }>(
				"/api/cards/asset",
				form,
			);
			if (!res.ok || !res.id) throw new Error(res.err ?? "上传失败");
			await qc.invalidateQueries({ queryKey: ["card-assets"] });
			if (!value.includes(res.id)) onChange([...value, res.id]); // 新传的默认选入
		} catch (e) {
			setErr((e as Error).message);
		} finally {
			setUploading(false);
		}
	};

	const onDelete = async (id: string) => {
		setErr(null);
		try {
			await api.delete(`/api/cards/asset/${id}`);
			onChange(removeFromGallery(value, id));
			// 通知页面清扫其他仍引用该 id 的样式状态(必须在删盘成功后、409 拦截不触发)。
			onAssetDeleted?.(id);
			await qc.invalidateQueries({ queryKey: ["card-assets"] });
		} catch (e) {
			if (e instanceof ApiError && e.status === 409) {
				const by = (e.body as { referencedBy?: string[] } | undefined)?.referencedBy ?? [];
				setErr(`仍被使用,无法删除：${by.join("、")}`);
			} else {
				setErr((e as Error).message);
			}
		}
	};

	// 选中但已不在图廊里的 id(文件被删的悬空引用)。渲染成可见的「已失效」占位块 ——
	// 隐形会让它悄悄占住轮换位(角标/张数对不上、渲染回退渐变),且没有任何入口能取消选中。
	// 图廊列表未加载完(data 缺省)时不判失效,避免加载闪烁误标。
	const ghosts = gallery.data ? value.filter((id) => !ids.includes(id)) : [];

	return (
		<div className="flex flex-col gap-2">
			<div className="flex flex-wrap gap-2">
				{ids.map((id) => {
					const idx = value.indexOf(id);
					return (
						<Thumb
							key={id}
							id={id}
							order={idx === -1 ? null : idx}
							onToggle={() => onChange(toggleSelected(value, id))}
							onDelete={() => onDelete(id)}
						/>
					);
				})}
				{ghosts.map((id) => (
					<div
						key={id}
						data-testid="gallery-ghost"
						title="引用的图片文件已被删除,点 × 从选择中移除"
						className="relative grid aspect-[16/10] w-24 shrink-0 place-items-center overflow-hidden rounded-lg border border-dashed border-bn-danger-text/50 bg-bn-surface-muted"
					>
						<span className="absolute left-1 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-bn-danger-text px-1 text-[9px] font-bold text-white">
							{value.indexOf(id) + 1}
						</span>
						<span className="text-[10px] text-bn-danger-text">已失效</span>
						<button
							type="button"
							title="移除失效引用"
							aria-label="移除失效引用"
							onClick={() => onChange(removeFromGallery(value, id))}
							data-bn="btn"
							className="absolute right-1 top-1 grid h-4 w-4 place-items-center rounded-bn-pill bg-black/55 text-white transition hover:bg-bn-danger-text"
						>
							<Icon.close size={10} />
						</button>
					</div>
				))}
				<label className="grid aspect-[16/10] w-24 shrink-0 cursor-pointer place-items-center rounded-lg border border-dashed border-bn-border text-[11px] text-bn-text-tertiary transition hover:border-bn-pink hover:text-bn-pink">
					{uploading ? (
						"上传中…"
					) : (
						<span className="flex flex-col items-center gap-0.5">
							<Icon.plus size={16} />
							<span>上传</span>
						</span>
					)}
					<input
						type="file"
						accept="image/png,image/jpeg,image/webp"
						className="hidden"
						disabled={uploading}
						onChange={(e) => onFile(e.target.files?.[0])}
					/>
				</label>
			</div>
			<div className="flex items-center justify-between text-[11px]">
				<span className="text-bn-text-tertiary">
					{value.length === 0
						? (emptyHint ?? "未选择(用渐变背景)")
						: value.length === 1
							? (singleHint ?? "单张固定背景")
							: `${value.length} 张 · 每次推送顺序轮换`}
				</span>
				{err ? <span className="text-right text-bn-danger-text">{err}</span> : null}
			</div>
		</div>
	);
}
