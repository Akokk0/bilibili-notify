/**
 * 通用块列表编辑器:原生 HTML5 拖拽重排 + 每块显隐开关(零额外依赖)。
 * 纯受控组件 —— 逻辑走 layout-ops 的 moveBlock / toggleBlockVisible(已单测),
 * 本组件只管交互与外观(人眼验收)。
 */

import { useState } from "react";
import { Toggle } from "../../components/atoms";
import type { CardBlockFull } from "../../types/domain";
import { moveBlock, toggleBlockVisible } from "./layout-ops";

interface BlockListEditorProps {
	blocks: CardBlockFull[];
	/** 块 id → 人话名。 */
	labels: Record<string, string>;
	onChange: (next: CardBlockFull[]) => void;
}

export function BlockListEditor({ blocks, labels, onChange }: BlockListEditorProps) {
	const [dragIndex, setDragIndex] = useState<number | null>(null);
	const [overIndex, setOverIndex] = useState<number | null>(null);

	return (
		<ul className="flex flex-col gap-1.5">
			{blocks.map((b, i) => {
				const dragging = dragIndex === i;
				const isOver = overIndex === i && dragIndex !== null && dragIndex !== i;
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
							if (dragIndex !== null && dragIndex !== i) onChange(moveBlock(blocks, dragIndex, i));
							setDragIndex(null);
							setOverIndex(null);
						}}
						onDragEnd={() => {
							setDragIndex(null);
							setOverIndex(null);
						}}
						className={`flex items-center gap-2.5 rounded-lg border px-2.5 py-2 transition ${
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
								b.visible ? "text-bn-text-primary" : "text-bn-text-tertiary line-through"
							}`}
						>
							{labels[b.id] ?? b.id}
						</span>
						<Toggle
							value={b.visible}
							size="sm"
							onChange={() => onChange(toggleBlockVisible(blocks, b.id))}
						/>
					</li>
				);
			})}
		</ul>
	);
}
