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
import type { CardSkinKind } from "@bilibili-notify/internal";
import { CARD_PREVIEW_SCENES, CARD_SKIN_KINDS } from "@bilibili-notify/internal/constants";
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
import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useCardSkinList } from "./cards/card-skins-query";
import { SkinCanvas, type SkinSelection } from "./cards/SkinCanvas";
import { SkinInspector } from "./cards/SkinInspector";
import { SkinPreviewPane } from "./cards/SkinPreviewPane";
import {
	addBlock,
	addCustomBlock,
	adoptCard,
	cardOf,
	dropCard,
	removeBlock,
	setBlockCss,
	setBlockGrid,
	setBlockHtml,
	setBlockShowIf,
	setColumns,
	setFrame,
	setFrameCss,
} from "./cards/skin-draft-ops";
import { useCardSkinManifest, useSaveCardSkin } from "./cards/skin-editor-query";

/**
 * 预览那一栏最宽到哪儿。卡宽上限是 1200,真按它给就把画布挤没了 —— 超过这个数的卡
 * 由预览栏自己缩着画(缩放比例它会明说)。
 */
const PREVIEW_COL_MAX = 720;

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
	const factory = useCardSkinManifest(factoryId, !readOnly && missingCard && factoryId !== "");

	// 预览那一栏的宽度**跟着卡宽走**,不再钉死 400 —— 640 宽的卡挤在 400 里右半张就没了。
	// 它挤的是画布的宽度(画布是 12 列等宽格子,窄一点照样读得懂;预览窄一点就是另一张卡)。
	const previewCol = Math.min(Math.max(cardOf(draft, kind)?.width ?? 600, 320), PREVIEW_COL_MAX);

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
						<span className="truncate font-semibold text-bn-md text-bn-text-primary">
							{draft?.name ?? "载入中…"}
						</span>
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
					<Btn
						size="sm"
						variant="primary"
						disabled={!dirty || readOnly || save.isPending}
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
					<div
						className="grid grid-cols-1 items-start gap-3.5 xl:grid-cols-[minmax(0,1fr)_var(--bn-preview-col)_320px]"
						// 走 CSS 变量而不是直接写 `gridTemplateColumns`:模板那串还得留在类里,
						// 它只在 xl 以上生效(窄屏是单列),写成内联样式会把窄屏那档也一起盖掉。
						style={{ "--bn-preview-col": `${previewCol}px` } as CSSProperties}
					>
						<GlassBox
							title={`网格画布 · ${KIND_META[kind].label}卡`}
							subtitle="点一个块,在右边的检查器里改它的位置;这里的行等高只是示意,真卡里行高随内容撑"
							icon={<Icon.square size={14} />}
						>
							<SkinCanvas
								kind={kind}
								card={cardOf(draft, kind)}
								selection={selection}
								onSelect={setSelection}
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
						<GlassBox
							title="实时预览"
							subtitle="server 出 HTML、浏览器画;字体渲染与截图有细微差,像素级以「最终效果」为准"
							accent="var(--color-bn-purple)"
							icon={<Icon.eye size={14} />}
						>
							<SkinPreviewPane
								skinId={id}
								kind={kind}
								scene={scene}
								manifest={draft}
								boxWidth={previewCol}
							/>
						</GlassBox>
						<GlassBox title="检查器" icon={<Icon.sliders size={14} />}>
							<SkinInspector
								manifest={draft}
								kind={kind}
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
								onFrameCss={(css) => setDraft((d) => (d === null ? d : setFrameCss(d, kind, css)))}
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
