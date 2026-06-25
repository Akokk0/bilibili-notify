/**
 * 通用块列表编辑器:原生 HTML5 拖拽重排 + 每块显隐开关 + 上下边距 + 分割线增删
 * (零额外依赖)。纯受控组件 —— 逻辑走 layout-ops(已单测),本组件只管交互与外观。
 */

import { useState } from "react";
import { Toggle } from "../../components/atoms";
import { Icon } from "../../components/icons";
import type { CardBlockFull } from "../../types/domain";
import { DIVIDER_LABEL } from "./block-labels";
import {
	addDivider,
	DIVIDER_TYPE,
	moveBlock,
	removeBlock,
	setBlockMargin,
	toggleBlockVisible,
} from "./layout-ops";

interface BlockListEditorProps {
	blocks: CardBlockFull[];
	/** 块 type → 人话名(分割线另走 DIVIDER_LABEL)。 */
	labels: Record<string, string>;
	onChange: (next: CardBlockFull[]) => void;
}

/**
 * 紧凑边距输入:默认显示 0(= 不额外加边距,走模版内置间距),带 px 单位。
 * 改成 0 时回存 undefined,保持版式干净、不落多余的 `margin:0`。
 */
function MarginInput({
	label,
	value,
	onChange,
}: {
	label: string;
	value: number | undefined;
	onChange: (v: number | undefined) => void;
}) {
	return (
		<label className="flex items-center gap-0.5 text-[10px] text-bn-text-tertiary">
			{label}
			<input
				type="number"
				value={value ?? 0}
				onChange={(e) => {
					const n = Number.parseInt(e.target.value, 10);
					onChange(Number.isFinite(n) && n !== 0 ? n : undefined);
				}}
				className="w-9 rounded border border-bn-border-subtle bg-bn-surface px-1 py-0.5 text-center text-[11px] text-bn-text-primary"
			/>
			px
		</label>
	);
}

export function BlockListEditor({ blocks, labels, onChange }: BlockListEditorProps) {
	const [dragIndex, setDragIndex] = useState<number | null>(null);
	const [overIndex, setOverIndex] = useState<number | null>(null);

	return (
		<div className="flex flex-col gap-2">
			<ul className="flex flex-col gap-1.5">
				{blocks.map((b, i) => {
					const dragging = dragIndex === i;
					const isOver = overIndex === i && dragIndex !== null && dragIndex !== i;
					const isDivider = b.type === DIVIDER_TYPE;
					return (
						<li
							key={b.id}
							draggable
							onDragStart={() => setDragIndex(i)}
							onDragOver={(e) => {
								e.preventDefault();
								setOverIndex(i);
							}}
							onDrop={() => {
								if (dragIndex !== null && dragIndex !== i)
									onChange(moveBlock(blocks, dragIndex, i));
								setDragIndex(null);
								setOverIndex(null);
							}}
							onDragEnd={() => {
								setDragIndex(null);
								setOverIndex(null);
							}}
							className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 transition ${
								dragging
									? "border-bn-accent/60 opacity-50"
									: isOver
										? "border-bn-accent/60 bg-bn-accent/5"
										: "border-bn-border-subtle bg-bn-surface/60"
							}`}
						>
							<span
								className="cursor-grab select-none text-[15px] leading-none text-bn-text-tertiary"
								title="拖动排序"
								aria-hidden
							>
								⠿
							</span>
							<span
								className={`flex-1 text-[13px] font-medium ${
									isDivider
										? "italic text-bn-text-tertiary"
										: b.visible
											? "text-bn-text-primary"
											: "text-bn-text-tertiary line-through"
								}`}
							>
								{isDivider ? DIVIDER_LABEL : (labels[b.type] ?? b.type)}
							</span>
							<MarginInput
								label="上"
								value={b.marginTop}
								onChange={(v) => onChange(setBlockMargin(blocks, b.id, "top", v))}
							/>
							<MarginInput
								label="下"
								value={b.marginBottom}
								onChange={(v) => onChange(setBlockMargin(blocks, b.id, "bottom", v))}
							/>
							{/* 固定宽度槽位 —— 让删除按钮与 Toggle 占同宽,上下行的边距输入对齐。 */}
							<div className="flex w-7 shrink-0 justify-end">
								{isDivider ? (
									<button
										type="button"
										title="删除分割线"
										onClick={() => onChange(removeBlock(blocks, b.id))}
										className="grid h-5 w-5 place-items-center rounded text-bn-text-tertiary transition hover:bg-bn-danger-soft hover:text-bn-danger-text"
									>
										<Icon.close size={13} />
									</button>
								) : (
									<Toggle
										value={b.visible}
										size="sm"
										onChange={() => onChange(toggleBlockVisible(blocks, b.id))}
									/>
								)}
							</div>
						</li>
					);
				})}
			</ul>
			<button
				type="button"
				onClick={() => onChange(addDivider(blocks))}
				className="flex items-center justify-center gap-1 rounded-lg border border-dashed border-bn-border-subtle py-1.5 text-[12px] font-medium text-bn-text-tertiary transition hover:border-bn-accent/60 hover:text-bn-text-primary"
			>
				<Icon.plus size={13} />
				添加分割线
			</button>
		</div>
	);
}
