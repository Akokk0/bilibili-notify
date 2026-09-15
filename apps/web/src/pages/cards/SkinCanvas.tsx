/**
 * 编辑器的网格画布(ADR-0014 决策 6 / 20)。
 *
 * **它是示意图,不是所见即所得** —— 编辑器最大的一个取舍,原因是硬的:预览走 sandbox
 * iframe 且不给 `allow-same-origin`(决策 22 的安全底线),父页面读不到里面每个块的位置,
 * 也就画不出「叠在真卡上的选框」。所以这里画的是**行列关系**:12 列等宽格子、行等高,
 * 块按 `grid.column` / `grid.span` 落位。真卡里行高随内容撑,这点在副标题里明说。
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
 */

import type { CardSkinKind, CardSkinManifest } from "@bilibili-notify/contract";
import type { CardSkinBuiltinBlock } from "@bilibili-notify/internal";
import { CARD_SKIN_BUILTIN_BLOCKS, CARD_SKIN_LIMITS } from "@bilibili-notify/internal/constants";
import { AddButton, Btn, EmptyNote, Icon, Pill } from "@bilibili-notify/ui";
import { animate, type MotionValue, motion, useMotionValue } from "motion/react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
	createVelocityTracker,
	type GridPos,
	movedGrid,
	prefersReducedMotion,
	project,
	resizedGrid,
	type Track,
	trackAt,
	type Velocity,
} from "./canvas-drag";
import { canAddBlock, columnsOf, overlappingBlocks } from "./skin-draft-ops";

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

type Card = NonNullable<CardSkinManifest["cards"][CardSkinKind]>;
type Block = Card["blocks"][number];

/** 画布交回去的位置改动。与检查器那几个数字框走同一个口(`setBlockGrid`)。 */
export type SkinCanvasGridHandler = (
	blockId: string,
	patch: { row?: number; column?: number; span?: number },
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
}) {
	// 目录是展开还是收着。挂在画布上(不是页面上):它讲的是「这张卡还能添什么」,
	// 换卡种时本来就该跟着收 —— 而画布是按卡种重画的那一层。
	const [picking, setPicking] = useState(false);
	const drag = useDrag(onGrid);

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

	const blocks = card.blocks;
	// 画到最后一个块所在的行,再留一行空的当「新起一行」的落点。
	const lastRow = blocks.reduce((m, b) => Math.max(m, b.grid.row + (b.grid.rowSpan ?? 1) - 1), 0);
	const cols = CARD_SKIN_LIMITS.columns;
	const rows = Array.from({ length: lastRow + 1 }, (_, i) => i + 1);
	const template = templateOf(card);

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
				style={{ gridTemplateColumns: template, gridAutoRows: "56px" }}
			>
				{rows.map((n) => (
					// `flex items-center` 而不是 `self-center`:两者看着一样(字在行中间),但
					// `self-center` 会让这个元素**缩到字那么高**,而它同时是行的量尺 —— 缩过
					// 之后量出来的行带只有十来像素,拖拽就只在每行中间那一条窄缝里认得出行号。
					<span
						key={`r${n}`}
						data-canvas-track="row"
						data-canvas-index={n}
						className="flex items-center font-mono text-bn-2xs text-bn-text-tertiary"
						style={{ gridColumn: 1, gridRow: n }}
					>
						r{n}
					</span>
				))}

				{/* **空行的旁注** —— 空行在画布上留着(排版时好用),出图那头会被压掉。两边就此
				    对不上一件事,不说出来只能靠撞见。真要留白就摆一个空白块:块占着那一行,
				    压行就收不走它。 */}
				{emptyRows(blocks, lastRow).map((n) => (
					<div
						key={`e${n}`}
						data-testid="empty-row-note"
						className="pointer-events-none flex items-center justify-center text-bn-2xs text-bn-text-tertiary"
						style={{ gridColumn: `2 / span ${cols}`, gridRow: n }}
					>
						空行 · 出图时收掉,要留白就摆一个空白块
					</div>
				))}

				{blocks.map((b) => (
					<CanvasBlock
						key={b.id}
						kind={kind}
						block={b}
						overlaps={overlappingBlocks(card, b.id).length}
						selected={selection?.kind === "block" && selection.id === b.id}
						onSelect={() => onSelect({ kind: "block", id: b.id })}
						drag={onGrid ? drag : undefined}
					/>
				))}

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
						? "border-bn-pink bg-bn-pink/8 text-bn-pink"
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
 * 1..`lastRow` 里**没有块占着**的行。占着 ≠ 起在:跨行的块把中间那几行也占着,漏掉它们
 * 会把「被封面盖住的行」说成空行。最后那一行(`lastRow + 1`)是「添加块」的落点,不算。
 *
 * 与出图那头压行看的是同一件事(`render-skin` 的 ④),这边标出来的就是那边会收掉的。
 */
function emptyRows(blocks: Block[], lastRow: number): number[] {
	const taken = new Set<number>();
	for (const b of blocks) {
		for (let r = b.grid.row; r < b.grid.row + (b.grid.rowSpan ?? 1); r++) taken.add(r);
	}
	return Array.from({ length: lastRow }, (_, i) => i + 1).filter((n) => !taken.has(n));
}

/**
 * 画布上 12 列各占多宽。**定宽列按它在卡宽里的占比换算成 fr** —— 画布宽度与卡宽不是
 * 一回事,照抄 `px` 会让比例整个失真(430 宽的上舰卡摊在 700 宽的面板里,那四列定宽
 * 会显得只有真实占比的六成)。换成占比就与容器宽度无关了。
 */
function templateOf(card: Card): string {
	const cols = columnsOf(card);
	const fixed = cols.reduce((s, c) => s + ("px" in c ? c.px : 0), 0);
	const free = Math.max(0, card.width - fixed);
	const frTotal = cols.reduce((s, c) => s + ("px" in c ? 0 : c.fr), 0);
	const parts = cols.map((c) => {
		const share = "px" in c ? c.px : frTotal > 0 ? (free * c.fr) / frTotal : 0;
		// 0 会让那一列整个塌掉、块看不见;留 1 至少画得出来(这种包本来也过不了装包门)。
		return `minmax(0, ${Math.max(share, 1).toFixed(3)}fr)`;
	});
	return `28px ${parts.join(" ")}`;
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
							{items.map(([name, meta]) => (
								<Btn key={name} size="sm" variant="outline" onClick={() => onPick(name)}>
									{meta.label}
									{used.has(name) ? (
										<span className="text-bn-2xs text-bn-text-tertiary">已有</span>
									) : null}
								</Btn>
							))}
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

type DragMode = "move" | "left" | "right";

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
 * 量出一条轴上的轨道。**每次用时现量**:面板宽度可拉、列定义可改,存一份下来迟早是过期
 * 的那份;而量一次是十来个 `getBoundingClientRect`,一趟拖拽里这点开销不值得换正确性。
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
function useDrag(onGrid: SkinCanvasGridHandler | undefined): CanvasDrag {
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
			const column = trackAt(d.cols, clientX);
			const next =
				d.mode === "move"
					? {
							...d.base,
							...movedGrid(d.base, { column, row: trackAt(d.rows, clientY) }, d.grabOffset),
						}
					: { ...d.base, ...resizedGrid(d.base, d.mode, column) };
			// **落点没变就不重画。** 每帧一次 `setState` 会把整张画布(可能四十个块)重渲染一遍,
			// 主线程被占满之后连 motion 的那一帧也跟着晚 —— 于是 1:1 写得再对也跟不上手。
			// 跨格才重画,把每帧一次降成每格一次。
			const same =
				d.moved &&
				next.row === d.landing.row &&
				next.column === d.landing.column &&
				next.span === d.landing.span;
			d.landing = next;
			d.moved = true;
			if (!same) redraw();
		},
		[x, y, redraw],
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
				onGrid(d.id, { column: d.landing.column, span: d.landing.span });
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
			onGrid(d.id, movedGrid(d.base, { column, row }, d.grabOffset));
		},
		[onGrid, redraw],
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
	side: "left" | "right";
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
			className={`absolute inset-y-0 w-2.5 cursor-col-resize ${side === "left" ? "left-0" : "right-0"}`}
		/>
	);
}

function CanvasBlock({
	kind,
	block,
	overlaps,
	selected,
	onSelect,
	drag,
}: {
	kind: CardSkinKind;
	block: Block;
	/** 和几个块占着同一片格子。0 = 没叠。 */
	overlaps: number;
	selected: boolean;
	onSelect: () => void;
	/** 不给 = 只读,拖拽整个不装(把手也不画)。 */
	drag?: CanvasDrag;
}) {
	const meta = block.kind === "builtin" ? CARD_SKIN_BUILTIN_BLOCKS[kind][block.builtin] : undefined;
	const label = meta?.label ?? (block.kind === "custom" ? "自定义块" : block.builtin);
	// 拉边是**当场**改的(块的宽度由网格轨道定,transform 补不了),所以拉边时格子就画在
	// 改过的位置上;移动则相反 —— 块靠 transform 贴着手走,格子始终停在原处,会落到哪
	// 由落点指示说。
	const shown = drag?.previewOf(block.id) ?? block.grid;
	const { column, span } = shown;
	const { row } = shown;
	const rowSpan = block.grid.rowSpan;
	const z = block.grid.z;
	// 正在拖 / 正在回落的那个块才挂 x / y —— 别的块一个 transform 都不该多出来。
	const live = drag?.activeId === block.id;

	return (
		<motion.button
			data-block-id={block.id}
			type="button"
			onClick={() => {
				// 松手后浏览器还会补一记 click —— 刚拖完的那一记不是「选中」。
				if (drag?.consumeClick()) return;
				onSelect();
			}}
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
				selected
					? "border-bn-pink bg-bn-pink/6 ring-3 ring-bn-pink/18"
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
			</span>
			<span className="truncate font-mono text-bn-2xs text-bn-text-tertiary">
				{block.id} · {column}–{column + span - 1}
				{z ? ` · z${z}` : ""}
				{/* 叠了就说一句:下面那块被盖住了,不标出来没人知道它还在。**不是警告** ——
				    重叠是特性(靠 showIf 互斥地占同一格也是正当用法),所以走的是中性的灰字,
				    不是红条。 */}
				{overlaps > 0 ? ` · 叠${overlaps}` : ""}
			</span>
		</motion.button>
	);
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
