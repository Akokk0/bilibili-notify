/**
 * 编辑器的网格画布(ADR-0014 决策 6 / 20)。
 *
 * **它是示意图,不是所见即所得** —— 编辑器最大的一个取舍。当初的原因是硬的:预览走
 * sandbox iframe 且不给同源,父页面读不到里面每个块的位置,也就画不出「叠在真卡上的选框」。
 * 2026-09-17 为了让预览框跟着卡高,iframe 放开了同源(脚本仍不给),读位置从此**做得到**
 * 了,但画布要不要改成叠在真卡上是另一件事,没定。所以这里画的仍是**行列关系**:12 列
 * 等宽格子、行等高,块按 `grid.column` / `grid.span` 落位。真卡里行高随内容撑 —— **只有
 * 标了 `heightFromRows` 的块(封面这种单张图)例外**,它们的跨行就是真高度(2026-09-18
 * 主人拍板),所以也只有它们画上下两条把手。这点在副标题里明说。
 *
 * 与皮肤 JSON 的对应是一比一的:一个块一格,`column` 是 1 起的列号,`span` 是跨几列。
 * 画布上多出来的那一列是行号,所以 CSS 里的 `grid-column` 要 +1。
 *
 * **块拖得动**(2026-09-14 主人要它进账):拖块身改行列,拉左右两边改跨列。几何算在
 * `canvas-drag.ts`(纯函数,单独钉),这里只负责量轨道、收指针、拖完交一次 patch ——
 * **拖的过程只改本地的预览位置,松手才 `onGrid`**:每动一格就发一次的话,右边那张真预览
 * 会被整趟拖拽按住不放地重画。
 *
 * 拖拽是**指针专用**的:两个拉边把手对读屏器隐藏,键盘那条路仍是检查器里的数字框 ——
 * 它一直在,而且比拖拽精确。`onGrid` 不给(只读皮肤)时把手整个不画:拖得动却存不下去
 * 比拖不动更气人。
 *
 * **画布只摆这一场会有的块,而且和出图一样紧**(ADR-0014 决策 10 的 2026-09-19 🔗)。
 * 哪些块属于哪一场由内置块目录说(`scenes`),图廊在视频那场**一点痕迹都不留** —— 没有灰壳、
 * 没有「这一场不画」的标。整行没块的行也压掉(出图那头 ④ 压行用的是同一个 `rowMapOf`),
 * 于是画布上的行号是**压后的**:块按压后行号落位、行轨道按压后行号量,拖完交出去之前
 * 用 `realGridPatch` 换回真行号;行号列上印的仍是真行号,检查器里那个数字才对得上。
 */

import type { CardSkinKind, CardSkinManifest } from "@bilibili-notify/contract";
import type { CardSkinBuiltinBlock } from "@bilibili-notify/internal";
import {
	CARD_PREVIEW_SCENES,
	CARD_SKIN_BUILTIN_BLOCKS,
	CARD_SKIN_LIMITS,
	rowMapOf,
} from "@bilibili-notify/internal/constants";
import { AddButton, Btn, EmptyNote, Icon, Pill, SELECTED_LANGUAGE } from "@bilibili-notify/ui";
import { animate, type MotionValue, motion, useMotionValue } from "motion/react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
	createVelocityTracker,
	type GridPos,
	MAX_SOLID_STACK,
	movedGrid,
	prefersReducedMotion,
	project,
	realGridPatch,
	realRowOf,
	resizedGrid,
	resizedRows,
	rowAt,
	solidStackDepth,
	type Track,
	trackAt,
	type Velocity,
} from "./canvas-drag";
import { canvasTemplate } from "./canvas-tracks";
import { blockInScene, canAddBlock, stackingOf } from "./skin-draft-ops";

/** 列号 1…12。算一次就够 —— 列数是固定的(决策 6)。 */
const COLS = Array.from({ length: CARD_SKIN_LIMITS.columns }, (_, i) => i + 1);

/**
 * 画布上选中的东西:某个块,或者卡片外框(它不是块,但也能选)。
 *
 * 另有**皮肤这一档**(`skin`:名字 / 作者 / 说明)。它不属于任何一种卡,所以入口不在画布
 * 上,在头部那行皮肤名 —— 但选中状态是同一份,检查器才不会同时画两样东西。
 */
export type SkinSelection =
	| { kind: "block"; id: string }
	| { kind: "frame" }
	| { kind: "skin" }
	| null;

/**
 * 叠起来时怎么错开。**动的永远是上面那块**:往右下浮 8 / 4px,被压住的停在自己真正的
 * 格子上,露出来的左边缘就是「底下还有一张卡」的读法。
 *
 * 初版反过来 —— 让**被压住的往左退**,理由是左边有 28px 的行号列可借。但那只在摞正好
 * 贴着第 1 列时成立:摞在中间时,退出去的那 8px 直接撞上左边的邻居
 * (2026-09-18 主人指着截图:「重叠导致底下的和旁边的完全挨着了,应该整体向右移」)。
 * 改成上面那块让开,相对旧版正好是整摞右移一格,而底下那块回到了它真正的位置。
 *
 * 往**右下**而不是别的方向,是因为影子往右下落:上面那块顺着影子的方向浮,露边落在
 * 反方向的左上,不会被影子吃掉。8px 也不能再小 —— 试过 3px,比圆角
 * (`--radius-bn-sm` ≈ 9.5px)还小,露出来那点全在圆角的弧里,看着像渲染毛刺。
 *
 * **只有一档,三重及以上不表达**(2026-09-18 主人拍板:「场景太少,表达很难」)。拖拽
 * 那道闸只放到两层({@link MAX_SOLID_STACK}),三层以上只可能是手写 / 别人分享的皮肤
 * 装进来 —— 那时上面几块会重合在同一档上,画布不为它们另造读法。纵向同理只有一档:
 * 上下总共就 8px 行距(`gap-y-2`),让开 4px 正好是半格,再多就贴住下一行了。
 */
const STACK_OFFSET_X = 8;
const STACK_SINK_Y = 4;

type Card = NonNullable<CardSkinManifest["cards"][CardSkinKind]>;
type Block = Card["blocks"][number];

/** 画布交回去的位置改动。与检查器那几个数字框走同一个口(`setBlockGrid`)。 */
export type SkinCanvasGridHandler = (
	blockId: string,
	patch: { row?: number; column?: number; span?: number; rowSpan?: number },
) => void;

export function SkinCanvas({
	kind,
	card,
	selection,
	onSelect,
	onGrid,
	onAdd,
	onAddCustom,
	onAdopt,
	adoptBusy,
	scene,
	tracks,
	rowHeights,
	onHover,
}: {
	kind: CardSkinKind;
	/** 这张卡的定义。`undefined` = 这套皮肤没定义这种卡(出图时跟着出厂默认)。 */
	card: Card | undefined;
	selection: SkinSelection;
	onSelect: (next: SkinSelection) => void;
	/** 改一个块的位置。**不给 = 这套皮肤只读**,拖拽整个不装。 */
	onGrid?: SkinCanvasGridHandler;
	/** 添一个内置块。**不给 = 这套皮肤只读**,连「添加块」都不该出现。 */
	onAdd?: (builtin: string) => void;
	/** 添一个自定义块(HTML 自己写)。与 `onAdd` 同进同出。 */
	onAddCustom?: () => void;
	/** 接管这种卡(把出厂那张抄进这套皮肤)。**不给 = 只读**。 */
	onAdopt?: () => void;
	/** 出厂皮肤还没读到 —— 接管要抄的就是它,没到手就先禁着。 */
	adoptBusy?: boolean;
	/** 看的是哪一场(`CARD_PREVIEW_SCENES[kind]` 里的 id)。画布只摆这一场会有的块。 */
	scene: string;
	/**
	 * 预览框里**量到的**十二条轨道各多少像素(ADR-0018 决策 3)。给了就照它画,列线与
	 * 真卡一模一样;`null` / 不给 → 退回按清单估(预览还没出来、只读态、jsdom 里都会走
	 * 这条,理由与那 3 个百分点的偏差写在 `canvas-tracks.ts` 的文件头)。
	 */
	tracks?: readonly number[] | null;
	/**
	 * 预览框里**量到的**每一条行轨道多高 px(2026-09-20)。给了就印在行号底下 —— 画布的行
	 * 是等高的示意,而真卡的行高由内容撑,两者差得很远(实测 SC 卡七行 54/31/16/82/39/26/52.8,
	 * 画布按 56 等高画出来是 392 对真卡的 300.8)。
	 *
	 * **只印,不改画法。** 按真高度画那版 2026-09-18 做过又撤回(ADR-0014 决策 6 的 🔗);
	 * 而且列稳行抖 —— 列宽只在改列定义 / 卡宽时变,行高改一个字就变,画布会跟着预览一路跳。
	 */
	rowHeights?: readonly number[] | null;
	/**
	 * 指针指到哪个块了(块 id;`null` = 指走了)。真卡那头会把对应的格子点亮 —— 画布这一侧
	 * 只管报,点亮归预览框(它往框里那份文档上打标记,见 `SkinHtmlFrame` 的 `hotCell`)。
	 */
	onHover?: (blockId: string | null) => void;
}) {
	// 目录是展开还是收着。挂在画布上(不是页面上):它讲的是「这张卡还能添什么」,
	// 换卡种时本来就该跟着收 —— 而画布是按卡种重画的那一层。
	const [picking, setPicking] = useState(false);
	/**
	 * 这一场露面的块。**叠放、层数闸、压行都只看它们** —— 视频封面与图廊在默认皮里占着
	 * 同一片行,拿整张卡去算的话,视频那场的封面会画成「压着别人」而底下其实什么都没有。
	 */
	const visible = useMemo(
		() => (card?.blocks ?? []).filter((b) => blockInScene(kind, b, scene)),
		[card?.blocks, kind, scene],
	);
	const sceneCard = useMemo(
		() => (card ? { ...card, blocks: visible } : undefined),
		[card, visible],
	);
	/** 真行号 → 压后行号。整行没块的行不在表里,那就是被压掉的行(与出图 ④ 同一个函数)。 */
	const rowMap = useMemo(() => rowMapOf(visible.map((b) => b.grid)), [visible]);
	/** 按压后行号落位的块 —— 画布这一层画的、拖的都是它们。 */
	const blocks = useMemo(
		() =>
			visible.map((b) => ({
				...b,
				grid: { ...b.grid, row: rowMap.get(b.grid.row) ?? b.grid.row },
			})),
		[visible, rowMap],
	);
	// 拖出来的是压后行号,存之前换回真行号。`onGrid` 不给时这儿也不给 —— 只读那条路照旧。
	const onRealGrid = useMemo<SkinCanvasGridHandler | undefined>(
		() => (onGrid ? (id, patch) => onGrid(id, realGridPatch(rowMap, patch)) : undefined),
		[onGrid, rowMap],
	);
	const drag = useDrag(onRealGrid, blocks);

	if (!card) {
		return (
			<div className="flex flex-col items-start gap-2.5">
				<EmptyNote>这套皮肤没有定义这种卡 —— 出图时它跟着内置默认皮肤走。</EmptyNote>
				{onAdopt ? (
					<Btn size="sm" variant="outline" disabled={adoptBusy} onClick={onAdopt}>
						{adoptBusy ? "正在读出厂皮肤…" : "接管这种卡"}
					</Btn>
				) : null}
			</div>
		);
	}

	// 压后的行正好是 1..n,再留一行空的当「新起一行」的落点。
	const lastRow = rowMap.size;
	const cols = CARD_SKIN_LIMITS.columns;
	const rows = Array.from({ length: lastRow + 1 }, (_, i) => i + 1);
	const template = canvasTemplate(card, tracks);

	return (
		<div ref={drag.rootRef}>
			{/* 列号。与下面的块层共用同一套 `grid-template-columns`,列线才对得齐。 */}
			<div className="mb-1 grid gap-x-1.5" style={{ gridTemplateColumns: template }}>
				<span />
				{COLS.map((n) => (
					// 这一排也是**量尺**:拖拽要知道每一列在屏幕上占哪一段,而列宽可以不等宽
					// (皮肤能自定义列定义)。列号这排与块那层共用同一份 grid-template-columns,
					// 量它就等于量块那层的列。
					<span
						key={`c${n}`}
						data-canvas-track="column"
						data-canvas-index={n}
						className="text-center font-mono text-bn-2xs text-bn-text-tertiary"
					>
						{n}
					</span>
				))}
			</div>

			<div
				className="grid gap-x-1.5 gap-y-2"
				style={{ gridTemplateColumns: template, gridAutoRows: `${CARD_SKIN_LIMITS.rowHeight}px` }}
			>
				{rows.map((n) => (
					// `flex items-center` 而不是 `self-center`:两者看着一样(字在行中间),但
					// `self-center` 会让这个元素**缩到字那么高**,而它同时是行的量尺 —— 缩过
					// 之后量出来的行带只有十来像素,拖拽就只在每行中间那一条窄缝里认得出行号。
					// 轨道按**压后**行号编(拖拽算出来的就是它),印出来的是**真**行号(检查器
					// 里那个数字对得上)。
					<span
						key={`r${n}`}
						data-canvas-track="row"
						data-canvas-index={n}
						className="flex flex-col items-start justify-center font-mono text-bn-2xs text-bn-text-tertiary"
						style={{ gridColumn: 1, gridRow: n }}
					>
						<span>r{realRowOf(rowMap, n)}</span>
						{/* 真卡里这一行多高。最后那条空行在真卡里**没有对应的轨道**,印一个凭空的
						    数字比不印更糟,所以按下标取、取不到就不画。 */}
						{rowHeights?.[n - 1] === undefined ? null : (
							<span className="text-bn-text-disabled">
								{Math.round(rowHeights[n - 1] as number)}
							</span>
						)}
					</span>
				))}

				{blocks.map((b) => {
					const { below } = stackingOf(sceneCard, b.id);
					return (
						<CanvasBlock
							key={b.id}
							kind={kind}
							block={b}
							onHover={onHover}
							covers={below.length}
							selected={selection?.kind === "block" && selection.id === b.id}
							onSelect={() => onSelect({ kind: "block", id: b.id })}
							drag={onGrid ? drag : undefined}
						/>
					);
				})}

				{/* **落点指示** —— 块 1:1 贴着手走,所以「会落到哪一格」得由另一样东西说。
				    没有它,1:1 跟手就成了「不知道会落在哪」的乱飘。 */}
				{drag.landing ? (
					<div
						data-testid="drop-hint"
						aria-hidden="true"
						className="pointer-events-none rounded-bn-sm border-2 border-bn-pink border-dashed bg-bn-pink/8"
						style={{
							gridColumn: `${drag.landing.column + 1} / span ${drag.landing.span}`,
							gridRow: `${drag.landing.row} / span ${drag.landing.rowSpan ?? 1}`,
						}}
					/>
				) : null}

				<EmptyRow
					cols={cols}
					row={lastRow + 1}
					picking={picking}
					full={!canAddBlock(card)}
					onToggle={onAdd ? () => setPicking((p) => !p) : undefined}
				/>
			</div>

			{picking && onAdd ? (
				<BlockCatalogue
					kind={kind}
					used={new Set(card.blocks.flatMap((b) => (b.kind === "builtin" ? [b.builtin] : [])))}
					onPick={(builtin) => {
						onAdd(builtin);
						setPicking(false);
					}}
					onPickCustom={
						onAddCustom
							? () => {
									onAddCustom();
									setPicking(false);
								}
							: undefined
					}
				/>
			) : null}

			{/* 卡片外框不是块,但也能选中(宽度 / 行列间距 / 列定义 / 外框 CSS 都在它身上)。 */}
			<button
				type="button"
				onClick={() => onSelect({ kind: "frame" })}
				data-bn="chip"
				className={`mt-2.5 flex w-full items-center gap-2 rounded-bn-sm border border-dashed px-3 py-2 text-left transition ${
					selection?.kind === "frame"
						? SELECTED_LANGUAGE
						: "border-bn-inactive/50 text-bn-text-secondary"
				}`}
			>
				<span className="font-semibold text-bn-xs">卡片外框</span>
				<span className="font-mono text-bn-2xs text-bn-text-tertiary">
					宽 {card.width} · 行距 {card.gap?.row ?? 0} · 列距 {card.gap?.column ?? 0}
					{card.columns ? " · 自定义列宽" : ""}
				</span>
			</button>
		</div>
	);
}

/**
 * 最后一行底下那条空行 —— 它既是「网格到这儿为止」的示意,也是**新块的落点**
 * (`addBlock` 就把块放这一行),所以「添加块」这个钮就长在它身上,而不是摆到远处的
 * 工具条上。只读时它退回一条不可点的虚线。
 */
function EmptyRow({
	cols,
	row,
	picking,
	full,
	onToggle,
}: {
	cols: number;
	row: number;
	picking: boolean;
	/** 块数到顶了。话要说全:光把钮禁掉,主人只会以为界面坏了。 */
	full: boolean;
	onToggle?: () => void;
}) {
	const style = { gridColumn: `2 / span ${cols}`, gridRow: row };
	if (!onToggle || full) {
		return (
			<div
				className="flex items-center justify-center rounded-bn-sm border border-bn-inactive/50 border-dashed text-bn-text-tertiary text-bn-xs"
				style={style}
			>
				{full ? `这张卡已经 ${CARD_SKIN_LIMITS.maxBlocks} 块,加不下了` : "空行"}
			</div>
		);
	}
	return (
		<AddButton block style={style} aria-expanded={picking} onClick={onToggle}>
			<Icon.plus size={12} /> 添加块
		</AddButton>
	);
}

/**
 * 能往这张卡里添的内置块目录。分两档摆:**复合块**是今天模板里那一段原样搬,
 * **原子块**是从复合块里抠出来的单件(决策 8)—— 分档是为了让「我要的是整块头部
 * 还是只要头像」一眼能挑。
 *
 * 已经摆上去的照列不禁用:分割线本来就要摆好几条。只标一句「已有」,因为重复摆一张
 * 封面几乎总是手滑。
 */
function BlockCatalogue({
	kind,
	used,
	onPick,
	onPickCustom,
}: {
	kind: CardSkinKind;
	used: Set<string>;
	onPick: (builtin: string) => void;
	onPickCustom?: () => void;
}) {
	const entries = Object.entries(CARD_SKIN_BUILTIN_BLOCKS[kind]);
	const groups: Array<[label: string, items: Array<[string, CardSkinBuiltinBlock]>]> = [
		["复合块", entries.filter(([, m]) => m.atom !== true)],
		["原子块", entries.filter(([, m]) => m.atom === true)],
	];
	return (
		// `<fieldset>` 而不是 `<div role="group">`:同一个语义(读屏器都念「分组」),但原生
		// 元素不用手写 role —— biome 的 useSemanticElements 钉着这条。
		<fieldset
			aria-label="可以添加的块"
			className="mt-2.5 flex min-w-0 flex-col gap-2 rounded-bn-sm border border-bn-border bg-bn-surface-muted p-2.5"
		>
			{groups.map(([label, items]) =>
				items.length === 0 ? null : (
					<div key={label} className="flex flex-col gap-1.5">
						<span className="text-bn-2xs text-bn-text-tertiary">{label}</span>
						<div className="flex flex-wrap gap-1.5">
							{items.map(([name, meta]) => {
								const only = sceneMarkOf(kind, meta);
								return (
									<Btn key={name} size="sm" variant="outline" onClick={() => onPick(name)}>
										{meta.label}
										{/* 独有块在目录里也打标:加进来之后别的场看不见它,先说在前头。 */}
										{only ? (
											<span className="text-bn-2xs text-bn-text-tertiary">{only}</span>
										) : null}
										{used.has(name) ? (
											<span className="text-bn-2xs text-bn-text-tertiary">已有</span>
										) : null}
									</Btn>
								);
							})}
						</div>
					</div>
				),
			)}
			{onPickCustom ? (
				<div className="flex flex-col gap-1.5">
					<span className="text-bn-2xs text-bn-text-tertiary">自己写</span>
					<div className="flex flex-wrap items-center gap-1.5">
						<Btn size="sm" variant="outline" onClick={onPickCustom}>
							自定义块
						</Btn>
						<span className="text-bn-2xs text-bn-text-tertiary">
							一段自己写的 HTML,字段用 {"{up.name}"} 这样的占位符引。
						</span>
					</div>
				</div>
			) : null}
		</fieldset>
	);
}

// ── 拖拽 ──────────────────────────────────────────────────────────────────────

/** 一次拖拽的全程。`base` 是**按下那一刻**的位置 —— 每次移动都从它算起,不然偏移会累加。 */

/** 拖块身,还是拉四条边中的一条。 */
type DragMode = "move" | "left" | "right" | "top" | "bottom";

/** 拉边的四个方向里,哪两个是改行的。 */
const ROW_EDGES = new Set<DragMode>(["top", "bottom"]);

/**
 * 一次拖拽的全程。`base` 是**按下那一刻**的位置 —— 每次移动都从它算起,不然偏移会累加。
 */
interface DragState {
	id: string;
	mode: DragMode;
	base: GridPos;
	/** 按下时指针落在块内的第几格(0 起)。抓着块的右半边拖,块不该整个跳到指针左边去。 */
	grabOffset: number;
	startX: number;
	startY: number;
	/** 按下那一刻块的 transform —— 打断一段回落时,新的拖拽要从**眼前这个位置**接着走。 */
	baseX: number;
	baseY: number;
	/** 超过阈值才算「在拖」;没超过就是点一下,交给 onSelect。 */
	moved: boolean;
	/** 松手会落到的格子(拉边时是改过跨列的那个)。落点指示画的就是它。 */
	landing: GridPos;
	/**
	 * 按下那一刻量好的列 / 行轨道。**拖拽期间不再量第二次。**
	 *
	 * 原来是每次 `pointermove` 现量一遍,写在注释里的理由是「面板宽度可拉、列定义可改」——
	 * 那个判断是错的:**一次拖拽当中这两样都不会变**,而代价是每帧二十多次
	 * `getBoundingClientRect`,还夹在写完 transform 之后读,等于每帧强制两次同步布局。
	 * 这是「不跟手」的第二个来源(第一个是块上那条裸 `transition`)。
	 */
	cols: Track[];
	rows: Track[];
}

/** 手指/鼠标抖这么几像素不算拖 —— 不留这道坎,点选会时不时变成把块挪走一格。 */
const DRAG_THRESHOLD = 4;

/**
 * 回落的弹簧。Apple 那张表里「移动 / 重新定位」是 `damping 1.0 / response 0.4`,
 * 翻到 Motion 就是 `bounce 0` + `duration 0.4`。
 *
 * **不给回弹**:过冲要留给手上真带了动量的动作(甩、扔)。块是被放下的,不是被扔出去的
 * —— 一个轻轻放下却自己弹一下的块,读起来像是没放稳。
 */
const SETTLE = { type: "spring", bounce: 0, duration: 0.4 } as const;

/**
 * 投射用的减速率。Apple 给的 `0.998` 是**滚动**那个手感 —— 在长列表上对,在一张十二列的
 * 网格上太滑了(1000px/s 就投出八列去)。`0.99` 收得快:同样的速度大约多走一列半,一次
 * 有力的甩四五列,刚好是「用力扔得远一点」而不是「一撒手就飞到头」。
 */
const DECELERATION = 0.99;

export interface CanvasDrag {
	/** 画布根节点 —— 量尺(`[data-canvas-track]`)都在它底下。 */
	rootRef: React.RefObject<HTMLDivElement | null>;
	begin: (id: string, base: GridPos, mode: DragMode, e: React.PointerEvent) => void;
	onPointerMove: (e: React.PointerEvent) => void;
	onPointerUp: (e: React.PointerEvent) => void;
	/** 正在拖 / 正在回落的那个块 —— 只有它挂着 x / y 两个 MotionValue。 */
	activeId: string | null;
	x: MotionValue<number>;
	y: MotionValue<number>;
	/** 拉边时块**当场**改跨列(宽度由网格定,补间不了),这里回那个改过的位置。 */
	previewOf: (id: string) => GridPos | undefined;
	/** 松手会落到哪一格 —— 画那块落点指示用。移动中才有。 */
	landing: GridPos | null;
	/** 刚拖完。松手后浏览器还会补一记 click,那一记不该当成「选中」。 */
	consumeClick: () => boolean;
}

/**
 * 量出一条轴上的轨道。**按下时量一次**,一趟拖拽里不再量第二次 —— 面板宽度与列定义在
 * 一次拖拽当中都不会变。原来写的是「每次用时现量」,那个判据是错的,理由与代价(每帧
 * 二十多次 `getBoundingClientRect`,还夹在写完 transform 之后读)见 {@link DragState.cols}。
 */
function tracksOf(root: HTMLElement | null, track: "column" | "row"): Track[] {
	if (!root) return [];
	// `querySelectorAll` 按文档序,列号那排就是 1…12、行号那列就是 r1…rN,顺序天然对。
	return [...root.querySelectorAll<HTMLElement>(`[data-canvas-track="${track}"]`)].map((el) => {
		const r = el.getBoundingClientRect();
		return track === "column" ? { start: r.left, end: r.right } : { start: r.top, end: r.bottom };
	});
}

/**
 * 拖拽的全部行为。
 *
 * **移动是 1:1 跟手的**(Apple:「触摸与内容要一起动」)—— 块跟着指针连续走,不再一格一格
 * 跳;会落到哪一格由一块落点指示说,不靠块自己去对齐。一格一格跳正是上一版「生硬」的根子:
 * 那等于每跨一格就打断一次动画,而 CSS 过渡是打断不了的,于是它既不跟手也没有惯性。
 *
 * **拉边仍是离散的**,而且是**当场**改:块的宽度由网格轨道定,transform 补不了宽度
 * (拿 `scaleX` 顶会把字挤扁)。离散 + 即时读起来是「干脆」,不是生硬 —— 生硬的是有延迟
 * 的离散。
 *
 * 松手交给弹簧,并把**手上的速度递过去**(Apple 说的那道接缝:拖与弹之间不该看得出接口),
 * 落点还按**投射出去会停到哪**算,而不是松手时块在哪。
 */
/**
 * `blocks` 只给**叠放层数那道闸**用:落点会让同一片格子上「一定同时出现」的块超过
 * {@link MAX_SOLID_STACK} 就不接受,块停在最后一个合法位置 —— 与「顶到边就停住」同一条形状。
 */
function useDrag(onGrid: SkinCanvasGridHandler | undefined, blocks?: readonly Block[]): CanvasDrag {
	const rootRef = useRef<HTMLDivElement>(null);
	const x = useMotionValue(0);
	const y = useMotionValue(0);
	/**
	 * **真值在 ref 里,state 只用来触发重画。**
	 *
	 * 一开始把这些写进 `setDrag(d => …)` 的 updater 里,踩了个不响的坑:那个回调跑在
	 * render 阶段,不是事件处理里 —— 在它里头 `x.set()`、调 `onGrid` 都是在渲染中做副作用,
	 * React 可以随时重跑它、也可以丢掉一次。表现是拖拽整个没反应,而代码看着完全正常。
	 */
	const dragRef = useRef<DragState | null>(null);
	const [, bump] = useState(0);
	const [settling, setSettling] = useState<string | null>(null);
	const dragged = useRef(false);
	const velocity = useRef(createVelocityTracker());
	/** 松手那一刻块在屏幕上的位置 —— 提交之后要靠它把 transform 反推回来(FLIP)。 */
	const releasedRect = useRef<DOMRect | null>(null);
	const pending = useRef<{ id: string; v: Velocity } | null>(null);

	const redraw = useCallback(() => bump((n) => n + 1), []);

	/**
	 * 这个落点收不收。**预览与松手必须走同一个判据** —— 只拦预览的话,拖的时候看着被挡住,
	 * 松手却飞过去叠成第四层了。
	 */
	const blocksRef = useRef(blocks);
	blocksRef.current = blocks;
	const accepts = useCallback((id: string, at: GridPos) => {
		const all = blocksRef.current;
		if (!all) return true;
		const me = all.find((b) => b.id === id);
		const peers = all.filter((b) => b.id !== id).map((b) => ({ grid: b.grid, solid: !b.showIf }));
		return solidStackDepth(at, !me?.showIf, peers) <= MAX_SOLID_STACK;
	}, []);

	const begin = useCallback(
		(id: string, base: GridPos, mode: DragMode, e: React.PointerEvent) => {
			if (!onGrid || e.button !== 0) return;
			// 打断一段回落:停在眼前这个位置接着拖,别跳回目标值(Apple 的第三条,也是最
			// 重要的那条 —— 动画要能被一把抓住)。
			x.stop();
			y.stop();
			const cols = tracksOf(rootRef.current, "column");
			const rows = tracksOf(rootRef.current, "row");
			const at = trackAt(cols, e.clientX);
			e.currentTarget.setPointerCapture?.(e.pointerId);
			velocity.current = createVelocityTracker();
			velocity.current.add(e.clientX, e.clientY, e.timeStamp);
			setSettling(null);
			dragRef.current = {
				id,
				mode,
				base,
				grabOffset: mode === "move" ? Math.max(0, at - base.column) : 0,
				startX: e.clientX,
				startY: e.clientY,
				baseX: x.get(),
				baseY: y.get(),
				moved: false,
				landing: base,
				cols,
				rows,
			};
			redraw();
		},
		[onGrid, x, y, redraw],
	);

	const onPointerMove = useCallback(
		(e: React.PointerEvent) => {
			const d = dragRef.current;
			if (!d) return;
			const { clientX, clientY, timeStamp } = e;
			velocity.current.add(clientX, clientY, timeStamp);
			if (
				!d.moved &&
				Math.abs(clientX - d.startX) <= DRAG_THRESHOLD &&
				Math.abs(clientY - d.startY) <= DRAG_THRESHOLD
			) {
				return;
			}
			// 1:1 那一半**先做,而且只碰 MotionValue** —— 它直接写 DOM,不经过 React。
			// 下面那些是给落点指示用的,慢一帧也不影响跟手。
			if (d.mode === "move") {
				x.set(d.baseX + clientX - d.startX);
				y.set(d.baseY + clientY - d.startY);
			}
			const next =
				d.mode === "move"
					? {
							...d.base,
							...movedGrid(
								d.base,
								{ column: trackAt(d.cols, clientX), row: trackAt(d.rows, clientY) },
								d.grabOffset,
							),
						}
					: ROW_EDGES.has(d.mode)
						? {
								...d.base,
								...resizedRows(d.base, d.mode as "top" | "bottom", rowAt(d.rows, clientY)),
							}
						: {
								...d.base,
								...resizedGrid(d.base, d.mode as "left" | "right", trackAt(d.cols, clientX)),
							};
			// **落点没变就不重画。** 每帧一次 `setState` 会把整张画布(可能四十个块)重渲染一遍,
			// 主线程被占满之后连 motion 的那一帧也跟着晚 —— 于是 1:1 写得再对也跟不上手。
			// 跨格才重画,把每帧一次降成每格一次。
			// 层数闸:落不下去就**保持上一个合法落点**(块顶到边就停住,同一条形状)。
			if (!accepts(d.id, next)) {
				d.moved = true;
				return;
			}
			const same =
				d.moved &&
				next.row === d.landing.row &&
				next.column === d.landing.column &&
				next.span === d.landing.span &&
				next.rowSpan === d.landing.rowSpan;
			d.landing = next;
			d.moved = true;
			if (!same) redraw();
		},
		[x, y, redraw, accepts],
	);

	const onPointerUp = useCallback(
		(e: React.PointerEvent) => {
			const d = dragRef.current;
			dragRef.current = null;
			if (!d) return;
			if (!d.moved || !onGrid) return redraw();
			dragged.current = true;
			if (d.mode !== "move") {
				// 拉边已经当场改完了,这里只把它落到清单里,没有要弹的东西。
				// **只交它改动的那个轴** —— 把四个数一起交出去的话,拉一次宽会顺手把
				// `rowSpan` 也写进 JSON(哪怕没动过),存量皮肤一拉边就多出一堆 `rowSpan: 1`。
				onGrid(
					d.id,
					ROW_EDGES.has(d.mode)
						? { row: d.landing.row, rowSpan: d.landing.rowSpan }
						: { column: d.landing.column, span: d.landing.span },
				);
				return redraw();
			}
			// 落点按**甩出去会停到哪**算,不是松手时块在哪(Apple 的动量投射)。
			const v = velocity.current.velocity(e.timeStamp);
			const column = trackAt(d.cols, e.clientX + project(v.x, DECELERATION));
			const row = trackAt(d.rows, e.clientY + project(v.y, DECELERATION));
			releasedRect.current =
				rootRef.current?.querySelector(`[data-block-id="${d.id}"]`)?.getBoundingClientRect() ??
				null;
			pending.current = { id: d.id, v };
			setSettling(d.id);
			// 动量能把落点投到一格开外,所以**投完还要再过一次闸** —— 只拦拖的过程,
			// 甩一下照样能叠成第四层。过不了就退回最后一个合法落点。
			const thrown = { ...d.base, ...movedGrid(d.base, { column, row }, d.grabOffset) };
			const to = accepts(d.id, thrown) ? thrown : d.landing;
			onGrid(d.id, { row: to.row, column: to.column });
		},
		[onGrid, redraw, accepts],
	);

	// 提交之后把 transform 反推回**松手那一刻的位置**,再让弹簧把它送到 0 —— 这样块是从
	// 手底下接着走的,而不是先跳到新格子再动。速度原样递给弹簧,拖与弹之间才没有接缝。
	useLayoutEffect(() => {
		const job = pending.current;
		const from = releasedRect.current;
		if (!job || !from) return;
		pending.current = null;
		releasedRect.current = null;
		const node = rootRef.current?.querySelector(`[data-block-id="${job.id}"]`);
		if (!node) {
			setSettling(null);
			return;
		}
		const to = node.getBoundingClientRect();
		// 反推:先无动画地回到眼前那个位置。
		x.jump(from.left - to.left + x.get());
		y.jump(from.top - to.top + y.get());
		if (prefersReducedMotion()) {
			x.jump(0);
			y.jump(0);
			setSettling(null);
			return;
		}
		void Promise.all([
			animate(x, 0, { ...SETTLE, velocity: job.v.x }),
			animate(y, 0, { ...SETTLE, velocity: job.v.y }),
		]).then(() => setSettling(null));
	});

	return {
		rootRef,
		begin,
		onPointerMove,
		onPointerUp,
		activeId: dragRef.current?.id ?? settling,
		x,
		y,
		previewOf: (id) => {
			const d = dragRef.current;
			return d?.id === id && d.moved && d.mode !== "move" ? d.landing : undefined;
		},
		landing:
			dragRef.current?.moved && dragRef.current.mode === "move" ? dragRef.current.landing : null,
		consumeClick: () => {
			const was = dragged.current;
			dragged.current = false;
			return was;
		},
	};
}

function ResizeHandle({
	side,
	blockId,
	onDown,
}: {
	side: DragMode & ("left" | "right" | "top" | "bottom");
	blockId: string;
	onDown: (e: React.PointerEvent) => void;
}) {
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: 指针专用把手,键盘那条路在检查器
		<span
			aria-hidden="true"
			data-testid={`resize-${side}-${blockId}`}
			onPointerDown={(e) => {
				// ⚠️ 必须拦下冒泡:不拦的话这一记会接着落到块身上,把刚开的「拉边」当场
				// 覆盖成「移动」—— 表现是拉边完全没反应,而两边的代码看着都对。
				e.stopPropagation();
				onDown(e);
			}}
			className={`absolute ${
				ROW_EDGES.has(side)
					? `inset-x-0 h-2.5 cursor-row-resize ${side === "top" ? "top-0" : "bottom-0"}`
					: `inset-y-0 w-2.5 cursor-col-resize ${side === "left" ? "left-0" : "right-0"}`
			}`}
		/>
	);
}

function CanvasBlock({
	kind,
	block,
	covers,
	selected,
	onSelect,
	onHover,
	drag,
}: {
	kind: CardSkinKind;
	block: Block;
	/** 它压着几个块。0 = 没压着谁(被别人压着不影响它怎么画,它停在自己的格子上)。 */
	covers: number;
	selected: boolean;
	onSelect: () => void;
	/** 指针进 / 出这一块。真卡那头按它点亮对应的格子。 */
	onHover?: (blockId: string | null) => void;
	/** 不给 = 只读,拖拽整个不装(把手也不画)。 */
	drag?: CanvasDrag;
}) {
	const meta = block.kind === "builtin" ? CARD_SKIN_BUILTIN_BLOCKS[kind][block.builtin] : undefined;
	const label = meta?.label ?? (block.kind === "custom" ? "自定义块" : block.builtin);
	const sceneMark = meta ? sceneMarkOf(kind, meta) : null;
	// 拉边是**当场**改的(块的宽度由网格轨道定,transform 补不了),所以拉边时格子就画在
	// 改过的位置上;移动则相反 —— 块靠 transform 贴着手走,格子始终停在原处,会落到哪
	// 由落点指示说。
	const shown = drag?.previewOf(block.id) ?? block.grid;
	const { column, span, row } = shown;
	const rowSpan = shown.rowSpan;
	const z = block.grid.z;
	// 正在拖 / 正在回落的那个块才挂 x / y —— 别的块一个 transform 都不该多出来。
	const live = drag?.activeId === block.id;
	const floating = covers > 0;
	const dx = floating ? STACK_OFFSET_X : 0;
	const dy = floating ? STACK_SINK_Y : 0;

	return (
		<motion.button
			data-block-id={block.id}
			type="button"
			onClick={() => {
				// 松手后浏览器还会补一记 click —— 刚拖完的那一记不是「选中」。
				if (drag?.consumeClick()) return;
				onSelect();
			}}
			onPointerEnter={onHover ? () => onHover(block.id) : undefined}
			onPointerLeave={onHover ? () => onHover(null) : undefined}
			{...(drag
				? {
						onPointerDown: (e: React.PointerEvent) => drag.begin(block.id, block.grid, "move", e),
						onPointerMove: drag.onPointerMove,
						onPointerUp: drag.onPointerUp,
						onPointerCancel: drag.onPointerUp,
						onLostPointerCapture: drag.onPointerUp,
					}
				: {})}
			aria-pressed={selected}
			data-bn={selected ? "chip chip-active" : "chip"}
			// ⚠️ **过渡属性逐条列,绝不用裸 `transition`** —— Tailwind 那个类**含 `transform`**,
			// 于是 motion 每帧写进去的 translate 又被 CSS 加上 150ms 过渡,块永远在追一个
			// 150ms 之前的位置。1:1 的代码全对,被这一个类整个抵消掉,而且看不出来。
			className={`relative flex flex-col justify-between overflow-hidden rounded-bn-sm border px-2.5 py-2 text-left transition-[border-color,background-color,box-shadow] duration-150 ${
				drag ? "cursor-grab touch-none active:cursor-grabbing" : ""
			} ${
				// **压着别人的块浮起来** —— 影子走 `shadow-bn-elev` 那个 @utility,不写死值
				// (shadow 族不进 @theme,换肤时靠变量活着;理由在 theme.css 那段注释里)。
				floating ? "shadow-bn-elev" : ""
			} ${
				selected
					? // **整句吃库里那句选中语汇**,别手抄(`packages/ui/README.md` 明写)。
						// 它的粉调底是 color-mix 落在 surface 上出的**不透明**色 —— 初版这儿
						// 抄了个 `bg-bn-pink/6`,那是混 transparent 的纱:选中一个压着别人的块,
						// 底下那块的字直接透上来、两块的字叠死(2026-09-16 主人报的)。同一个
						// 雷 Subs 分组胶囊踩过,语汇常量就是为它立的。
						// `ring` 是画布自己加的:块摆得密,选中的那个要一眼找得到。
						`${SELECTED_LANGUAGE} ring-3 ring-bn-pink/18`
					: // 压着别人时底换成**不透明**的:半透明叠半透明,底下那块的字会透上来
						// (「别把半透明摞在半透明上」)。没压着谁的照旧留一点通透。
						floating
						? "border-bn-border bg-bn-surface"
						: "border-bn-border bg-bn-surface/90"
			}`}
			style={{
				// 画布多出一列行号,所以 +1;`span` 直接就是皮肤 JSON 里那个数。
				gridColumn: `${column + 1} / span ${span}`,
				gridRow: `${row} / span ${rowSpan ?? 1}`,
				// 1:1 跟手与回落都走这两个 MotionValue。弹簧天生从**当前值**出发、能被一把
				// 抓停,这正是 CSS 过渡给不了的 —— 上一版的生硬就出在那儿。
				...(live ? { x: drag.x, y: drag.y } : {}),
				// 拖着的块压在所有层次之上。用「层次上限 + 1」而不是写死一个数:它跟着
				// `layer` 的上限走,将来上限改了这儿不用记得跟。
				...(live ? { zIndex: CARD_SKIN_LIMITS.layer.max + 1 } : {}),
				// **压着别人的块往右下让开一格。** 完全盖住时,露出来的那条左边缘是底下那块
				// 在画布上唯一的痕迹 —— 影子只说明「上面这块浮着」,说不出「底下还有一张」。
				// 为什么动上面那块而不是下面那块,见上面那段。
				...(dx ? { left: dx } : {}),
				...(dy ? { top: dy } : {}),

				// 层次照抄皮肤那个数,与渲染器同一条规矩(不写就不写)。
				//
				// ⚠️ 这不归「叠放层级分层表」管:那张表排的是**应用自己的浮层**(页头、遮罩、
				// 弹窗),而这儿是**用户数据** —— 皮肤作者填的第几层,范围由 `layer` 上限锁着。
				// 两套东西共用一个 CSS 属性,但不该共用一张表。
				...(z ? { zIndex: z } : {}),
			}}
		>
			{drag ? (
				<>
					<ResizeHandle
						side="left"
						blockId={block.id}
						onDown={(e) => drag.begin(block.id, block.grid, "left", e)}
					/>
					<ResizeHandle
						side="right"
						blockId={block.id}
						onDown={(e) => drag.begin(block.id, block.grid, "right", e)}
					/>
					{/* 纵向两条**只画在「跨行是真高度」的块上**(封面这种单张图,2026-09-18
					    主人拍板)。别的块的高度由内容撑 —— 标题一行还是三行由真实数据说了算
					    —— 给个拉得动、拉完出图纹丝不动的把手,只会让人以为自己改坏了什么
					    (主人 09-18 就是这么撞上的)。跨行那个数字在检查器里照旧改得动,
					    它对这些块是一句给画布看的声明。
					    另:纵向两条**画在角落之外** —— 四条边在角上重叠时后挂的会盖住先挂的,
					    左右两条先画,所以角上那 10×10 归左右,拉宽比拉高常用。 */}
					{meta?.heightFromRows ? (
						<>
							<ResizeHandle
								side="top"
								blockId={block.id}
								onDown={(e) => drag.begin(block.id, block.grid, "top", e)}
							/>
							<ResizeHandle
								side="bottom"
								blockId={block.id}
								onDown={(e) => drag.begin(block.id, block.grid, "bottom", e)}
							/>
						</>
					) : null}
				</>
			) : null}
			<span className="flex min-w-0 items-center gap-1.5">
				<Icon.drag size={12} className="shrink-0 text-bn-text-tertiary" />
				<span className="truncate font-semibold text-bn-sm text-bn-text-primary">{label}</span>
				<BlockKindPill block={block} atom={meta?.atom === true} />
				{block.showIf ? (
					<Pill subtle color="var(--color-bn-warn)">
						showIf
					</Pill>
				) : null}
				{/* 独有块挂一句「图文专属」:它只在这一场露面,换一场就整个不见 —— 得让人知道
				    它不是没了,是不属于那一场。共有块什么都不挂。 */}
				{sceneMark ? (
					<Pill subtle color="var(--color-bn-purple)">
						{sceneMark}
					</Pill>
				) : null}
			</span>
			{/* 这行只说**身份与几何**。叠没叠不写在这儿 —— 一个计数说不出谁在上、被盖的
			    是谁,而那正是看的人要问的(主人 2026-09-15 指出「太粗糙」)。改由深浅说:
			    压着别人的浮起来,被压住的往左上露一条边。 */}
			<span className="truncate font-mono text-bn-2xs text-bn-text-tertiary">
				{block.id} · {column}–{column + span - 1}
				{z ? ` · z${z}` : ""}
			</span>
		</motion.button>
	);
}

/**
 * 独有块的标:「图文专属」。属于好几场的写成「视频 / 图文专属」;共有块(目录没标
 * `scenes`)是 `null`。场名照 `CARD_PREVIEW_SCENES` 印,目录里指着不存在的场由 internal
 * 那边的守卫拦,这儿不再报。
 */
function sceneMarkOf(kind: CardSkinKind, meta: CardSkinBuiltinBlock): string | null {
	if (!meta.scenes) return null;
	const labels = meta.scenes.map(
		(id) => CARD_PREVIEW_SCENES[kind].find((sc) => sc.id === id)?.label ?? id,
	);
	return `${labels.join(" / ")}专属`;
}

/** 三档来历:复合内置块 / 原子内置块 / 自定义块。分档是为了让「这块能不能改内容」一眼看出来。 */
function BlockKindPill({ block, atom }: { block: Block; atom: boolean }) {
	if (block.kind === "custom") {
		return (
			<Pill subtle color="var(--color-bn-pink)">
				自定义
			</Pill>
		);
	}
	return atom ? (
		<Pill subtle color="var(--color-bn-purple)">
			原子
		</Pill>
	) : (
		<Pill subtle color="var(--color-bn-blue)">
			内置
		</Pill>
	);
}
