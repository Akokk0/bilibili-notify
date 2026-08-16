import type {
	SkinAiEditResponse,
	SkinDefaultResponse,
	SkinEffects,
	SkinManifest,
	SkinManifestUpdateResponse,
	SkinMode,
} from "@bilibili-notify/contract";
import { Btn, ConfirmDialog, DrawerShell, ErrorNote, Toggle } from "@bilibili-notify/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { api } from "../../services/api";
import { useSkinStore } from "../../store/skin";
import {
	addMissingMode,
	COLOR_GROUPS,
	cleanSection,
	colorAlphaOf,
	fontsToText,
	missingModeOf,
	setManifestText,
	setModeSection,
	textToFonts,
	toHex6,
	withColorAlpha,
} from "./skin-edit";

/**
 * 皮肤调整抽屉:manifest 的每个语义字段都给了控件,改一下整页立即生效 ——
 * 借 store 的 preview 通道(与试穿同一条注入路径),editing 标记压住试穿浮条。
 * 「保存」PUT /api/skins/:id/manifest 就地落盘(资产不动);「取消」丢弃。
 *
 * **编辑器 = 能力全集(硬性原则,主人拍板)**:contract 的 SkinManifest/SkinMode
 * 有的字段,这里必须有编辑口;给 schema 加字段时同步加控件,砍能力时同步撤。
 */

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
	/** 默认值操作的成功反馈(出错走 error;两者互斥)。 */
	const [note, setNote] = useState<string | null>(null);
	const [aiInstruction, setAiInstruction] = useState("");
	const [aiWarnings, setAiWarnings] = useState<string[]>([]);
	// 光斑颜色框存原始文本(受控地 join 回去会吃掉正在输入的逗号),draft 只收解析产物;
	// 换模式/AI 整份替换 draft 时手动回灌。
	const [bokehText, setBokehText] = useState(() =>
		(manifest.modes[manifest.modes.light ? "light" : "dark"]?.effects?.bokeh?.colors ?? []).join(
			", ",
		),
	);
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
			// 正被哪个槽启用就同步哪个槽的 manifest,编辑保存立即生效
			if (st.active.light?.id === id || st.active.dark?.id === id) {
				st.setActive({
					light: st.active.light?.id === id ? { id, manifest: m } : st.active.light,
					dark: st.active.dark?.id === id ? { id, manifest: m } : st.active.dark,
				});
			}
			void qc.invalidateQueries({ queryKey: ["skins"] });
			setError(null);
			onClose();
		},
		onError: (e) => setError(String((e as Error).message)),
	});

	// 「让女仆改」:AI 产物只进 draft(实时预览),不落盘 —— 保存永远主人点。
	// 要发的东西必须走 variables(react-query 回调时序下闭包靠不住)。
	const aiEdit = useMutation({
		mutationFn: (vars: { instruction: string; draft: SkinManifest }) =>
			api.post<SkinAiEditResponse>(`/api/skins/${id}/ai-edit`, vars),
		onSuccess: (res) => {
			if (!res.ok) return; // 4xx/5xx 走 onError;这里只剩 ok 形状
			setDraft(res.manifest);
			setBokehText((res.manifest.modes[modeKey]?.effects?.bokeh?.colors ?? []).join(", "));
			setAiWarnings(res.warnings);
			setAiInstruction("");
			setError(null);
		},
		onError: (e) => setError(String((e as Error).message)),
	});

	// 「设为默认值」:把**已保存**的当前 manifest 钉成出厂快照 —— 有未保存改动时
	// 禁用(先保存),免得钉进去的和眼前预览对不上。
	const setDefault = useMutation({
		mutationFn: () => api.put(`/api/skins/${id}/default`),
		onSuccess: () => {
			setError(null);
			setNote("已把当前状态钉为这个皮肤包的默认值");
		},
		onError: (e) => {
			setNote(null);
			setError(String((e as Error).message));
		},
	});

	// 「恢复默认值」:快照只拉回 draft 实时预览(与「让女仆改」同构),落盘仍走保存。
	const restoreDefault = useMutation({
		mutationFn: () => api.get<SkinDefaultResponse>(`/api/skins/${id}/default`),
		onSuccess: (res) => {
			setDraft(res.manifest);
			// 快照可能没有当前正在编辑的那套模式,跟着切到它有的那套
			const nextKey = res.manifest.modes[modeKey]
				? modeKey
				: res.manifest.modes.light
					? "light"
					: "dark";
			setModeKey(nextKey);
			setBokehText((res.manifest.modes[nextKey]?.effects?.bokeh?.colors ?? []).join(", "));
			setError(null);
			setNote("已拉回默认值预览,满意就点保存落盘");
		},
		onError: (e) => {
			setNote(null);
			setError(String((e as Error).message));
		},
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
	// 「完全透明」没有独立字段,从数据推断:透明度与模糊都归零即是 —— 与推送卡片/
	// AI 聊天那边「完全透明就是这些值一起归零」的哲学同构。
	const glassClear = colorAlphaOf(glass.background) === 0 && glass.blur === 0;
	/** 透明度滑杆的兜底色相 = 默认装当前模式的玻璃色相。 */
	const glassBaseRgb = modeKey === "dark" ? "30, 41, 59" : "255, 255, 255";
	const colors = mode.colors ?? {};
	const radius = mode.radius ?? {};
	const shadows = mode.shadows ?? {};
	const effects = mode.effects ?? {};
	const missing = missingModeOf(draft);

	/** 动效字段:patch 值为 undefined 即删该道;全关后 effects 整个消失。 */
	function setEffects(patch: Partial<SkinEffects>): void {
		setSection("effects", cleanSection({ ...effects, ...patch }));
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

			<div className="space-y-1.5 border-b border-bn-border-subtle px-4 py-3">
				<textarea
					aria-label="修改要求"
					value={aiInstruction}
					onChange={(e) => setAiInstruction(e.target.value)}
					placeholder="用一句话让女仆改,如「整体换成赛博朋克风,卡片加霓虹流光」"
					rows={2}
					className={`${inputCls} resize-y`}
				/>
				<div className="flex items-start justify-between gap-2">
					{aiWarnings.length > 0 ? (
						<span className="min-w-0 flex-1 text-[11px] leading-4 text-bn-warning">
							{aiWarnings.join(";")}
						</span>
					) : (
						<span className="text-[11px] text-bn-text-tertiary">改完直接上身预览,不满意再改</span>
					)}
					<Btn
						size="sm"
						disabled={aiEdit.isPending || aiInstruction.trim() === ""}
						onClick={() => aiEdit.mutate({ instruction: aiInstruction.trim(), draft })}
					>
						{aiEdit.isPending ? "女仆修改中…" : "让女仆改"}
					</Btn>
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
								onClick={() => {
									setModeKey(k);
									setBokehText((draft.modes[k]?.effects?.bokeh?.colors ?? []).join(", "));
								}}
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
							<RangeField
								label="壁纸模糊"
								min={0}
								max={40}
								step={1}
								value={wp.blur}
								fallback={0}
								onChange={(v) => setSection("wallpaper", cleanWallpaper({ ...wp, blur: v }))}
							/>
						</>
					) : null}
				</Fold>

				<Fold title="玻璃面板" defaultOpen>
					{/* 与推送卡片/AI 聊天同名同义的一对(玻璃片透明度 + 完全透明):
					    完全透明 = 透明度与模糊一起归零(那边的哲学),关闭清字段回默认装。 */}
					<RangeField
						label="玻璃片透明度"
						min={0}
						max={1}
						step={0.05}
						value={colorAlphaOf(glass.background) ?? undefined}
						fallback={0.7}
						clearable={false}
						disabled={glassClear}
						onChange={(v) =>
							setSection(
								"glass",
								cleanSection({
									...glass,
									background: withColorAlpha(glass.background, v ?? 0.7, glassBaseRgb),
								}),
							)
						}
					/>
					<FieldRow label="完全透明">
						<Toggle
							value={glassClear}
							onChange={(b) =>
								setSection(
									"glass",
									cleanSection(
										b
											? {
													...glass,
													background: withColorAlpha(glass.background, 0, glassBaseRgb),
													blur: 0,
												}
											: { ...glass, background: undefined, blur: undefined },
									),
								)
							}
							ariaLabel="完全透明(去磨砂模糊)"
							size="sm"
						/>
					</FieldRow>
					{/* 编辑器 = 能力全集(主人定的原则):透明度对是便利入口,下面是
					    玻璃的全部字段 —— schema 有的这里都要有编辑口。 */}
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

				<Fold title="动效">
					<FieldRow label="玻璃流光">
						<Toggle
							value={Boolean(effects.glassShine)}
							onChange={(b) => setEffects({ glassShine: b ? {} : undefined })}
							ariaLabel="玻璃流光"
							size="sm"
						/>
					</FieldRow>
					{effects.glassShine ? (
						<ColorField
							label="流光颜色"
							value={effects.glassShine.color}
							onChange={(v) => setEffects({ glassShine: v === "" ? {} : { color: v } })}
						/>
					) : null}
					<TextField
						label="光斑颜色"
						mono
						value={bokehText}
						placeholder="逗号分隔 1~4 个颜色,留空关闭"
						onChange={(v) => {
							setBokehText(v);
							const colors = v
								.split(",")
								.map((s) => s.trim())
								.filter(Boolean)
								.slice(0, 4);
							setEffects({ bokeh: colors.length > 0 ? { colors } : undefined });
						}}
					/>
					<p className="text-[11px] leading-4 text-bn-text-tertiary">
						所有动效自动尊重系统「减少动态效果」设置。
					</p>
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
			</div>

			<div className="sticky bottom-0 space-y-2 border-t border-bn-border-subtle bg-bn-surface-strong/80 px-4 py-3 backdrop-blur-sm">
				{error ? <ErrorNote>操作失败:{error}</ErrorNote> : null}
				{note ? <p className="text-[11px] text-bn-success-text">{note}</p> : null}
				<div className="flex items-center justify-between gap-2">
					<div className="flex gap-2">
						<Btn
							size="sm"
							variant="outline"
							onClick={() => setDefault.mutate()}
							disabled={dirty || setDefault.isPending}
							title={dirty ? "有未保存的改动,先保存再钉默认值" : "把当前状态钉为这个皮肤包的默认值"}
						>
							设为默认值
						</Btn>
						<Btn
							size="sm"
							variant="outline"
							onClick={() => restoreDefault.mutate()}
							disabled={restoreDefault.isPending}
							title="把出厂快照拉回来预览,保存后才落盘"
						>
							恢复默认值
						</Btn>
					</div>
					<div className="flex gap-2">
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
	/** false = 该字段必填,不给「清除回默认」。 */
	clearable?: boolean;
	/** 禁用而不是藏起来(完全透明开着时的透明度滑杆)—— 与 AI 聊天那边同款处理。 */
	disabled?: boolean;
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
					disabled={props.disabled}
					onChange={(e) => props.onChange(Number(e.target.value))}
					className="min-w-0 flex-1 accent-bn-pink disabled:opacity-40"
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
