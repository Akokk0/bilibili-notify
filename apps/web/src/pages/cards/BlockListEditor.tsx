/**
 * 通用块列表编辑器:@dnd-kit 拖拽重排 + 每块显隐开关 + 上边距 + 分割线增删。纯受控
 * 组件 —— 重排逻辑走 layout-ops 的 moveBlock(已单测),本组件只管交互与外观。
 * 边距模型:每块只设「上方间距」;第一个块的上边距由卡片框架固定(此处锁定不可改)。
 *
 * 用 @dnd-kit/sortable:拖动时其余块实时让位,落点一目了然(取代原生 HTML5 拖拽的
 * 整块高亮猜位置)。拖拽走 pointer 事件,不依赖 OS 拖放,桌面壳(Tauri webview)里也
 * 正常。拖拽手柄只绑在 ⠿ 上 —— 开关 / 边距输入 / 删除按钮仍可正常点击。
 */

import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	KeyboardSensor,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
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
	/**
	 * 是否展示上边距输入。默认 true;guard 的受限 2D 布局靠 flex 撑开、边距无意义,传 false
	 * 只留位置控制(排序 / 显隐)。
	 */
	showMargin?: boolean;
}

/**
 * 紧凑上边距输入:默认显示 0(= 不额外加间距,走框架内置),带 px 单位。改成 0 时回存
 * undefined,保持版式干净。`locked` 时(第一个块)上边距由框架固定,展示「固定」不可改。
 */
function MarginInput({
	value,
	onChange,
	locked,
}: {
	value: number | undefined;
	onChange: (v: number | undefined) => void;
	locked?: boolean;
}) {
	if (locked) {
		return (
			<span className="text-[10px] text-bn-text-tertiary" title="第一个模块的上边距由卡片框架固定">
				上边距 固定
			</span>
		);
	}
	return (
		<label className="flex items-center gap-0.5 text-[10px] text-bn-text-tertiary">
			上边距
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

/** 单个可排序行 —— useSortable 必须 per-item,故抽成组件。拖拽手柄仅 ⠿。 */
function SortableRow({
	block,
	locked,
	labels,
	showMargin,
	onToggle,
	onRemove,
	onMargin,
}: {
	block: CardBlockFull;
	locked: boolean;
	labels: Record<string, string>;
	showMargin: boolean;
	onToggle: (id: string) => void;
	onRemove: (id: string) => void;
	onMargin: (id: string, v: number | undefined) => void;
}) {
	const {
		attributes,
		listeners,
		setNodeRef,
		setActivatorNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: block.id });
	const isDivider = block.type === DIVIDER_TYPE;
	const style = { transform: CSS.Transform.toString(transform), transition };
	return (
		<li
			ref={setNodeRef}
			style={style}
			className={`relative flex items-center gap-2 rounded-lg border px-2.5 py-2 ${
				isDragging
					? "z-10 border-bn-pink/60 bg-bn-surface opacity-90 shadow-lg"
					: "border-bn-border-subtle bg-bn-surface/60"
			}`}
		>
			<button
				type="button"
				ref={setActivatorNodeRef}
				{...attributes}
				{...listeners}
				title="拖动排序"
				aria-label="拖动排序"
				className="cursor-grab touch-none select-none text-[15px] leading-none text-bn-text-tertiary active:cursor-grabbing"
			>
				⠿
			</button>
			<span
				className={`flex-1 text-[13px] font-medium ${
					isDivider
						? "italic text-bn-text-tertiary"
						: block.visible
							? "text-bn-text-primary"
							: "text-bn-text-tertiary line-through"
				}`}
			>
				{isDivider ? DIVIDER_LABEL : (labels[block.type] ?? block.type)}
			</span>
			{showMargin && (
				<MarginInput
					value={block.marginTop}
					locked={locked}
					onChange={(v) => onMargin(block.id, v)}
				/>
			)}
			{/* 固定宽度槽位 —— 让删除按钮与 Toggle 占同宽,上下行的边距输入对齐。 */}
			<div className="flex w-7 shrink-0 justify-end">
				{isDivider ? (
					<button
						type="button"
						title="删除分割线"
						onClick={() => onRemove(block.id)}
						className="grid h-5 w-5 place-items-center rounded text-bn-text-tertiary transition hover:bg-bn-danger-soft hover:text-bn-danger-text"
					>
						<Icon.close size={13} />
					</button>
				) : (
					<Toggle value={block.visible} size="sm" onChange={() => onToggle(block.id)} />
				)}
			</div>
		</li>
	);
}

export function BlockListEditor({
	blocks,
	labels,
	onChange,
	showMargin = true,
}: BlockListEditorProps) {
	// pointer 拖拽设 4px 启动阈值,避免点击手柄被误判成拖拽;键盘可达性走 KeyboardSensor。
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	);

	const handleDragEnd = (e: DragEndEvent) => {
		const { active, over } = e;
		if (!over || active.id === over.id) return;
		const from = blocks.findIndex((b) => b.id === active.id);
		const to = blocks.findIndex((b) => b.id === over.id);
		if (from === -1 || to === -1) return;
		onChange(moveBlock(blocks, from, to));
	};

	return (
		<div className="flex flex-col gap-2">
			<DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
				<SortableContext items={blocks.map((b) => b.id)} strategy={verticalListSortingStrategy}>
					<ul className="flex flex-col gap-1.5">
						{blocks.map((b, i) => (
							<SortableRow
								key={b.id}
								block={b}
								locked={i === 0}
								labels={labels}
								showMargin={showMargin}
								onToggle={(id) => onChange(toggleBlockVisible(blocks, id))}
								onRemove={(id) => onChange(removeBlock(blocks, id))}
								onMargin={(id, v) => onChange(setBlockMargin(blocks, id, v))}
							/>
						))}
					</ul>
				</SortableContext>
			</DndContext>
			<button
				type="button"
				onClick={() => onChange(addDivider(blocks))}
				className="flex items-center justify-center gap-1 rounded-lg border border-dashed border-bn-border-subtle py-1.5 text-[12px] font-medium text-bn-text-tertiary transition hover:border-bn-pink/60 hover:text-bn-text-primary"
			>
				<Icon.plus size={13} />
				添加分割线
			</button>
		</div>
	);
}
