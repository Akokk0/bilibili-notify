import { useT } from "../i18n";
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
import type { CardKind } from "@bilibili-notify/internal";
import {
	CARD_KIND_SHORT_NAMES,
	CARD_KINDS,
	CARD_PREVIEW_SCENES,
} from "@bilibili-notify/internal/card-skin";
import {
	Btn,
	ErrorNote,
	GlassBox,
	Icon,
	LoadingBlock,
	Picker,
	Pill,
	SELECTED_TINT_BG,
	StatusDot,
} from "@bilibili-notify/ui";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useCoreSettings } from "../hooks/useSettings";
import { streamCardSkinAiCss } from "../services/cardSkinAi";
import { errorTextOf } from "../services/error-text";
import type { GridMetrics } from "./cards/canvas-tracks";
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
	blockInScene,
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

/** Stable card icons; localized names are read during rendering. */
const KIND_ICONS: Record<CardKind, keyof typeof Icon> = {
	live: "live",
	post: "dyn",
	superchat: "sc",
	membership: "guard",
	roastBoard: "trophy",
	roastSolo: "feather",
	wordcloud: "sparkle",
};

export default function CardSkinEditor() {
	const tx = useT();

	const { id = "" } = useParams();
	const navigate = useNavigate();
	const manifestQuery = useCardSkinManifest(id);
	const listQuery = useCardSkinList();
	const save = useSaveCardSkin(id);

	/** 正在编的那份草稿。`null` = 清单还没到。 */
	const [draft, setDraft] = useState<CardSkinManifest | null>(null);
	const [kind, setKind] = useState<CardKind>("live");
	const [selection, setSelection] = useState<SkinSelection>(null);
	/**
	 * 预览框里**量到的**网格(ADR-0018 决策 3):列轨道给画布画列线,行轨道给它印行高。
	 * 各自 `null` = 还没量到 / 量不出来,画布退回按清单估、行高不印。
	 *
	 * 住在这一层而不是画布自己去读:量的是**预览栏**那个 iframe,而两栏是兄弟。
	 */
	const [metrics, setMetrics] = useState<GridMetrics>({ columns: null, rows: null });
	/** 画布上指针指着的那个块 —— 真卡里对应的格子跟着亮(要先打开预览栏那个「格子」开关)。 */
	const [hotCell, setHotCell] = useState<string | null>(null);
	/**
	 * 看的是哪一场。画布**只摆这一场会有的块**(ADR-0014 决策 10 的 2026-09-19 🔗),预览
	 * 也照这一场出图;块的位置只有一份,场景只决定画布上露不露它。
	 */
	const [scene, setScene] = useState<string>(CARD_PREVIEW_SCENES.live[0]?.id ?? "");

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
	}, [kind]);

	/**
	 * 换一场。选中的块在新的那一场不露面(图廊在视频那场)就放掉选中 —— 留着的话检查器
	 * 对着一个画布上找不到的块,改了位置也看不见动。
	 */
	const switchScene = (next: string) => {
		setScene(next);
		if (selection?.kind !== "block") return;
		const block = cardOf(draft, kind)?.blocks.find((b) => b.id === selection.id);
		if (block && !blockInScene(kind, block, next)) setSelection(null);
	};

	const dirty = useMemo(
		() => draft !== null && baseline !== undefined && !sameManifest(draft, baseline),
		[draft, baseline],
	);
	// 只读判定读列表里那面 `builtin` 旗,不写死内置那份的 id —— 服务端才是「哪套改不了」
	// 的权威,面板照抄一份 id 等于把同一条规矩写两遍。
	const readOnly = listQuery.data?.skins.find((s) => s.id === id)?.builtin === true;
	const inUse = listQuery.data?.active === id;
	const scenes = CARD_PREVIEW_SCENES[kind];

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
	const globalsQuery = useCoreSettings();
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

	/**
	 * 改草稿的那**唯一一口**。清单还没到(`draft === null`)时什么都不做 —— 这一句从前在
	 * 每个口子里各抄一遍,二十几处里真正的差别(调的是哪个 op)反倒埋在那串括号中间,而
	 * 新开一个口抄漏它就是一发运行时崩。
	 */
	const edit = (fn: (m: CardSkinManifest) => CardSkinManifest) =>
		setDraft((d) => (d === null ? d : fn(d)));

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
				className="bn-glass-strong flex min-h-14 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 xl:h-14 xl:flex-nowrap xl:px-7 xl:py-0"
			>
				{/* 宽屏下左右两栏都 `flex-1`:剩下的宽度两边**平分**,中间那条卡种 tab 才真的落在页面
				    正中。只给中间 `flex-1` 的话,它的中心跟着两侧内容宽度漂 —— 直播卡有场景选择器
				    时看着是正的,切到没有场景的卡种就整条往右偏。 */}
				<div className="flex w-full min-w-0 items-center gap-3 xl:w-auto xl:flex-1">
					<Btn size="sm" variant="ghost" onClick={() => navigate("/library?category=card-skins")}>
						<Icon.arrowLeft size={14} /> {tx("skinUi.CardSkinEditor.1")}
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
									? `${SELECTED_TINT_BG} text-bn-pink`
									: "text-bn-text-primary hover:text-bn-pink"
							}`}
						>
							{draft?.name ?? tx("skinUi.CardSkinEditor.2")}
						</button>
						{inUse ? (
							<Pill subtle color="var(--color-bn-pink)">
								{tx("skinUi.CardSkinEditor.3")}
							</Pill>
						) : null}
						{dirty ? (
							<span className="flex items-center gap-1.5 text-bn-text-tertiary text-bn-xs">
								<StatusDot kind="warn" size="sm" />
								{tx("skinUi.CardSkinEditor.4")}
							</span>
						) : null}
					</div>
				</div>

				{/* 窄屏将入口、卡种和操作区分行；卡种只在自己的区域横向滚动，不能把保存挤出视口。 */}
				<div className="bn-no-scrollbar w-full min-w-0 overflow-x-auto xl:w-auto xl:shrink-0">
					<div className="flex w-max gap-1 rounded-md bg-bn-surface-muted p-1">
						{CARD_KINDS.map((k) => {
							const IconComp = Icon[KIND_ICONS[k]];
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
									{CARD_KIND_SHORT_NAMES[k]}
									{draft?.cards[k] === undefined ? (
										<span className="text-bn-text-disabled" title={tx("skinUi.CardSkinEditor.5")}>
											·
										</span>
									) : null}
								</button>
							);
						})}
					</div>
				</div>

				<div className="flex w-full min-w-0 flex-wrap items-center justify-end gap-2 xl:w-auto xl:flex-1 xl:flex-nowrap">
					{scenes.length > 1 ? (
						<>
							<span className="text-bn-text-tertiary text-bn-xs">
								{tx("skinUi.CardSkinEditor.6")}
							</span>
							<div className="bn-no-scrollbar min-w-0 max-w-full overflow-x-auto">
								<Picker
									value={scene}
									onChange={switchScene}
									options={scenes.map((sc) => ({ value: sc.id, label: sc.label }))}
								/>
							</div>
						</>
					) : null}
					<Btn
						size="sm"
						variant="primary"
						disabled={!dirty || readOnly || save.isPending || draftError !== null}
						onClick={() => draft && save.mutate(draft)}
					>
						{save.isPending ? tx("skinUi.CardSkinEditor.7") : tx("skinUi.CardSkinEditor.8")}
					</Btn>
				</div>
			</header>

			<div className="min-h-0 flex-1 overflow-y-auto px-7 pt-4 pb-6">
				{manifestQuery.isPending ? (
					<LoadingBlock label={tx("skinUi.CardSkinEditor.9")} />
				) : manifestQuery.isError ? (
					<ErrorNote>
						{tx("skinUi.CardSkinEditor.10", {
							reason: String((manifestQuery.error as Error).message),
						})}
					</ErrorNote>
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
							onMetrics={setMetrics}
							hotCell={hotCell}
						/>
						{/* 画布 + 检查器合占那 2/3:检查器固定 380(旋钮那几行再窄就开始切字),
						    剩下的全归 12 列的画布。 */}
						<div
							className="grid grid-cols-1 items-start gap-3.5 xl:grid-cols-[minmax(0,1fr)_var(--bn-inspector-col)]"
							style={{ "--bn-inspector-col": `${INSPECTOR_COL}px` } as CSSProperties}
						>
							<GlassBox
								title={tx("skinUi.CardSkinEditor.11", { value0: CARD_KIND_SHORT_NAMES[kind] })}
								subtitle={tx("skinUi.CardSkinEditor.12")}
								icon={<Icon.square size={14} />}
							>
								<SkinCanvas
									kind={kind}
									card={cardOf(draft, kind)}
									selection={selection}
									onSelect={setSelection}
									scene={scene}
									tracks={metrics.columns}
									rowHeights={metrics.rows}
									onHover={setHotCell}
									// 拖块改行列 / 拉边改跨列。**与检查器那几个数字框刻意不是同一个口** ——
									// 「放下」带着「我要它在这儿」的意思,叠上了就该在上面,而叠放次序不在
									// `grid` 里(没写层次时是块的先后)。数字框是精确编辑,不改先后。
									onGrid={
										readOnly
											? undefined
											: (blockId, patch) => edit((d) => dropBlockGrid(d, kind, blockId, patch))
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
							<GlassBox title={tx("skinUi.CardSkinEditor.13")} icon={<Icon.sliders size={14} />}>
								<SkinInspector
									manifest={draft}
									kind={kind}
									ai={ai}
									selection={selection}
									onGrid={(blockId, patch) => edit((d) => setBlockGrid(d, kind, blockId, patch))}
									onShowIf={(blockId, path) => edit((d) => setBlockShowIf(d, kind, blockId, path))}
									onHtml={(blockId, html) => edit((d) => setBlockHtml(d, kind, blockId, html))}
									onCss={(blockId, css) => edit((d) => setBlockCss(d, kind, blockId, css))}
									onFrameCss={(css) => edit((d) => setFrameCss(d, kind, css))}
									onMeta={readOnly ? undefined : (patch) => edit((d) => setSkinMeta(d, patch))}
									onKnobs={
										readOnly
											? undefined
											: {
													onAdd: () => edit((d) => addKnob(d)?.manifest ?? d),
													onRemove: (key) => edit((d) => removeKnob(d, key)),
													onDecl: (key, patch) => edit((d) => setKnobDecl(d, key, patch)),
													onType: (key, type) => edit((d) => setKnobType(d, key, type)),
													onDefault: (key, value) => edit((d) => setKnobDefault(d, key, value)),
													onNumber: (key, patch) => edit((d) => setKnobNumber(d, key, patch)),
													onSwitch: (key, patch) => edit((d) => setKnobSwitch(d, key, patch)),
													onOptionAdd: (key) => edit((d) => addKnobOption(d, key)),
													onOption: (key, index, patch) =>
														edit((d) => setKnobOption(d, key, index, patch)),
													onOptionRemove: (key, index) =>
														edit((d) => removeKnobOption(d, key, index)),
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
													onAddFont: () => edit((d) => addFont(d)),
													onFont: (index, patch) => edit((d) => setFont(d, index, patch)),
													onRemoveFont: (index) => edit((d) => removeFont(d, index)),
												}
									}
									onFrame={(patch) => edit((d) => setFrame(d, kind, patch))}
									onColumns={(columns) => edit((d) => setColumns(d, kind, columns))}
									onDropCard={
										readOnly
											? undefined
											: () => {
													edit((d) => dropCard(d, kind));
													setSelection(null);
												}
									}
									onRemove={
										readOnly
											? undefined
											: (blockId) => {
													edit((d) => removeBlock(d, kind, blockId));
													// 选中得跟着撤,不然检查器对着一个已经没了的块。
													setSelection(null);
												}
									}
								/>
							</GlassBox>
						</div>
					</div>
				)}
				{readOnly ? <ErrorNote className="mt-3">{tx("skinUi.CardSkinEditor.14")}</ErrorNote> : null}
				{save.isError ? (
					<ErrorNote className="mt-3">
						{tx("skinUi.CardSkinEditor.15", { reason: errorTextOf(save.error) })}
					</ErrorNote>
				) : null}
			</div>
		</div>
	);
}

/** 草稿与基线一不一样。清单是纯 JSON(schema 只收 JSON 值),序列化比对够用。 */
function sameManifest(a: CardSkinManifest | null, b: CardSkinManifest | undefined): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}
