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
 */

import type { CardSkinKind, CardSkinManifest } from "@bilibili-notify/contract";
import { CARD_SKIN_BUILTIN_BLOCKS, CARD_SKIN_LIMITS } from "@bilibili-notify/internal/constants";
import { EmptyNote, Icon, Pill } from "@bilibili-notify/ui";

/** 列号 1…12。算一次就够 —— 列数是固定的(决策 6)。 */
const COLS = Array.from({ length: CARD_SKIN_LIMITS.columns }, (_, i) => i + 1);

/** 画布上选中的东西:某个块,或者卡片外框(它不是块,但也能选)。 */
export type SkinSelection = { kind: "block"; id: string } | { kind: "frame" } | null;

type Card = NonNullable<CardSkinManifest["cards"][CardSkinKind]>;
type Block = Card["blocks"][number];

export function SkinCanvas({
	kind,
	card,
	selection,
	onSelect,
}: {
	kind: CardSkinKind;
	/** 这张卡的定义。`undefined` = 这套皮肤没定义这种卡(出图时跟着出厂默认)。 */
	card: Card | undefined;
	selection: SkinSelection;
	onSelect: (next: SkinSelection) => void;
}) {
	if (!card) {
		return (
			<EmptyNote>
				这套皮肤没有定义这种卡 —— 出图时它跟着内置默认皮肤走。想改它,先在检查器里「接管这种卡」。
			</EmptyNote>
		);
	}

	const blocks = card.blocks;
	// 画到最后一个块所在的行,再留一行空的当「新起一行」的落点。
	const lastRow = blocks.reduce((m, b) => Math.max(m, b.grid.row + (b.grid.rowSpan ?? 1) - 1), 0);
	const cols = CARD_SKIN_LIMITS.columns;
	const rows = Array.from({ length: lastRow + 1 }, (_, i) => i + 1);

	return (
		<div>
			{/* 列号。与下面的块层共用同一套 `grid-template-columns`,列线才对得齐。 */}
			<div
				className="mb-1 grid gap-x-1.5"
				style={{ gridTemplateColumns: `28px repeat(${cols}, minmax(0, 1fr))` }}
			>
				<span />
				{COLS.map((n) => (
					<span key={`c${n}`} className="text-center font-mono text-bn-2xs text-bn-text-tertiary">
						{n}
					</span>
				))}
			</div>

			<div
				className="grid gap-x-1.5 gap-y-2"
				style={{
					gridTemplateColumns: `28px repeat(${cols}, minmax(0, 1fr))`,
					gridAutoRows: "56px",
				}}
			>
				{rows.map((n) => (
					<span
						key={`r${n}`}
						className="self-center font-mono text-bn-2xs text-bn-text-tertiary"
						style={{ gridColumn: 1, gridRow: n }}
					>
						r{n}
					</span>
				))}

				{blocks.map((b) => (
					<CanvasBlock
						key={b.id}
						kind={kind}
						block={b}
						selected={selection?.kind === "block" && selection.id === b.id}
						onSelect={() => onSelect({ kind: "block", id: b.id })}
					/>
				))}

				<div
					className="flex items-center justify-center rounded-bn-sm border border-bn-inactive/50 border-dashed text-bn-text-tertiary text-bn-xs"
					style={{ gridColumn: `2 / span ${cols}`, gridRow: lastRow + 1 }}
				>
					空行 —— 用「添加块」往这儿放
				</div>
			</div>

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

function CanvasBlock({
	kind,
	block,
	selected,
	onSelect,
}: {
	kind: CardSkinKind;
	block: Block;
	selected: boolean;
	onSelect: () => void;
}) {
	const meta = block.kind === "builtin" ? CARD_SKIN_BUILTIN_BLOCKS[kind][block.builtin] : undefined;
	const label = meta?.label ?? (block.kind === "custom" ? "自定义块" : block.builtin);
	const { column, span, row, rowSpan } = block.grid;

	return (
		<button
			type="button"
			onClick={onSelect}
			aria-pressed={selected}
			data-bn={selected ? "chip chip-active" : "chip"}
			className={`flex flex-col justify-between overflow-hidden rounded-bn-sm border px-2.5 py-2 text-left transition ${
				selected
					? "border-bn-pink bg-bn-pink/6 ring-3 ring-bn-pink/18"
					: "border-bn-border bg-bn-surface/90"
			}`}
			style={{
				// 画布多出一列行号,所以 +1;`span` 直接就是皮肤 JSON 里那个数。
				gridColumn: `${column + 1} / span ${span}`,
				gridRow: `${row} / span ${rowSpan ?? 1}`,
			}}
		>
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
			</span>
		</button>
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
