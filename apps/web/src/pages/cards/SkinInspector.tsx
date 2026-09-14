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
import { Btn, ConfirmDialog, EmptyNote, Icon, Pill, Section } from "@bilibili-notify/ui";
import { useState } from "react";
import { TNum } from "../../components/forms";
import type { SkinSelection } from "./SkinCanvas";
import { blockOf, cardOf, gridLimits } from "./skin-draft-ops";

type Card = NonNullable<CardSkinManifest["cards"][CardSkinKind]>;
type Grid = Card["blocks"][number]["grid"];

export function SkinInspector({
	manifest,
	kind,
	selection,
	onGrid,
	onRemove,
}: {
	manifest: CardSkinManifest | null;
	kind: CardSkinKind;
	selection: SkinSelection;
	onGrid: (blockId: string, patch: Partial<Grid>) => void;
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
		return (
			<EmptyNote size="sm">
				卡片外框的宽度 / 行列间距 / 列定义 / 外框 CSS 还没做 —— 下一片。
			</EmptyNote>
		);
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
