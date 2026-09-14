/**
 * 编辑器的检查器(ADR-0014 决策 20 / 21)—— 画布上选中什么,这里就编什么。
 *
 * 这一版只有**位置**那一节(行 / 起始列 / 跨列 / 跨行)。内容、样式旋钮、高级 CSS、
 * showIf 各自成片挨着往里填;先把「选中 → 改 → 预览跟着动」这条回路打通,它是后面每一
 * 片都要挂上去的那根梁。
 *
 * 数字框**不拒越界只夹回边界**(见 `skin-draft-ops.ts` 的 `clampInt`):这几个框是边敲
 * 边过的,拒了的话想敲两位数就永远敲不出第一位。
 */

import type { CardSkinKind, CardSkinManifest } from "@bilibili-notify/contract";
import type { CardSkinColumn } from "@bilibili-notify/internal";
import { CARD_SKIN_LIMITS } from "@bilibili-notify/internal/constants";
import { Btn, ConfirmDialog, EmptyNote, Icon, Pill, Section, Toggle } from "@bilibili-notify/ui";
import { useState } from "react";
import { Picker, TNum } from "../../components/forms";
import type { SkinSelection } from "./SkinCanvas";
import { blockOf, cardOf, columnsOf, gridLimits } from "./skin-draft-ops";

type Card = NonNullable<CardSkinManifest["cards"][CardSkinKind]>;
type Grid = Card["blocks"][number]["grid"];
/** 外框那几个数。`gap` 在清单里是个对象,控件上是两个独立的框,所以拍平成两项。 */
export type FramePatch = { width?: number; gapRow?: number; gapColumn?: number };

export function SkinInspector({
	manifest,
	kind,
	selection,
	onGrid,
	onFrame,
	onColumns,
	onRemove,
}: {
	manifest: CardSkinManifest | null;
	kind: CardSkinKind;
	selection: SkinSelection;
	onGrid: (blockId: string, patch: Partial<Grid>) => void;
	onFrame: (patch: FramePatch) => void;
	/** 改 12 列的宽度;`undefined` = 回到 12 等分(把 `columns` 整份删掉)。 */
	onColumns: (columns: CardSkinColumn[] | undefined) => void;
	/** 删掉这个块。**不给 = 这套皮肤只读**,连删除钮都不该出现。 */
	onRemove?: (blockId: string) => void;
}) {
	// 「这块带着内容,真删?」那个弹窗开没开。
	const [confirming, setConfirming] = useState(false);
	const card = cardOf(manifest, kind);

	if (selection === null) {
		return <EmptyNote size="sm">在左边画布上点一个块,或者点最底下那条「卡片外框」。</EmptyNote>;
	}
	if (selection.kind === "frame") {
		if (!card) return <EmptyNote size="sm">这套皮肤没有定义这种卡。</EmptyNote>;
		return <FrameInspector card={card} onFrame={onFrame} onColumns={onColumns} />;
	}

	const block = blockOf(card, selection.id);
	if (!block) {
		// 换了卡种但选中还留着上一张卡的块 id —— 这里如实说,别画一个空壳让人以为坏了。
		return <EmptyNote size="sm">这一张卡里没有这个块。</EmptyNote>;
	}

	const lim = gridLimits(block.grid);
	// 自己带内容的块删了就找不回来:自定义块的 HTML、块 CSS、资产变量都不在目录里,
	// 而内置块从「添加块」里原样再摆一个就是了 —— 所以只对前者拦一道。
	const carriesWork =
		block.kind === "custom" ||
		(block.css ?? "") !== "" ||
		Object.keys(block.assets ?? {}).length > 0;

	return (
		<div className="flex flex-col gap-3.5">
			<div className="flex items-center gap-1.5">
				<Pill subtle color="var(--color-bn-pink)">
					{block.kind === "custom" ? "自定义块" : "内置块"}
				</Pill>
				<span className="font-mono text-bn-2xs text-bn-text-tertiary">id {block.id}</span>
			</div>

			<Section label="位置">
				<div className="grid grid-cols-2 gap-x-2.5 gap-y-1.5 p-2.5">
					<GridNum
						label="行"
						value={block.grid.row}
						lim={lim.row}
						onChange={(row) => onGrid(block.id, { row })}
					/>
					<GridNum
						label="起始列"
						value={block.grid.column}
						lim={lim.column}
						onChange={(column) => onGrid(block.id, { column })}
					/>
					<GridNum
						label="跨列"
						value={block.grid.span}
						lim={lim.span}
						onChange={(span) => onGrid(block.id, { span })}
					/>
					<GridNum
						label="跨行"
						value={block.grid.rowSpan ?? 1}
						lim={lim.rowSpan}
						onChange={(rowSpan) => onGrid(block.id, { rowSpan })}
					/>
				</div>
			</Section>

			{onRemove ? (
				<div className="flex justify-end">
					<Btn
						size="sm"
						variant="danger-outline"
						icon={<Icon.trash size={12} />}
						onClick={() => (carriesWork ? setConfirming(true) : onRemove(block.id))}
					>
						删除这个块
					</Btn>
				</div>
			) : null}

			{confirming && onRemove ? (
				<ConfirmDialog
					title="删掉这个块?"
					message="它自己带着内容(自定义 HTML / 块 CSS / 资产变量),删了找不回来 —— 内置块能从「添加块」里原样再摆一个,这些不能。"
					confirmLabel="删掉"
					danger
					onConfirm={() => {
						setConfirming(false);
						onRemove(block.id);
					}}
					onCancel={() => setConfirming(false)}
				/>
			) : null}
		</div>
	);
}

/**
 * 卡片外框那一节:宽度、行 / 列间距、12 列的列定义。**外框 CSS 不在这儿** —— 它与块的
 * CSS 是同一件东西(同一个编辑器、同一套清洗规矩),跟着「高级 CSS」那一片一起做。
 */
function FrameInspector({
	card,
	onFrame,
	onColumns,
}: {
	card: Card;
	onFrame: (patch: FramePatch) => void;
	onColumns: (columns: CardSkinColumn[] | undefined) => void;
}) {
	const custom = card.columns !== undefined;
	const cols = columnsOf(card);
	// 切到定宽时先填「这一列现在多宽」,而不是一个 1px —— 从当前的样子微调是常态。
	const equalPx = Math.round((card.width / CARD_SKIN_LIMITS.columns) * 100) / 100;

	return (
		<div className="flex flex-col gap-3.5">
			<Section label="卡片外框">
				<div className="grid grid-cols-2 gap-x-2.5 gap-y-1.5 p-2.5">
					<GridNum
						label="卡宽"
						value={card.width}
						lim={CARD_SKIN_LIMITS.width}
						onChange={(width) => onFrame({ width })}
					/>
					<GridNum
						label="行间距"
						value={card.gap?.row ?? 0}
						lim={CARD_SKIN_LIMITS.gap}
						onChange={(gapRow) => onFrame({ gapRow })}
					/>
					<GridNum
						label="列间距"
						value={card.gap?.column ?? 0}
						lim={CARD_SKIN_LIMITS.gap}
						onChange={(gapColumn) => onFrame({ gapColumn })}
					/>
				</div>
			</Section>

			<Section label="列定义">
				<div className="flex flex-col gap-2 p-2.5">
					<div className="flex items-center justify-between gap-2">
						<span className="text-bn-2xs text-bn-text-secondary">自定义列宽</span>
						<Toggle
							size="sm"
							value={custom}
							ariaLabel="自定义列宽"
							// 打开时把当前的 12 等分原样落进清单,主人在那个基础上改;关掉就整份删掉。
							onChange={(on) => onColumns(on ? cols : undefined)}
						/>
					</div>
					{custom ? (
						cols.map((c, i) => (
							<ColumnRow
								// biome-ignore lint/suspicious/noArrayIndexKey: 列号就是身份,12 项不增不减
								key={i}
								n={i + 1}
								value={c}
								equalPx={equalPx}
								onChange={(next) => onColumns(cols.map((old, j) => (j === i ? next : old)))}
							/>
						))
					) : (
						<span className="text-bn-2xs text-bn-text-tertiary">
							12 等分。定宽列是给**定尺寸的图**留的 —— 上舰卡那枚 175px 的方徽章在 12 等分里
							落不到整数列,只有定宽列能复刻到像素。
						</span>
					)}
				</div>
			</Section>
		</div>
	);
}

/** 一列:列号 + 单位(份 / px)+ 数。 */
function ColumnRow({
	n,
	value,
	equalPx,
	onChange,
}: {
	n: number;
	value: CardSkinColumn;
	equalPx: number;
	onChange: (next: CardSkinColumn) => void;
}) {
	const px = "px" in value;
	return (
		<div className="flex items-center gap-1.5">
			<span className="w-11 shrink-0 font-mono text-bn-2xs text-bn-text-tertiary">第 {n} 列</span>
			{/* `<fieldset>` 只为给这组钮一个名字 —— 12 组「份 / px」长得一模一样,读屏器
			    (和测试)得知道念的是哪一列。 */}
			<fieldset aria-label={`第 ${n} 列的单位`} className="min-w-0">
				<Picker
					value={px ? "px" : "fr"}
					onChange={(u) => onChange(u === "px" ? { px: equalPx } : { fr: 1 })}
					options={[
						{ value: "fr", label: "份" },
						{ value: "px", label: "px" },
					]}
				/>
			</fieldset>
			<TNum
				value={px ? value.px : value.fr}
				min={px ? 1 : 1}
				max={px ? CARD_SKIN_LIMITS.width.max : CARD_SKIN_LIMITS.columns}
				step={px ? 0.01 : 1}
				width={72}
				ariaLabel={`第 ${n} 列的宽度`}
				onChange={(v) => onChange(px ? { px: v } : { fr: v })}
			/>
		</div>
	);
}

function GridNum({
	label,
	value,
	lim,
	onChange,
}: {
	label: string;
	value: number;
	lim: { min: number; max: number };
	onChange: (next: number) => void;
}) {
	// 刻意不用 `<label>` 包:控件是 `TNum`(内部才是真 input),包了读屏器与 lint 都对不上
	// 它 —— 名字走 `ariaLabel` 递进去,那是 T 系列既有的口。
	return (
		<div className="flex flex-col gap-1">
			<span className="text-bn-2xs text-bn-text-secondary">{label}</span>
			<TNum
				value={value}
				min={lim.min}
				max={lim.max}
				onChange={onChange}
				ariaLabel={`${label}(${lim.min}–${lim.max})`}
			/>
		</div>
	);
}
