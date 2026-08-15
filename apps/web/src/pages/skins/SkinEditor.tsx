import {
	SKIN_DECORATION_ANCHORS,
	type SkinDecoration,
	type SkinManifest,
	type SkinManifestUpdateResponse,
	type SkinMode,
} from "@bilibili-notify/contract";
import { Btn, ConfirmDialog, DrawerShell, ErrorNote } from "@bilibili-notify/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { api } from "../../services/api";
import { useSkinStore } from "../../store/skin";
import {
	addMissingMode,
	COLOR_GROUPS,
	cleanSection,
	fontsToText,
	missingModeOf,
	setManifestText,
	setModeSection,
	textToFonts,
	toHex6,
} from "./skin-edit";

/**
 * 皮肤调整抽屉:manifest 的每个语义字段都给了控件,改一下整页立即生效 ——
 * 借 store 的 preview 通道(与试穿同一条注入路径),editing 标记压住试穿浮条。
 * 「保存」PUT /api/skins/:id/manifest 就地落盘(资产不动);「取消」丢弃。
 */

const ANCHOR_LABEL: Record<(typeof SKIN_DECORATION_ANCHORS)[number], string> = {
	"top-left": "左上",
	top: "上",
	"top-right": "右上",
	left: "左",
	center: "中",
	right: "右",
	"bottom-left": "左下",
	bottom: "下",
	"bottom-right": "右下",
};

const inputCls =
	"w-full rounded-lg border border-bn-border bg-bn-field px-2 py-1 text-[12px] text-bn-text-primary outline-none focus:border-bn-pink";

export function SkinEditor(props: {
	id: string;
	manifest: SkinManifest;
	/** 包内资产清单(assets/<名>),图片字段的全部可选项 —— 换图走重新上传组包。 */
	assets: string[];
	onClose: () => void;
}) {
	const { id, manifest, assets, onClose } = props;
	const qc = useQueryClient();
	const [draft, setDraft] = useState<SkinManifest>(manifest);
	const [modeKey, setModeKey] = useState<"light" | "dark">(manifest.modes.light ? "light" : "dark");
	const [confirmDiscard, setConfirmDiscard] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const dirty = draft !== manifest;

	// 挂载即接管:试穿浮条让位;卸载时归还通道并清预览(未保存的改动随之还原)。
	useEffect(() => {
		useSkinStore.getState().setEditing(true);
		return () => {
			useSkinStore.getState().setEditing(false);
			useSkinStore.getState().setPreview(null);
		};
	}, []);

	// 实时预览:draft 每变一次就走一遍与试穿完全相同的合成注入路径。
	useEffect(() => {
		useSkinStore.getState().setPreview({ id, manifest: draft });
	}, [id, draft]);

	const save = useMutation({
		// 要发的东西必须走 variables(react-query 回调时序下闭包靠不住)。
		mutationFn: (m: SkinManifest) =>
			api.put<SkinManifestUpdateResponse>(`/api/skins/${id}/manifest`, m),
		onSuccess: (_res, m) => {
			const st = useSkinStore.getState();
			if (st.active?.id === id) st.setActive({ id, manifest: m });
			void qc.invalidateQueries({ queryKey: ["skins"] });
			setError(null);
			onClose();
		},
		onError: (e) => setError(String((e as Error).message)),
	});

	function requestClose(): void {
		if (dirty) setConfirmDiscard(true);
		else onClose();
	}

	const mode: SkinMode = draft.modes[modeKey] ?? {};
	function setSection<K extends keyof SkinMode>(section: K, value: SkinMode[K] | undefined): void {
		setDraft((d) => setModeSection(d, modeKey, section, value));
	}

	const wp = mode.wallpaper ?? {};
	const glass = mode.glass ?? {};
	const colors = mode.colors ?? {};
	const radius = mode.radius ?? {};
	const shadows = mode.shadows ?? {};
	const decorations = mode.decorations ?? [];
	// const 绑定让 TS 在 JSX 三元分支里完成收窄,省掉一串非空断言。
	const banner = mode.banner;
	const missing = missingModeOf(draft);

	function setDecorations(next: SkinDecoration[]): void {
		setSection("decorations", next.length > 0 ? next : undefined);
	}
	function patchDecoration(i: number, patch: Partial<SkinDecoration>): void {
		setDecorations(decorations.map((d, j) => (j === i ? { ...d, ...patch } : d)));
	}

	return (
		<DrawerShell onClose={requestClose} width={420} ariaLabel="皮肤调整">
			<div className="flex items-center justify-between gap-2 border-b border-bn-border-subtle px-4 py-3">
				<div>
					<div className="text-[14px] font-bold">调整皮肤</div>
					<div className="text-[11px] text-bn-text-secondary">
						每一项改动整页立即生效;保存前只是预览
					</div>
				</div>
			</div>

			<div className="flex-1 space-y-3 px-4 py-3">
				{/* 模式选择与补套 */}
				<div className="flex flex-wrap items-center gap-1.5">
					{(["light", "dark"] as const)
						.filter((k) => draft.modes[k])
						.map((k) => (
							<button
								key={k}
								type="button"
								onClick={() => setModeKey(k)}
								className={`rounded-bn-pill px-3 py-1 text-[12px] font-semibold transition ${
									modeKey === k
										? "bg-bn-pink text-white"
										: "border border-bn-border text-bn-text-secondary hover:text-bn-text-primary"
								}`}
							>
								{k === "light" ? "浅色" : "深色"}
							</button>
						))}
					{missing ? (
						<Btn size="sm" variant="outline" onClick={() => setDraft(addMissingMode(draft))}>
							补一套{missing === "dark" ? "深色" : "浅色"}
						</Btn>
					) : null}
				</div>
				<p className="text-[11px] leading-4 text-bn-text-tertiary">
					页面正在显示哪套由右上角明暗开关决定;只有一套的皮肤会锁定该模式。
				</p>

				<Fold title="基本信息与文案" defaultOpen>
					<TextField
						label="皮肤名"
						value={draft.name}
						onChange={(v) => setDraft({ ...draft, name: v })}
					/>
					<TextField
						label="作者"
						value={draft.author ?? ""}
						onChange={(v) => setDraft(withOptional(draft, "author", v))}
					/>
					<TextField
						label="描述"
						value={draft.description ?? ""}
						onChange={(v) => setDraft(withOptional(draft, "description", v))}
					/>
					<TextField
						label="顶栏标题"
						value={draft.texts?.headerTitle ?? ""}
						placeholder="默认「bilibili-notify」"
						onChange={(v) => setDraft(setManifestText(draft, "headerTitle", v))}
					/>
					<TextField
						label="聊天提示语"
						value={draft.texts?.chatPlaceholder ?? ""}
						placeholder="聊天输入框的占位文案"
						onChange={(v) => setDraft(setManifestText(draft, "chatPlaceholder", v))}
					/>
				</Fold>

				<Fold title="背景与壁纸" defaultOpen>
					<FieldRow label="页面背景">
						<textarea
							aria-label="页面背景"
							value={mode.page?.background ?? ""}
							onChange={(e) =>
								setSection("page", e.target.value ? { background: e.target.value } : undefined)
							}
							placeholder="纯色或渐变;留空回默认(有壁纸时被壁纸盖住)"
							rows={2}
							className={`${inputCls} resize-y font-mono text-[11px]`}
						/>
					</FieldRow>
					<SelectField
						label="壁纸图片"
						value={wp.image ?? ""}
						onChange={(v) =>
							v === ""
								? setSection("wallpaper", undefined)
								: setSection("wallpaper", { ...wp, image: v })
						}
						options={[
							{ value: "", label: "(不用壁纸)" },
							...assets.map((a) => ({ value: a, label: a })),
						]}
					/>
					{wp.image ? (
						<>
							<SelectField
								label="壁纸铺法"
								value={wp.fit ?? ""}
								onChange={(v) =>
									setSection(
										"wallpaper",
										cleanWallpaper({ ...wp, fit: (v || undefined) as typeof wp.fit }),
									)
								}
								options={[
									{ value: "", label: "默认(cover 铺满)" },
									{ value: "cover", label: "cover 铺满" },
									{ value: "contain", label: "contain 完整显示" },
									{ value: "tile", label: "tile 平铺" },
								]}
							/>
							<TextField
								label="壁纸位置"
								value={wp.position ?? ""}
								placeholder="默认 center;如 center top"
								onChange={(v) => setSection("wallpaper", cleanWallpaper({ ...wp, position: v }))}
							/>
							<RangeField
								label="壁纸遮罩"
								min={0}
								max={0.8}
								step={0.05}
								value={wp.overlay}
								fallback={0}
								onChange={(v) => setSection("wallpaper", cleanWallpaper({ ...wp, overlay: v }))}
							/>
						</>
					) : null}
				</Fold>

				<Fold title="玻璃面板" defaultOpen>
					<ColorField
						label="玻璃底色"
						value={glass.background}
						onChange={(v) => setSection("glass", cleanSection({ ...glass, background: v }))}
					/>
					<ColorField
						label="玻璃描边"
						value={glass.border}
						onChange={(v) => setSection("glass", cleanSection({ ...glass, border: v }))}
					/>
					<ColorField
						label="强玻璃底色"
						value={glass.strongBackground}
						onChange={(v) => setSection("glass", cleanSection({ ...glass, strongBackground: v }))}
					/>
					<ColorField
						label="强玻璃描边"
						value={glass.strongBorder}
						onChange={(v) => setSection("glass", cleanSection({ ...glass, strongBorder: v }))}
					/>
					<RangeField
						label="玻璃模糊"
						min={0}
						max={40}
						step={1}
						unit="px"
						value={glass.blur}
						fallback={16}
						onChange={(v) => setSection("glass", cleanSection({ ...glass, blur: v }))}
					/>
					<RangeField
						label="强玻璃模糊"
						min={0}
						max={40}
						step={1}
						unit="px"
						value={glass.strongBlur}
						fallback={20}
						onChange={(v) => setSection("glass", cleanSection({ ...glass, strongBlur: v }))}
					/>
				</Fold>

				<Fold title="语义颜色">
					{COLOR_GROUPS.map((group) => (
						<div key={group.label} className="space-y-1.5">
							<div className="pt-1 text-[11px] font-semibold text-bn-text-tertiary">
								{group.label}
							</div>
							{group.keys.map(({ key, label }) => (
								<ColorField
									key={key}
									label={label}
									value={colors[key]}
									onChange={(v) => setSection("colors", cleanSection({ ...colors, [key]: v }))}
								/>
							))}
						</div>
					))}
				</Fold>

				<Fold title="圆角与阴影">
					<RangeField
						label="卡片圆角"
						min={0}
						max={32}
						step={1}
						unit="px"
						value={radius.card}
						fallback={14}
						onChange={(v) => setSection("radius", cleanSection({ ...radius, card: v }))}
					/>
					<NumberField
						label="胶囊圆角"
						value={radius.pill}
						placeholder="默认;0~999 px"
						min={0}
						max={999}
						onChange={(v) => setSection("radius", cleanSection({ ...radius, pill: v }))}
					/>
					<TextField
						label="卡片阴影"
						mono
						value={shadows.card ?? ""}
						placeholder="如 0 10px 30px rgba(57,197,187,0.25)"
						onChange={(v) => setSection("shadows", cleanSection({ ...shadows, card: v }))}
					/>
					<TextField
						label="悬浮阴影"
						mono
						value={shadows.elev ?? ""}
						placeholder="悬停/浮层那一档"
						onChange={(v) => setSection("shadows", cleanSection({ ...shadows, elev: v }))}
					/>
				</Fold>

				<Fold title="字体">
					<TextField
						label="正文字体栈"
						value={fontsToText(mode.fonts?.body)}
						placeholder="逗号分隔,如 LXGW WenKai, sans-serif"
						onChange={(v) => {
							const body = textToFonts(v);
							setSection("fonts", body ? { body } : undefined);
						}}
					/>
				</Fold>

				<Fold title="装饰贴纸">
					{decorations.map((d, i) => (
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: 列表按位编辑,无稳定 id
							key={i}
							className="space-y-1.5 rounded-[10px] border border-bn-border-subtle p-2"
						>
							<div className="flex items-center justify-between">
								<span className="text-[11px] font-semibold text-bn-text-tertiary">
									贴纸 {i + 1}
								</span>
								<Btn
									size="sm"
									variant="danger"
									onClick={() => setDecorations(decorations.filter((_, j) => j !== i))}
								>
									删除
								</Btn>
							</div>
							<SelectField
								label={`贴纸${i + 1}图片`}
								value={d.image}
								onChange={(v) => patchDecoration(i, { image: v })}
								options={assets.map((a) => ({ value: a, label: a }))}
							/>
							<SelectField
								label={`贴纸${i + 1}锚点`}
								value={d.anchor}
								onChange={(v) => patchDecoration(i, { anchor: v as SkinDecoration["anchor"] })}
								options={SKIN_DECORATION_ANCHORS.map((a) => ({
									value: a,
									label: ANCHOR_LABEL[a],
								}))}
							/>
							<RangeField
								label={`贴纸${i + 1}宽度`}
								min={20}
								max={600}
								step={5}
								unit="px"
								value={d.width}
								fallback={200}
								clearable={false}
								onChange={(v) => patchDecoration(i, { width: v ?? 200 })}
							/>
							<RangeField
								label={`贴纸${i + 1}透明度`}
								min={0}
								max={1}
								step={0.05}
								value={d.opacity}
								fallback={1}
								clearable={false}
								onChange={(v) => patchDecoration(i, { opacity: v ?? 1 })}
							/>
							<NumberField
								label="横向偏移"
								value={d.offsetX}
								placeholder="-400~400 px"
								min={-400}
								max={400}
								onChange={(v) => patchDecoration(i, { offsetX: v })}
							/>
							<NumberField
								label="纵向偏移"
								value={d.offsetY}
								placeholder="-400~400 px"
								min={-400}
								max={400}
								onChange={(v) => patchDecoration(i, { offsetY: v })}
							/>
						</div>
					))}
					<Btn
						size="sm"
						variant="outline"
						disabled={assets.length === 0 || decorations.length >= 6}
						onClick={() =>
							setDecorations([
								...decorations,
								{ image: assets[0], anchor: "bottom-right", width: 200, opacity: 1 },
							])
						}
					>
						添加贴纸
					</Btn>
					{assets.length === 0 ? (
						<p className="text-[11px] text-bn-text-tertiary">包里没有图片资产,加图要重新组包上传</p>
					) : null}
				</Fold>

				<Fold title="自定义 CSS">
					<p className="text-[11px] leading-4 text-bn-text-tertiary">
						选择器只准 <code className="rounded bg-bn-code-bg px-1">[data-bn="挂点"]</code>
						(挂点见制作引导),属性走视觉白名单;违禁项保存时会被逐条丢弃并提示。
					</p>
					<FieldRow label="共用 CSS">
						<textarea
							aria-label="共用 CSS"
							value={draft.css ?? ""}
							onChange={(e) => setDraft(withOptionalCss(draft, e.target.value))}
							placeholder='如 [data-bn="glass"]:hover { box-shadow: 0 0 24px rgba(251,114,153,0.4); }'
							rows={6}
							className={`${inputCls} resize-y font-mono text-[11px]`}
						/>
					</FieldRow>
					<FieldRow label="本模式 CSS">
						<textarea
							aria-label="本模式 CSS"
							value={mode.css ?? ""}
							onChange={(e) => setSection("css", e.target.value || undefined)}
							placeholder="只在当前明/暗套生效,叠在共用 CSS 之后"
							rows={4}
							className={`${inputCls} resize-y font-mono text-[11px]`}
						/>
					</FieldRow>
				</Fold>

				<Fold title="顶部横幅">
					{banner ? (
						<>
							<SelectField
								label="横幅图片"
								value={banner.image}
								onChange={(v) => setSection("banner", { ...banner, image: v })}
								options={assets.map((a) => ({ value: a, label: a }))}
							/>
							<RangeField
								label="横幅高度"
								min={80}
								max={400}
								step={10}
								unit="px"
								value={banner.height}
								fallback={160}
								clearable={false}
								onChange={(v) => setSection("banner", { ...banner, height: v ?? 160 })}
							/>
							<SelectField
								label="横幅铺法"
								value={banner.fit ?? "cover"}
								onChange={(v) => setSection("banner", { ...banner, fit: v as "cover" | "contain" })}
								options={[
									{ value: "cover", label: "cover 铺满" },
									{ value: "contain", label: "contain 完整显示" },
								]}
							/>
							<TextField
								label="横幅位置"
								value={banner.position ?? ""}
								placeholder="默认 center;如 center top"
								onChange={(v) => {
									const { position: _drop, ...rest } = banner;
									setSection("banner", v ? { ...rest, position: v } : rest);
								}}
							/>
							<Btn size="sm" variant="danger" onClick={() => setSection("banner", undefined)}>
								移除横幅
							</Btn>
						</>
					) : (
						<Btn
							size="sm"
							variant="outline"
							disabled={assets.length === 0}
							onClick={() => setSection("banner", { image: assets[0], height: 160 })}
						>
							启用横幅
						</Btn>
					)}
				</Fold>
			</div>

			<div className="sticky bottom-0 space-y-2 border-t border-bn-border-subtle bg-bn-surface-strong/80 px-4 py-3 backdrop-blur-sm">
				{error ? <ErrorNote>保存失败:{error}</ErrorNote> : null}
				<div className="flex justify-end gap-2">
					<Btn variant="outline" onClick={requestClose} disabled={save.isPending}>
						取消
					</Btn>
					<Btn
						onClick={() => save.mutate(draft)}
						disabled={save.isPending || draft.name.trim().length === 0}
					>
						{save.isPending ? "保存中…" : "保存"}
					</Btn>
				</div>
			</div>

			{confirmDiscard ? (
				<ConfirmDialog
					title="丢弃修改"
					message="调整还没保存,关闭后界面会回到原样。确定丢弃吗?"
					danger
					confirmLabel="丢弃"
					onConfirm={() => {
						setConfirmDiscard(false);
						onClose();
					}}
					onCancel={() => setConfirmDiscard(false)}
				/>
			) : null}
		</DrawerShell>
	);
}

/** manifest 顶层可选字符串字段:空串即删除。 */
function withOptional(m: SkinManifest, key: "author" | "description", value: string): SkinManifest {
	const next = { ...m };
	if (value === "") delete next[key];
	else next[key] = value;
	return next;
}

/** 顶层共用 CSS:空串即删除(与 withOptional 同律,类型上分开写)。 */
function withOptionalCss(m: SkinManifest, value: string): SkinManifest {
	const next = { ...m };
	if (value === "") delete next.css;
	else next.css = value;
	return next;
}

/** wallpaper 的 clean:image 在(调用方保证)时其余空字段照删。 */
function cleanWallpaper(wp: NonNullable<SkinMode["wallpaper"]>): SkinMode["wallpaper"] {
	return cleanSection({ ...wp });
}

// ---- 局部小控件 -----------------------------------------------------------

function Fold(props: { title: string; defaultOpen?: boolean; children: ReactNode }) {
	const [open, setOpen] = useState(props.defaultOpen ?? false);
	return (
		<div className="rounded-[10px] border border-bn-border-subtle">
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				className="flex w-full items-center justify-between px-3 py-2 text-[12.5px] font-semibold text-bn-text-primary"
			>
				<span>{props.title}</span>
				<span className="text-bn-text-tertiary">{open ? "−" : "+"}</span>
			</button>
			{open ? <div className="space-y-2 px-3 pb-3">{props.children}</div> : null}
		</div>
	);
}

function FieldRow(props: { label: string; children: ReactNode }) {
	return (
		<div className="flex items-center gap-2 text-[12px] text-bn-text-secondary">
			<span className="w-20 shrink-0">{props.label}</span>
			<div className="min-w-0 flex-1">{props.children}</div>
		</div>
	);
}

function TextField(props: {
	label: string;
	value: string;
	onChange: (v: string) => void;
	placeholder?: string;
	mono?: boolean;
}) {
	return (
		<FieldRow label={props.label}>
			<input
				aria-label={props.label}
				value={props.value}
				onChange={(e) => props.onChange(e.target.value)}
				placeholder={props.placeholder}
				className={`${inputCls}${props.mono ? " font-mono text-[11px]" : ""}`}
			/>
		</FieldRow>
	);
}

function NumberField(props: {
	label: string;
	value: number | undefined;
	onChange: (v: number | undefined) => void;
	placeholder?: string;
	min?: number;
	max?: number;
}) {
	return (
		<FieldRow label={props.label}>
			<input
				aria-label={props.label}
				type="number"
				value={props.value ?? ""}
				min={props.min}
				max={props.max}
				onChange={(e) => {
					const n = Number(e.target.value);
					props.onChange(e.target.value === "" || Number.isNaN(n) ? undefined : n);
				}}
				placeholder={props.placeholder}
				className={inputCls}
			/>
		</FieldRow>
	);
}

function RangeField(props: {
	label: string;
	min: number;
	max: number;
	step: number;
	value: number | undefined;
	/** 未设置时滑杆停在的参考位(只影响滑杆起点,不写进 draft)。 */
	fallback: number;
	unit?: string;
	/** false = 该字段必填(贴纸宽度等),不给「清除回默认」。 */
	clearable?: boolean;
	onChange: (v: number | undefined) => void;
}) {
	const clearable = props.clearable ?? true;
	return (
		<FieldRow label={props.label}>
			<div className="flex items-center gap-2">
				<input
					aria-label={props.label}
					type="range"
					min={props.min}
					max={props.max}
					step={props.step}
					value={props.value ?? props.fallback}
					onChange={(e) => props.onChange(Number(e.target.value))}
					className="min-w-0 flex-1 accent-bn-pink"
				/>
				<span className="w-13 shrink-0 text-right text-[11px] tabular-nums text-bn-text-tertiary">
					{props.value !== undefined ? `${props.value}${props.unit ?? ""}` : "默认"}
				</span>
				{clearable && props.value !== undefined ? (
					<button
						type="button"
						aria-label={`清除${props.label}`}
						onClick={() => props.onChange(undefined)}
						className="shrink-0 text-[12px] text-bn-text-tertiary hover:text-bn-text-primary"
					>
						×
					</button>
				) : null}
			</div>
		</FieldRow>
	);
}

function SelectField(props: {
	label: string;
	value: string;
	onChange: (v: string) => void;
	options: Array<{ value: string; label: string }>;
}) {
	return (
		<FieldRow label={props.label}>
			<select
				aria-label={props.label}
				value={props.value}
				onChange={(e) => props.onChange(e.target.value)}
				className={inputCls}
			>
				{props.options.map((o) => (
					<option key={o.value} value={o.value}>
						{o.label}
					</option>
				))}
			</select>
		</FieldRow>
	);
}

function ColorField(props: {
	label: string;
	value: string | undefined;
	onChange: (v: string) => void;
}) {
	const hex = toHex6(props.value ?? "");
	return (
		<FieldRow label={props.label}>
			<div className="flex items-center gap-1.5">
				<input
					aria-label={`${props.label}取色`}
					type="color"
					value={hex ?? "#ffffff"}
					onChange={(e) => props.onChange(e.target.value)}
					className="h-6 w-7 shrink-0 cursor-pointer rounded border border-bn-border bg-transparent p-0"
				/>
				<input
					aria-label={props.label}
					value={props.value ?? ""}
					onChange={(e) => props.onChange(e.target.value)}
					placeholder="默认"
					className={`${inputCls} font-mono text-[11px]`}
				/>
			</div>
		</FieldRow>
	);
}
