/**
 * 卡片皮肤编辑器(ADR-0014 第二步,决策 20)—— 独立路由 `/cards/skins/:id` 的全屏页。
 *
 * **不带站内 nav**:编辑器要的是三栏并排(画布 / 预览 / 检查器),挤在站内那层 28px 内
 * 边距与顶栏底下会两边都不够宽;做法同聊天页 —— 自己铺一层 `fixed inset-0`。
 *
 * **刻意不接全局灵动岛(`useDirtyDraft`)**:那套是四个设置页共用的「有未保存改动」提示,
 * 而这里三处对不上 —— ① 编辑器自己那条顶栏上就有保存与脏标(设计稿定的),再飘一个岛
 * 等于同一件事说两遍;② 草稿是整份皮肤清单(深对象),岛上按字段列 diff 列不出人话;
 * ③ 保存失败回的是**装包门的一串错**(`errors`),要整块面板摆出来,不是岛上一行红字。
 *
 * 这一版只有骨架:顶栏(卡种 / 场景 / 保存)与三栏的位置。画布、预览、检查器各自成片,
 * 挨着往里填 —— 每片都要能独立验,所以先把「打开哪套皮肤、编的是哪种卡」这层状态钉住。
 */

import type { CardSkinManifest } from "@bilibili-notify/contract";
// 值走**零依赖子路径**:从根入口取值会把 zod 整张 schema 图拽进前端 bundle,而症状只是
// 产物悄悄胖一圈,任何门禁都是绿的(`internal-entry-conformance.test.ts` 钉着这条)。
import type { CardSkinKind, GlobalConfig } from "@bilibili-notify/internal";
import {
	CARD_PREVIEW_SCENES,
	CARD_SKIN_KINDS,
	CARD_SKIN_VARIANTS,
} from "@bilibili-notify/internal/constants";
import {
	Btn,
	ErrorNote,
	GlassBox,
	Icon,
	LoadingBlock,
	Picker,
	Pill,
	StatusDot,
} from "@bilibili-notify/ui";
import { useQuery } from "@tanstack/react-query";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../services/api";
import { streamCardSkinAiCss } from "../services/cardSkinAi";
import { cardSkinAiReadiness } from "./cards/card-skin-ai";
import { useCardSkinList } from "./cards/card-skins-query";
import { serverErrors } from "./cards/preview-error";
import { SkinCanvas, type SkinSelection } from "./cards/SkinCanvas";
import { type InspectorAi, SkinInspector } from "./cards/SkinInspector";
import { SkinPreviewPane } from "./cards/SkinPreviewPane";
import {
	addBlock,
	addCustomBlock,
	addFont,
	addKnob,
	addKnobOption,
	adoptCard,
	cardOf,
	dropBlockGrid,
	dropCard,
	fontsError,
	knobsError,
	removeBlock,
	removeFont,
	removeKnob,
	removeKnobOption,
	setBlockCss,
	setBlockGrid,
	setBlockHtml,
	setBlockShowIf,
	setColumns,
	setFont,
	setFrame,
	setFrameCss,
	setKnobDecl,
	setKnobDefault,
	setKnobNumber,
	setKnobOption,
	setKnobSwitch,
	setKnobType,
	setSkinMeta,
	setVariantGrid,
	skinMetaError,
} from "./cards/skin-draft-ops";
import {
	useCardSkinAssets,
	useCardSkinManifest,
	useDeleteCardSkinAsset,
	useSaveCardSkin,
	useUploadCardSkinAsset,
} from "./cards/skin-editor-query";

/**
 * 预览那一栏最宽到哪儿。卡宽上限是 1200,真按它给就把画布挤没了 —— 超过这个数的卡
 * 由预览栏自己缩着画(缩放比例它会明说)。
 */
const PREVIEW_COL_MAX = 720;

/**
 * 检查器那一栏 px。320 装不下旋钮那几行(键 / 名字 / 类型 / 控件挤在一排,长一点的
 * 字段名当场被切),2026-09-14 加到 380。
 */
const INSPECTOR_COL = 380;

/** 七种卡在顶栏 tab 上的中文名与图标。顺序就是 `CARD_SKIN_KINDS`。 */
const KIND_META: Record<CardSkinKind, { label: string; icon: keyof typeof Icon }> = {
	live: { label: "直播", icon: "live" },
	dynamic: { label: "动态", icon: "dyn" },
	sc: { label: "SC", icon: "sc" },
	guard: { label: "上舰", icon: "guard" },
	roastBoard: { label: "锐评榜单", icon: "trophy" },
	roastSolo: { label: "单人锐评", icon: "feather" },
	wordcloud: { label: "词云", icon: "sparkle" },
};

export default function CardSkinEditor() {
	const { id = "" } = useParams();
	const navigate = useNavigate();
	const manifestQuery = useCardSkinManifest(id);
	const listQuery = useCardSkinList();
	const save = useSaveCardSkin(id);

	/** 正在编的那份草稿。`null` = 清单还没到。 */
	const [draft, setDraft] = useState<CardSkinManifest | null>(null);
	const [kind, setKind] = useState<CardSkinKind>("live");
	const [selection, setSelection] = useState<SkinSelection>(null);
	/**
	 * 预览那一场画出来的块,连**它是哪种卡的**一起记:换卡种时新预览还没画好,拿上一种卡的
	 * 单子去标,同名块(头像 / 名字在好几种卡里都有)会让画布短暂说错话。
	 */
	const [drawn, setDrawn] = useState<{ kind: CardSkinKind; ids: string[] | null } | null>(null);
	const [scene, setScene] = useState<string>(CARD_PREVIEW_SCENES.live[0]?.id ?? "");
	/**
	 * 眼前这一场落在哪个**形态**(`null` = 只有基础版式),由预览那头回报
	 * (ADR-0014 决策 10 的 2026-09-18 🔗)。
	 */
	const [variant, setVariant] = useState<string | null>(null);
	/**
	 * 改的是哪一层。**默认基础版式**(主人拍板):最容易犯的错是「以为改了全部,其实只改了
	 * 一场」,所以要只改本场得先切一下。
	 */
	const [onlyThisCase, setOnlyThisCase] = useState(false);

	const baseline = manifestQuery.data?.manifest;
	// 清单到了(或存完换了一份)就重置草稿。比对的是**对象身份**:react-query 只在数据
	// 真变了时换引用,所以这不会把主人正在编的东西冲掉。
	useEffect(() => {
		if (baseline) setDraft(structuredClone(baseline) as CardSkinManifest);
	}, [baseline]);

	// 换卡种时把场景也换成那种卡的第一个 —— 留着上一种卡的场景 id,预览那头会回落到
	// 默认场景,而面板上那排按钮却一个都不高亮,看起来像坏了。
	useEffect(() => {
		setScene(CARD_PREVIEW_SCENES[kind][0]?.id ?? "");
		// 换了卡种,上一张卡的选中就没意义了 —— 留着的话检查器会对着一个不存在的块。
		setSelection(null);
		// 形态也一样:上一种卡的那一档在这种卡上根本不存在,而新预览还没回来。留着的话
		// 「只改本场」这一下会写进一份别的卡的覆盖里。
		setVariant(null);
		setOnlyThisCase(false);
	}, [kind]);

	// 这一场只有基础版式(醒目留言那种只有一副样子的卡)—— 开关没有意义,顺手收回,
	// 免得它停在「只改本场」上而改动其实落进了 base。
	useEffect(() => {
		if (variant === null) setOnlyThisCase(false);
	}, [variant]);

	const dirty = useMemo(
		() => draft !== null && baseline !== undefined && !sameManifest(draft, baseline),
		[draft, baseline],
	);
	// 只读判定读列表里那面 `builtin` 旗,不写死内置那份的 id —— 服务端才是「哪套改不了」
	// 的权威,面板照抄一份 id 等于把同一条规矩写两遍。
	const readOnly = listQuery.data?.skins.find((s) => s.id === id)?.builtin === true;
	const inUse = listQuery.data?.active === id;
	const scenes = CARD_PREVIEW_SCENES[kind];
	/** 这一场那个形态的人话名;`null` = 这一场只有基础版式(开关就不该出现)。 */
	const variantLabel = CARD_SKIN_VARIANTS[kind].find((v) => v.id === variant)?.label ?? null;

	// 接管一种卡要抄出厂那份。**哪套是出厂的问列表要**(同 `readOnly` 的道理:服务端才是
	// 权威),而且只在真缺这种卡时才去拉 —— 平时白打一趟。
	const factoryId = listQuery.data?.skins.find((s) => s.builtin)?.id ?? "";
	const missingCard = draft !== null && draft.cards[kind] === undefined;
	const assetsQuery = useCardSkinAssets(id);
	const upload = useUploadCardSkinAsset(id);
	const removeAsset = useDeleteCardSkinAsset(id);
	const factory = useCardSkinManifest(factoryId, !readOnly && missingCard && factoryId !== "");

	// CSS 框旁的「请女仆帮忙写」(ADR-0015 第二片)。发出去的是**这一刻的草稿**:AI 看的
	// 该是用户眼前这份,不是盘上那份。草稿走 ref —— 流是异步的,闭包里那份早就旧了。
	const globalsQuery = useQuery({
		queryKey: ["globals"],
		queryFn: () => api.get<GlobalConfig>("/api/globals"),
	});
	const draftRef = useRef(draft);
	draftRef.current = draft;
	const ai: InspectorAi = {
		readiness: cardSkinAiReadiness({ globals: globalsQuery.data, readOnly }),
		run: (target, instruction, handlers, signal) =>
			streamCardSkinAiCss(
				id,
				{ kind, ...target, instruction, manifest: draftRef.current },
				handlers,
				signal,
			),
	};

	// 预览那一栏的宽度**跟着卡宽走**,不再钉死 400 —— 640 宽的卡挤在 400 里右半张就没了。
	// 它挤的是画布的宽度(画布是 12 列等宽格子,窄一点照样读得懂;预览窄一点就是另一张卡)。
	const previewCol = Math.min(Math.max(cardOf(draft, kind)?.width ?? 600, 320), PREVIEW_COL_MAX);
	// 存不下去的草稿不许按保存:装包门那头只回一句「name: 太短」或「knobs[3]: …」,
	// 序号对不上界面上第几行,主人根本不知道说的是哪一个。
	const draftError =
		draft === null
			? null
			: (skinMetaError(draft) ??
				knobsError(draft) ??
				fontsError(draft, assetsQuery.data?.assets ?? []));

	/** 添块的收尾:换草稿 + 选中新块。两种添法(内置 / 自定义)只差前半句。 */
	const landBlock = (added: { manifest: CardSkinManifest; blockId: string } | null) => {
		if (!added) return;
		setDraft(added.manifest);
		setSelection({ kind: "block", id: added.blockId });
	};

	return (
		<div
			className="fixed inset-0 z-bn-scrim flex flex-col"
			// 整页底直接引 `--bn-page-bg`(同聊天页):那是皮肤能重绘的那一层,
			// 而工具类里没有对应的 token。
			style={{ background: "var(--bn-page-bg)" }}
		>
			<header
				data-bn="glass-strong"
				className="bn-glass-strong flex h-14 shrink-0 items-center gap-3 px-7"
			>
				{/* 左右两栏都 `flex-1`:剩下的宽度两边**平分**,中间那条卡种 tab 才真的落在页面
				    正中。只给中间 `flex-1` 的话,它的中心跟着两侧内容宽度漂 —— 直播卡有场景选择器
				    时看着是正的,切到没有场景的卡种就整条往右偏。 */}
				<div className="flex min-w-0 flex-1 items-center gap-3">
					<Btn size="sm" variant="ghost" onClick={() => navigate("/cards")}>
						<Icon.arrowLeft size={14} /> 返回卡片页
					</Btn>
					<span className="h-5.5 w-px bg-bn-border" />
					<div className="flex min-w-0 items-center gap-2">
						{/* 皮肤名就是**皮肤这一档的入口** —— 名字 / 作者 / 说明不属于任何一种卡,
						    塞进卡种 tab 那条里反而找不着;点自己的名字改自己是最短的那条路。 */}
						<button
							type="button"
							disabled={draft === null}
							onClick={() => setSelection({ kind: "skin" })}
							data-bn="chip"
							className={`truncate rounded-sm px-1.5 py-0.5 font-semibold text-bn-md transition ${
								selection?.kind === "skin"
									? "bg-bn-pink/10 text-bn-pink"
									: "text-bn-text-primary hover:text-bn-pink"
							}`}
						>
							{draft?.name ?? "载入中…"}
						</button>
						{inUse ? (
							<Pill subtle color="var(--color-bn-pink)">
								使用中
							</Pill>
						) : null}
						{dirty ? (
							<span className="flex items-center gap-1.5 text-bn-text-tertiary text-bn-xs">
								<StatusDot kind="warn" size="sm" />
								有未保存的改动
							</span>
						) : null}
					</div>
				</div>

				<div className="shrink-0">
					<div className="flex flex-wrap gap-1 rounded-md bg-bn-surface-muted p-1">
						{CARD_SKIN_KINDS.map((k) => {
							const meta = KIND_META[k];
							const IconComp = Icon[meta.icon];
							const active = k === kind;
							return (
								<button
									type="button"
									key={k}
									onClick={() => setKind(k)}
									aria-pressed={active}
									data-bn={active ? "tab tab-active" : "tab"}
									className={`flex items-center gap-1.5 rounded-sm px-3 py-1.25 font-semibold text-bn-xs transition ${
										active ? "bg-bn-surface-strong text-bn-pink shadow-sm" : "text-bn-text-tertiary"
									}`}
								>
									<IconComp size={13} />
									{meta.label}
									{draft?.cards[k] === undefined ? (
										<span
											className="text-bn-text-disabled"
											title="这套皮肤没有定义这种卡,出图时跟着出厂默认"
										>
											·
										</span>
									) : null}
								</button>
							);
						})}
					</div>
				</div>

				<div className="flex flex-1 items-center justify-end gap-2">
					{scenes.length > 1 ? (
						<>
							<span className="text-bn-text-tertiary text-bn-xs">场景</span>
							<Picker
								value={scene}
								onChange={setScene}
								options={scenes.map((sc) => ({ value: sc.id, label: sc.label }))}
							/>
						</>
					) : null}
					{/* 「改哪一层」。**只在这一场真有形态时才出现** —— 只有一副样子的卡摆个
					    永远选不动的开关,只会让人以为自己漏了什么。只读时不摆:改不了就没得选。 */}
					{variantLabel !== null && !readOnly ? (
						<>
							<span className="text-bn-text-tertiary text-bn-xs">改</span>
							<Picker
								value={onlyThisCase ? "case" : "base"}
								onChange={(v) => setOnlyThisCase(v === "case")}
								options={[
									{ value: "base", label: "基础版式" },
									{ value: "case", label: `只改「${variantLabel}」` },
								]}
							/>
						</>
					) : null}
					<Btn
						size="sm"
						variant="primary"
						disabled={!dirty || readOnly || save.isPending || draftError !== null}
						onClick={() => draft && save.mutate(draft)}
					>
						{save.isPending ? "保存中…" : "保存"}
					</Btn>
				</div>
			</header>

			<div className="min-h-0 flex-1 overflow-y-auto px-7 pt-4 pb-6">
				{manifestQuery.isPending ? (
					<LoadingBlock label="正在读取皮肤清单…" />
				) : manifestQuery.isError ? (
					<ErrorNote>读不到这套皮肤:{String((manifestQuery.error as Error).message)}</ErrorNote>
				) : (
					// **按占比分,不按内容分**(2026-09-14 主人拍板):预览 1/3,画布与检查器合占
					// 2/3。从前预览列是「卡宽」这个固定数,换一张 640 宽的卡整页就重新排一次;
					// 占比是稳的,而卡放不下时预览自己会按比例缩(那本来就是它的活)。
					<div className="grid grid-cols-1 items-start gap-3.5 xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
						{/* 预览这一栏自己出小卡 + 底下那块线框(卡片单独一块地方),所以这儿不再包
						    GlassBox —— 包了就成了「卡片框套在说明框里面」。 */}
						<SkinPreviewPane
							skinId={id}
							kind={kind}
							scene={scene}
							manifest={draft}
							boxWidth={previewCol}
							onDrawn={(ids) => setDrawn({ kind, ids })}
							onVariant={setVariant}
						/>
						{/* 画布 + 检查器合占那 2/3:检查器固定 380(旋钮那几行再窄就开始切字),
						    剩下的全归 12 列的画布。 */}
						<div
							className="grid grid-cols-1 items-start gap-3.5 xl:grid-cols-[minmax(0,1fr)_var(--bn-inspector-col)]"
							style={{ "--bn-inspector-col": `${INSPECTOR_COL}px` } as CSSProperties}
						>
							<GlassBox
								title={`网格画布 · ${KIND_META[kind].label}卡`}
								subtitle="点一个块,在右边的检查器里改它的位置;行等高,封面这种高块靠「跨行」多占几行;标着「这一场不画」的块,左边那个场景下不出现"
								icon={<Icon.square size={14} />}
							>
								<SkinCanvas
									kind={kind}
									card={cardOf(draft, kind)}
									selection={selection}
									onSelect={setSelection}
									drawn={drawn?.kind === kind ? drawn.ids : null}
									// 拖块改行列 / 拉边改跨列。**与检查器那几个数字框刻意不是同一个口** ——
									// 「放下」带着「我要它在这儿」的意思,叠上了就该在上面,而叠放次序不在
									// `grid` 里(没写层次时是块的先后)。数字框是精确编辑,不改先后。
									variant={variant}
									editingVariant={onlyThisCase}
									onGrid={
										readOnly
											? undefined
											: (blockId, patch) =>
													setDraft((d) => {
														if (d === null) return d;
														// 切了「只改本场」,同一下拖拽落进这一形态的覆盖;
														// 否则照旧改基础版式。
														return onlyThisCase && variant
															? setVariantGrid(d, kind, variant, blockId, patch)
															: dropBlockGrid(d, kind, blockId, patch);
													})
									}
									// 只读的皮肤连口都不给:钮禁着还留在那儿,主人只会一路点到保存那步才知道改不了。
									onAdopt={
										readOnly
											? undefined
											: () => {
													const source = factory.data?.manifest.cards[kind];
													if (draft === null || !source) return;
													setDraft(adoptCard(draft, kind, source));
													// 接管完先停在外框上:接下来多半是改卡宽 / 间距,而不是某一个块。
													setSelection({ kind: "frame" });
												}
									}
									adoptBusy={factory.data === undefined}
									onAdd={
										readOnly
											? undefined
											: (builtin) => {
													if (draft === null) return;
													// 加完立刻选中:新块落在最底下整宽一行,十次有九次下一步就是把它挪窄。
													landBlock(addBlock(draft, kind, builtin));
												}
									}
									onAddCustom={
										readOnly
											? undefined
											: () => draft !== null && landBlock(addCustomBlock(draft, kind))
									}
								/>
							</GlassBox>
							<GlassBox title="检查器" icon={<Icon.sliders size={14} />}>
								<SkinInspector
									manifest={draft}
									kind={kind}
									ai={ai}
									selection={selection}
									onGrid={(blockId, patch) =>
										setDraft((d) => (d === null ? d : setBlockGrid(d, kind, blockId, patch)))
									}
									onShowIf={(blockId, path) =>
										setDraft((d) => (d === null ? d : setBlockShowIf(d, kind, blockId, path)))
									}
									onHtml={(blockId, html) =>
										setDraft((d) => (d === null ? d : setBlockHtml(d, kind, blockId, html)))
									}
									onCss={(blockId, css) =>
										setDraft((d) => (d === null ? d : setBlockCss(d, kind, blockId, css)))
									}
									onFrameCss={(css) =>
										setDraft((d) => (d === null ? d : setFrameCss(d, kind, css)))
									}
									onMeta={
										readOnly
											? undefined
											: (patch) => setDraft((d) => (d === null ? d : setSkinMeta(d, patch)))
									}
									onKnobs={
										readOnly
											? undefined
											: {
													onAdd: () =>
														setDraft((d) => (d === null ? d : (addKnob(d)?.manifest ?? d))),
													onRemove: (key) => setDraft((d) => (d === null ? d : removeKnob(d, key))),
													onDecl: (key, patch) =>
														setDraft((d) => (d === null ? d : setKnobDecl(d, key, patch))),
													onType: (key, type) =>
														setDraft((d) => (d === null ? d : setKnobType(d, key, type))),
													onDefault: (key, value) =>
														setDraft((d) => (d === null ? d : setKnobDefault(d, key, value))),
													onNumber: (key, patch) =>
														setDraft((d) => (d === null ? d : setKnobNumber(d, key, patch))),
													onSwitch: (key, patch) =>
														setDraft((d) => (d === null ? d : setKnobSwitch(d, key, patch))),
													onOptionAdd: (key) =>
														setDraft((d) => (d === null ? d : addKnobOption(d, key))),
													onOption: (key, index, patch) =>
														setDraft((d) => (d === null ? d : setKnobOption(d, key, index, patch))),
													onOptionRemove: (key, index) =>
														setDraft((d) => (d === null ? d : removeKnobOption(d, key, index))),
												}
									}
									assets={{
										names: assetsQuery.data?.assets ?? [],
										pending: assetsQuery.isPending,
										uploadError: serverErrors(upload.error).join(";") || null,
									}}
									onAssets={
										readOnly
											? undefined
											: {
													onUpload: (file) => upload.mutate(file),
													onDeleteAsset: (name) => removeAsset.mutate(name),
													onAddFont: () => setDraft((d) => (d === null ? d : addFont(d))),
													onFont: (index, patch) =>
														setDraft((d) => (d === null ? d : setFont(d, index, patch))),
													onRemoveFont: (index) =>
														setDraft((d) => (d === null ? d : removeFont(d, index))),
												}
									}
									onFrame={(patch) => setDraft((d) => (d === null ? d : setFrame(d, kind, patch)))}
									onColumns={(columns) =>
										setDraft((d) => (d === null ? d : setColumns(d, kind, columns)))
									}
									onDropCard={
										readOnly
											? undefined
											: () => {
													setDraft((d) => (d === null ? d : dropCard(d, kind)));
													setSelection(null);
												}
									}
									onRemove={
										readOnly
											? undefined
											: (blockId) => {
													setDraft((d) => (d === null ? d : removeBlock(d, kind, blockId)));
													// 选中得跟着撤,不然检查器对着一个已经没了的块。
													setSelection(null);
												}
									}
								/>
							</GlassBox>
						</div>
					</div>
				)}
				{readOnly ? (
					<ErrorNote className="mt-3">
						内置的默认皮肤改不了 —— 想改它请先回卡片页「复制一份」。
					</ErrorNote>
				) : null}
				{save.isError ? (
					<ErrorNote className="mt-3">保存失败:{String((save.error as Error).message)}</ErrorNote>
				) : null}
			</div>
		</div>
	);
}

/** 草稿与基线一不一样。清单是纯 JSON(schema 只收 JSON 值),序列化比对够用。 */
function sameManifest(a: CardSkinManifest | null, b: CardSkinManifest | undefined): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}
