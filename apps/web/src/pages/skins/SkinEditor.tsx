import type {
	SkinAiEditResponse,
	SkinDefaultResponse,
	SkinEffects,
	SkinManifest,
	SkinManifestUpdateResponse,
	SkinMode,
} from "@bilibili-notify/contract";
import { Btn, ConfirmDialog, DrawerShell, ErrorNote, Toggle } from "@bilibili-notify/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { Picker } from "../../components/forms";
import { api } from "../../services/api";
import { useSkinStore } from "../../store/skin";
import {
	addMissingMode,
	COLOR_GROUPS,
	cleanSection,
	colorAlphaOf,
	fontsToText,
	MODE_LABEL,
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
	/** 包内资产 —— props 是打开那一刻的快照,传了新图就在这儿接着长。 */
	const [assetList, setAssetList] = useState<string[]>(assets);
	const [uploading, setUploading] = useState(false);
	/**
	 * 光斑颜色框里主人正在敲的原文;null = 没在敲,显示值从 draft 派生。
	 *
	 * 不能全程受控地 join 回去 —— 那会吃掉正在输入的逗号。但也别存成一份独立的
	 * 文本 state:那样每一条「整份替换 draft」的路径(AI 改完、恢复默认、切模式)
	 * 都得记得回灌一次,漏一次就是输入框里还挂着上一套皮肤的颜色。派生 + 一句
	 * `setBokehRaw(null)` 就够。
	 */
	const [bokehRaw, setBokehRaw] = useState<string | null>(null);
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
			setBokehRaw(null);
			setAiWarnings(res.warnings);
			setAiInstruction("");
			setError(null);
		},
		onError: (e) => setError(String((e as Error).message)),
	});

	// 出厂快照:挂载拉一次,既喂「恢复默认值」(点击零请求),也喂字段旁的
	// 「(默认)」标注。404(没钉过)走 error → 恢复按钮禁用、全部不标注。
	const snapshot = useQuery({
		queryKey: ["skins", id, "default"],
		queryFn: () => api.get<SkinDefaultResponse>(`/api/skins/${id}/default`),
		retry: false,
	});
	const defaultManifest = snapshot.data?.manifest ?? null;

	// 「设为默认值」:把**已保存**的当前 manifest 钉成出厂快照 —— 有未保存改动时
	// 禁用(先保存),免得钉进去的和眼前预览对不上。
	const setDefault = useMutation({
		mutationFn: () => api.put(`/api/skins/${id}/default`),
		onSuccess: () => {
			// 快照变了,重拉喂给「(默认)」标注与恢复按钮
			void qc.invalidateQueries({ queryKey: ["skins", id, "default"] });
			setError(null);
			setNote("已把当前状态钉为这个皮肤包的默认值");
		},
		onError: (e) => {
			setNote(null);
			setError(String((e as Error).message));
		},
	});

	// 「恢复默认值」:快照只回填 draft 实时预览(与「让女仆改」同构),落盘仍走保存。
	function restoreDefault(): void {
		if (!defaultManifest) return;
		setDraft(defaultManifest);
		// 快照可能没有当前正在编辑的那套模式,跟着切到它有的那套
		const nextKey = defaultManifest.modes[modeKey]
			? modeKey
			: defaultManifest.modes.light
				? "light"
				: "dark";
		setModeKey(nextKey);
		setBokehRaw(null);
		setError(null);
		setNote("已拉回默认值预览,满意就点保存落盘");
	}

	function requestClose(): void {
		if (dirty) setConfirmDiscard(true);
		else onClose();
	}

	/**
	 * 传一张图进这套皮肤。**立刻落盘**(POST /assets),不等主人点保存 ——
	 * 资产与 manifest 是两套东西:manifest 能整份丢弃回滚,盘上的图不能。让传图
	 * 跟着「保存」走,取消一次就得把图重传一次。
	 *
	 * 传完当场选成壁纸:会来传图的人正是想换壁纸,再点一次下拉是多余的一步。
	 */
	async function uploadAsset(file: File): Promise<void> {
		setUploading(true);
		setError(null);
		try {
			const form = new FormData();
			form.set("file", file);
			const res = await api.upload<{ name: string }>(`/api/skins/${id}/assets`, form);
			setAssetList((prev) => (prev.includes(res.name) ? prev : [...prev, res.name]));
			setSection("wallpaper", { ...(draft.modes[modeKey]?.wallpaper ?? {}), image: res.name });
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setUploading(false);
		}
	}

	const mode: SkinMode = draft.modes[modeKey] ?? {};
	const bokehText = bokehRaw ?? (mode.effects?.bokeh?.colors ?? []).join(", ");
	function setSection<K extends keyof SkinMode>(section: K, value: SkinMode[K] | undefined): void {
		setDraft((d) => setModeSection(d, modeKey, section, value));
	}

	// 「(默认)」标注的比较基准:出厂快照里同一套模式的对应字段。
	const dm: SkinMode = defaultManifest?.modes[modeKey] ?? {};
	/**
	 * 当前值与出厂快照一致(且确实配了值)→ 值旁标「(默认)」。空串与 undefined
	 * 视为同一种「没配」,没配的不标 —— 那是回落原版的占位「默认」,别撞概念。
	 */
	function isDef(cur: string | number | undefined, def: string | number | undefined): boolean {
		if (defaultManifest === null) return false;
		const c = cur === "" ? undefined : cur;
		const d = def === "" ? undefined : def;
		return c !== undefined && c === d;
	}

	const wp = mode.wallpaper ?? {};
	const glass = mode.glass ?? {};
	// 「完全透明」没有独立字段,从数据推断:透明度与模糊都归零即是 —— 与推送卡片
	// 那边「完全透明就是这些值一起归零」的哲学同构。
	const glassClear = colorAlphaOf(glass.background) === 0 && glass.blur === 0;
	/** 透明度滑杆的兜底色相 = 默认装当前模式的玻璃色相。 */
	const glassBaseRgb = modeKey === "dark" ? "30, 41, 59" : "255, 255, 255";
	const colors = mode.colors ?? {};
	const chat = mode.chat ?? {};
	const chatWp = chat.wallpaper ?? {};
	const radius = mode.radius ?? {};
	const shadows = mode.shadows ?? {};
	const effects = mode.effects ?? {};
	const missing = missingModeOf(draft);

	/** 动效字段:patch 值为 undefined 即删该道;全关后 effects 整个消失。 */
	function setEffects(patch: Partial<SkinEffects>): void {
		setSection("effects", cleanSection({ ...effects, ...patch }));
	}

	/** chat 段:同 setEffects 律 —— 空值键即删,整段空了字段消失。 */
	function setChat(patch: Partial<NonNullable<SkinMode["chat"]>>): void {
		setSection("chat", cleanSection({ ...chat, ...patch }));
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
					{/* 与皮肤库那边的深浅切换是同一个概念,用同一个控件 —— 各画一套的话
					    两处长得不一样,而且少了 Picker 自带的 aria-pressed。 */}
					<Picker
						value={modeKey}
						onChange={(k) => {
							setModeKey(k);
							setBokehRaw(null);
						}}
						options={(["light", "dark"] as const)
							.filter((k) => draft.modes[k])
							.map((k) => ({ value: k, label: MODE_LABEL[k] }))}
					/>
					{missing ? (
						<Btn size="sm" variant="outline" onClick={() => setDraft(addMissingMode(draft))}>
							补一套{MODE_LABEL[missing]}
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
						isDefault={isDef(draft.name, defaultManifest?.name)}
						onChange={(v) => setDraft({ ...draft, name: v })}
					/>
					<TextField
						label="作者"
						value={draft.author ?? ""}
						isDefault={isDef(draft.author, defaultManifest?.author)}
						onChange={(v) => setDraft(withOptional(draft, "author", v))}
					/>
					<TextField
						label="描述"
						value={draft.description ?? ""}
						isDefault={isDef(draft.description, defaultManifest?.description)}
						onChange={(v) => setDraft(withOptional(draft, "description", v))}
					/>
					<TextField
						label="顶栏标题"
						value={draft.texts?.headerTitle ?? ""}
						placeholder="默认「bilibili-notify」"
						isDefault={isDef(draft.texts?.headerTitle, defaultManifest?.texts?.headerTitle)}
						onChange={(v) => setDraft(setManifestText(draft, "headerTitle", v))}
					/>
					<TextField
						label="聊天提示语"
						value={draft.texts?.chatPlaceholder ?? ""}
						placeholder="聊天输入框的占位文案"
						isDefault={isDef(draft.texts?.chatPlaceholder, defaultManifest?.texts?.chatPlaceholder)}
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
					<WallpaperFields
						imageLabel="壁纸图片"
						prefix="壁纸"
						wp={wp}
						def={dm.wallpaper}
						assets={assetList}
						isDef={isDef}
						onChange={(next) => setSection("wallpaper", next)}
						afterImage={
							<FieldRow label="上传图片">
								<div className="flex items-center gap-2">
									<input
										aria-label="上传图片"
										type="file"
										accept="image/png,image/jpeg,image/webp"
										disabled={uploading}
										onChange={(e) => {
											const file = e.target.files?.[0];
											// 输入框清空:同一张图连传两次时 change 不会再触发。
											e.target.value = "";
											if (file) uploadAsset(file);
										}}
										className="w-full text-[11px] text-bn-text-secondary file:mr-2 file:rounded-md file:border-0 file:bg-bn-surface-muted file:px-2 file:py-1 file:text-[11px] file:text-bn-text-primary"
									/>
									{uploading ? (
										<span className="shrink-0 text-[11px] text-bn-text-secondary">上传中…</span>
									) : null}
								</div>
							</FieldRow>
						}
					/>
				</Fold>

				<Fold title="玻璃面板" defaultOpen>
					{/* 与推送卡片同名同义的一对(玻璃片透明度 + 完全透明):完全透明 =
					    透明度与模糊一起归零(那边的哲学),关闭清字段回默认装。这里也是
					    AI 聊天玻璃的唯一调节入口 —— 聊天玻璃族直接吃 --bn-glass-* token。 */}
					<RangeField
						label="玻璃片透明度"
						min={0}
						max={1}
						step={0.05}
						value={colorAlphaOf(glass.background) ?? undefined}
						fallback={modeKey === "dark" ? 0.72 : 0.7}
						clearable={false}
						disabled={glassClear}
						isDefault={isDef(
							colorAlphaOf(glass.background) ?? undefined,
							colorAlphaOf(dm.glass?.background) ?? undefined,
						)}
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
						isDefault={isDef(glass.background, dm.glass?.background)}
						onChange={(v) => setSection("glass", cleanSection({ ...glass, background: v }))}
					/>
					<ColorField
						label="玻璃描边"
						value={glass.border}
						isDefault={isDef(glass.border, dm.glass?.border)}
						onChange={(v) => setSection("glass", cleanSection({ ...glass, border: v }))}
					/>
					<ColorField
						label="强玻璃底色"
						value={glass.strongBackground}
						isDefault={isDef(glass.strongBackground, dm.glass?.strongBackground)}
						onChange={(v) => setSection("glass", cleanSection({ ...glass, strongBackground: v }))}
					/>
					<ColorField
						label="强玻璃描边"
						value={glass.strongBorder}
						isDefault={isDef(glass.strongBorder, dm.glass?.strongBorder)}
						onChange={(v) => setSection("glass", cleanSection({ ...glass, strongBorder: v }))}
					/>
					<RangeField
						label="玻璃模糊"
						min={0}
						max={40}
						step={1}
						unit="px"
						value={glass.blur}
						fallback={12}
						isDefault={isDef(glass.blur, dm.glass?.blur)}
						onChange={(v) => setSection("glass", cleanSection({ ...glass, blur: v }))}
					/>
					<RangeField
						label="强玻璃模糊"
						min={0}
						max={40}
						step={1}
						unit="px"
						value={glass.strongBlur}
						fallback={16}
						isDefault={isDef(glass.strongBlur, dm.glass?.strongBlur)}
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
									isDefault={isDef(colors[key], dm.colors?.[key])}
									onChange={(v) => setSection("colors", cleanSection({ ...colors, [key]: v }))}
								/>
							))}
						</div>
					))}
				</Fold>

				<Fold title="AI 聊天">
					<p className="text-[11px] leading-4 text-bn-text-tertiary">
						皮肤生效时聊天页整体换装(默认四色预设隐藏):强调色跟随「主强调色」,
						玻璃件直接用上面「玻璃」一节的参数 —— 这里只管聊天页自己的背景。
					</p>
					<FieldRow label="聊天页背景">
						<textarea
							aria-label="聊天页背景"
							value={chat.background ?? ""}
							onChange={(e) => setChat({ background: e.target.value || undefined })}
							placeholder="纯色或渐变;留空透出整页皮肤背景"
							rows={2}
							className={`${inputCls} resize-y font-mono text-[11px]`}
						/>
					</FieldRow>
					<WallpaperFields
						imageLabel="聊天壁纸"
						prefix="聊天壁纸"
						wp={chatWp}
						def={dm.chat?.wallpaper}
						assets={assetList}
						isDef={isDef}
						onChange={(next) => setChat({ wallpaper: next })}
					/>
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
						isDefault={isDef(radius.card, dm.radius?.card)}
						onChange={(v) => setSection("radius", cleanSection({ ...radius, card: v }))}
					/>
					<NumberField
						label="胶囊圆角"
						value={radius.pill}
						isDefault={isDef(radius.pill, dm.radius?.pill)}
						placeholder="默认;0~999 px"
						min={0}
						max={999}
						onChange={(v) => setSection("radius", cleanSection({ ...radius, pill: v }))}
					/>
					<TextField
						label="卡片阴影"
						mono
						value={shadows.card ?? ""}
						isDefault={isDef(shadows.card, dm.shadows?.card)}
						placeholder="如 0 10px 30px rgba(57,197,187,0.25)"
						onChange={(v) => setSection("shadows", cleanSection({ ...shadows, card: v }))}
					/>
					<TextField
						label="悬浮阴影"
						mono
						value={shadows.elev ?? ""}
						isDefault={isDef(shadows.elev, dm.shadows?.elev)}
						placeholder="悬停/浮层那一档"
						onChange={(v) => setSection("shadows", cleanSection({ ...shadows, elev: v }))}
					/>
				</Fold>

				<Fold title="字体">
					<TextField
						label="正文字体栈"
						value={fontsToText(mode.fonts?.body)}
						isDefault={isDef(fontsToText(mode.fonts?.body), fontsToText(dm.fonts?.body))}
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
							isDefault={isDef(effects.glassShine.color, dm.effects?.glassShine?.color)}
							onChange={(v) => setEffects({ glassShine: v === "" ? {} : { color: v } })}
						/>
					) : null}
					<TextField
						label="光斑颜色"
						mono
						value={bokehText}
						isDefault={isDef(bokehText, (dm.effects?.bokeh?.colors ?? []).join(", "))}
						placeholder="逗号分隔 1~4 个颜色,留空关闭"
						onChange={(v) => {
							setBokehRaw(v);
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
							onChange={(e) => setDraft(withOptional(draft, "css", e.target.value))}
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
							onClick={restoreDefault}
							disabled={!defaultManifest}
							title={
								defaultManifest
									? "把出厂快照拉回来预览,保存后才落盘"
									: "该皮肤还没有钉过默认值,先点「设为默认值」"
							}
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

/** manifest 顶层可选字符串字段(author / description / css):空串即删除。 */
function withOptional(
	m: SkinManifest,
	key: "author" | "description" | "css",
	value: string,
): SkinManifest {
	const next = { ...m };
	if (value === "") delete next[key];
	else next[key] = value;
	return next;
}

// ---- 局部小控件 -----------------------------------------------------------

const WALLPAPER_FIT_OPTIONS = [
	{ value: "", label: "默认(cover 铺满)" },
	{ value: "cover", label: "cover 铺满" },
	{ value: "contain", label: "contain 完整显示" },
	{ value: "tile", label: "tile 平铺" },
];

/**
 * 一组壁纸字段:图片 + (选了图才出现的)铺法 / 位置 / 遮罩 / 模糊。
 *
 * 整页壁纸与聊天壁纸吃的是同一个 `SkinWallpaper`,两处只差标签前缀、比较基准与
 * 落点。抄成两份的话,给 schema 加一个壁纸字段就得记得改两处 —— 漏一处的症状是
 * 「整页调得动、聊天调不动」,而这是本仓明令禁止的半吊子(编辑器 = 能力全集)。
 */
function WallpaperFields(props: {
	/** 图片那一行的标签(整页叫「壁纸图片」,聊天叫「聊天壁纸」,不同构)。 */
	imageLabel: string;
	/** 其余各行的标签前缀,如「壁纸」→「壁纸铺法」。 */
	prefix: string;
	wp: NonNullable<SkinMode["wallpaper"]>;
	/** 出厂快照里对应的那段,喂「(默认)」标注。 */
	def: SkinMode["wallpaper"];
	assets: string[];
	isDef: (cur: string | number | undefined, def: string | number | undefined) => boolean;
	/** 改完的整段 wallpaper(已 clean);undefined = 这套不要壁纸。 */
	onChange: (next: SkinMode["wallpaper"]) => void;
	/** 图片下拉之后插一段 —— 整页那边是「上传图片」那一行。 */
	afterImage?: ReactNode;
}) {
	const { imageLabel, prefix, wp, def, assets, isDef, onChange, afterImage } = props;
	return (
		<>
			<SelectField
				label={imageLabel}
				value={wp.image ?? ""}
				isDefault={isDef(wp.image, def?.image)}
				onChange={(v) => onChange(v === "" ? undefined : { ...wp, image: v })}
				options={[
					{ value: "", label: "(不用壁纸)" },
					...assets.map((a) => ({ value: a, label: a })),
				]}
			/>
			{afterImage}
			{wp.image ? (
				<>
					<SelectField
						label={`${prefix}铺法`}
						value={wp.fit ?? ""}
						isDefault={isDef(wp.fit, def?.fit)}
						onChange={(v) =>
							onChange(cleanSection({ ...wp, fit: (v || undefined) as typeof wp.fit }))
						}
						options={WALLPAPER_FIT_OPTIONS}
					/>
					<TextField
						label={`${prefix}位置`}
						value={wp.position ?? ""}
						isDefault={isDef(wp.position, def?.position)}
						placeholder="默认 center;如 center top"
						onChange={(v) => onChange(cleanSection({ ...wp, position: v }))}
					/>
					<RangeField
						label={`${prefix}遮罩`}
						min={0}
						max={0.8}
						step={0.05}
						value={wp.overlay}
						fallback={0}
						isDefault={isDef(wp.overlay, def?.overlay)}
						onChange={(v) => onChange(cleanSection({ ...wp, overlay: v }))}
					/>
					<RangeField
						label={`${prefix}模糊`}
						min={0}
						max={40}
						step={1}
						value={wp.blur}
						fallback={0}
						isDefault={isDef(wp.blur, def?.blur)}
						onChange={(v) => onChange(cleanSection({ ...wp, blur: v }))}
					/>
				</>
			) : null}
		</>
	);
}

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

/**
 * 值与出厂快照一致时挂在输入框尾的小标 —— 出现即「处于这个皮肤包的默认基准」。
 * 显示规范(主人拍板):数值类(滑杆)在数值后内嵌「数值(默认)」;字符串类(输入框)
 * 尾标不带括号,直接写「默认」—— 孤立的括号形态看着乱。
 */
function DefaultTag() {
	return <span className="shrink-0 text-[10.5px] text-bn-text-tertiary">默认</span>;
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
	isDefault?: boolean;
}) {
	return (
		<FieldRow label={props.label}>
			<div className="flex items-center gap-1.5">
				<input
					aria-label={props.label}
					value={props.value}
					onChange={(e) => props.onChange(e.target.value)}
					placeholder={props.placeholder}
					className={`${inputCls}${props.mono ? " font-mono text-[11px]" : ""}`}
				/>
				{props.isDefault ? <DefaultTag /> : null}
			</div>
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
	isDefault?: boolean;
}) {
	return (
		<FieldRow label={props.label}>
			<div className="flex items-center gap-1.5">
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
				{props.isDefault ? <DefaultTag /> : null}
			</div>
		</FieldRow>
	);
}

function RangeField(props: {
	label: string;
	min: number;
	max: number;
	step: number;
	value: number | undefined;
	/** 未设置时的回落值:滑杆停靠位 + 右侧「数值(默认)」显示,必须=原版实际生效值。 */
	fallback: number;
	unit?: string;
	/** false = 该字段必填,不给「清除回默认」。 */
	clearable?: boolean;
	/** 禁用而不是藏起来(完全透明开着时的透明度滑杆)—— 藏掉会让主人记不得原档位。 */
	disabled?: boolean;
	isDefault?: boolean;
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
				<span className="min-w-13 shrink-0 text-right text-[11px] tabular-nums text-bn-text-tertiary">
					{props.value !== undefined
						? `${props.value}${props.unit ?? ""}${props.isDefault ? "(默认)" : ""}`
						: `${props.fallback}${props.unit ?? ""}(默认)`}
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
	isDefault?: boolean;
}) {
	return (
		<FieldRow label={props.label}>
			<div className="flex items-center gap-1.5">
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
				{props.isDefault ? <DefaultTag /> : null}
			</div>
		</FieldRow>
	);
}

function ColorField(props: {
	label: string;
	value: string | undefined;
	onChange: (v: string) => void;
	isDefault?: boolean;
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
				{props.isDefault ? <DefaultTag /> : null}
			</div>
		</FieldRow>
	);
}
