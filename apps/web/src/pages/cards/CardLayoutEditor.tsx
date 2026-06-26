/**
 * 单卡版式编辑器。live/dyn/sc 是垂直栈 → 一个 BlockListEditor;guard 是受限 2D →
 * 徽章块左右二选一 + name/text 块的 BlockListEditor。受控:吃整份 CardLayout,
 * 改完回吐整份(配合 per-UP「整份覆盖」与全局保存)。
 */

import { Picker } from "../../components/forms";
import type { CardBlockFull, CardLayoutFull } from "../../types/domain";
import { BlockListEditor } from "./BlockListEditor";
import { BLOCK_LABELS, KIND_TO_LAYOUT_KEY, type LayoutKind } from "./block-labels";

interface CardLayoutEditorProps {
	kind: LayoutKind;
	layout: CardLayoutFull;
	onChange: (next: CardLayoutFull) => void;
}

export function CardLayoutEditor({ kind, layout, onChange }: CardLayoutEditorProps) {
	const labels = BLOCK_LABELS[kind];

	if (kind === "guard") {
		const guard = layout.guard;
		return (
			<div className="flex flex-col gap-3">
				<div className="flex items-center gap-2.5">
					<span className="text-[12.5px] font-medium text-bn-text-secondary">徽章（舰长大图）</span>
					<Picker
						value={guard.badgeSide}
						onChange={(badgeSide) => onChange({ ...layout, guard: { ...guard, badgeSide } })}
						options={[
							{ value: "left", label: "靠左" },
							{ value: "right", label: "靠右" },
						]}
					/>
				</div>
				<BlockListEditor
					blocks={guard.blocks}
					labels={labels}
					onChange={(blocks) => onChange({ ...layout, guard: { ...guard, blocks } })}
				/>
			</div>
		);
	}

	const key = KIND_TO_LAYOUT_KEY[kind];
	const blocks = layout[key] as CardBlockFull[];
	return (
		<BlockListEditor
			blocks={blocks}
			labels={labels}
			onChange={(next) => onChange({ ...layout, [key]: next })}
		/>
	);
}
