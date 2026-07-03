/**
 * 消息版式编辑器 —— 编辑单一推送类型(动态 / 开播)的 MessageKindLayout:
 * @dnd-kit 拖拽重排(与 cards/BlockListEditor 同款交互:拖动实时让位、手柄仅 ⠿)/
 * 内容块显隐 / 分条符增删 / 分隔符,附「每条消息装什么」的实时预览。
 * 文本模板编辑区经 `textSlot` 内嵌在「文本」块行内(随块拖动、块隐藏即收起;
 * 全局绑 defaults.templates,per-UP 绑 overrides.templates,由调用方组合)。
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
import type { ReactNode } from "react";
import { Toggle } from "../../components/atoms";
import { Field, TInput } from "../../components/forms";
import { Icon } from "../../components/icons";
import type { MessageBlockFull, MessageKindLayoutFull } from "../../types/domain";
import {
	decodeSeparator,
	describeGroups,
	encodeSeparator,
	groupsWithCardNotFirst,
	insertSplit,
	MESSAGE_SPLIT_TYPE,
	moveBlock,
	PART_LABELS,
	removeBlock,
} from "./message-layout-utils";

const PART_HINTS: Record<string, string> = {
	card: "渲染出的卡片图片;隐藏后连图片渲染都跳过",
	text: "AI 点评或消息模板(模板就在本块下方编辑)",
	link: "动态 / 视频 / 直播间链接,独立部件",
};

/**
 * 单个可排序块行。useSortable 必须 per-item,故抽成组件;拖拽手柄仅 ⠿。
 * `slot`(文本块的模板编辑区)内嵌在行内、随块一起拖动;块隐藏时由调用方收起。
 */
function SortableBlockRow({
	block,
	accent,
	onToggle,
	onRemove,
	slot,
}: {
	block: MessageBlockFull;
	accent: string;
	onToggle: (id: string, v: boolean) => void;
	onRemove: (id: string) => void;
	slot?: ReactNode;
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
	const isSplit = block.type === MESSAGE_SPLIT_TYPE;
	// 用 Translate 而非 Transform:本编辑器「文本」块内嵌模板编辑区,行高与其他块差异很大,
	// dnd-kit 默认会算 scaleX/scaleY 把被拖行视觉缩放去匹配目标槽位高度,导致拖动时肉眼可见的膨胀/压缩畸变。
	const style = { transform: CSS.Translate.toString(transform), transition };
	return (
		<li
			ref={setNodeRef}
			style={style}
			className={`relative rounded-lg border px-2.5 py-2 ${
				isDragging
					? "z-10 border-bn-accent/60 bg-bn-surface opacity-90 shadow-lg"
					: isSplit
						? "border-dashed border-bn-border bg-bn-surface/40"
						: "border-bn-border-subtle bg-bn-surface/60"
			}`}
		>
			<div className="flex items-center gap-2">
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
					className="inline-block h-1.5 w-1.5 rounded-full"
					style={{ background: isSplit ? "#adb5bd" : accent }}
				/>
				<span
					className={`flex-1 text-[12.5px] font-bold ${
						isSplit
							? "italic text-bn-text-tertiary"
							: block.visible
								? "text-bn-text-primary"
								: "text-bn-text-tertiary line-through"
					}`}
				>
					{isSplit ? "✂ 分条符 · 上下切成两条消息" : (PART_LABELS[block.type] ?? block.type)}
					{!isSplit && PART_HINTS[block.type] ? (
						<span className="ml-2 text-[11px] font-normal text-bn-text-tertiary">
							{PART_HINTS[block.type]}
						</span>
					) : null}
				</span>
				<div className="flex w-7 shrink-0 justify-end">
					{isSplit ? (
						<button
							type="button"
							title="删除分条符"
							onClick={() => onRemove(block.id)}
							className="grid h-5 w-5 place-items-center rounded text-bn-text-tertiary transition hover:bg-bn-danger-soft hover:text-bn-danger-text"
						>
							<Icon.close size={13} />
						</button>
					) : (
						<Toggle value={block.visible} size="sm" onChange={(v) => onToggle(block.id, v)} />
					)}
				</div>
			</div>
			{slot ? (
				<div
					className="mt-2 border-l-2 pl-3"
					style={{ borderColor: `${accent}44` }}
					// 编辑区在可拖拽行内部:拖拽手柄只绑 ⠿,这里的输入交互不会触发拖动。
				>
					{slot}
				</div>
			) : null}
		</li>
	);
}

export function MessageLayoutEditor({
	value,
	onChange,
	separatorCode,
	textSlot,
	accent = "#9b6dff",
}: {
	value: MessageKindLayoutFull;
	onChange: (next: MessageKindLayoutFull) => void;
	/** 分隔符 Field 的字典 code(区分动态 / 开播,对齐灵动岛 diff 锚点)。 */
	separatorCode: string;
	/**
	 * 「文本」块行内嵌的模板编辑区(由调用方绑定全局 / per-UP 数据源;多段模板用
	 * Picker 切换)。仅在文本块可见时展开,随块一起拖动。
	 */
	textSlot?: ReactNode;
	accent?: string;
}) {
	const setBlocks = (blocks: MessageBlockFull[]): void => onChange({ ...value, blocks });
	const preview = describeGroups(value.blocks);
	const cardNotFirst = groupsWithCardNotFirst(value.blocks);
	// pointer 拖拽设 4px 启动阈值,避免点手柄被误判成拖拽;键盘可达性走 KeyboardSensor。
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	);

	const handleDragEnd = (e: DragEndEvent): void => {
		const { active, over } = e;
		if (!over || active.id === over.id) return;
		const from = value.blocks.findIndex((b) => b.id === active.id);
		const to = value.blocks.findIndex((b) => b.id === over.id);
		if (from === -1 || to === -1) return;
		setBlocks(moveBlock(value.blocks, from, to));
	};

	return (
		<div className="space-y-2">
			<DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
				<SortableContext
					items={value.blocks.map((b) => b.id)}
					strategy={verticalListSortingStrategy}
				>
					<ul className="flex flex-col gap-1.5">
						{value.blocks.map((block) => (
							<SortableBlockRow
								key={block.id}
								block={block}
								accent={accent}
								onToggle={(id, v) =>
									setBlocks(value.blocks.map((x) => (x.id === id ? { ...x, visible: v } : x)))
								}
								onRemove={(id) => setBlocks(removeBlock(value.blocks, id))}
								slot={block.type === "text" && block.visible ? textSlot : undefined}
							/>
						))}
					</ul>
				</SortableContext>
			</DndContext>

			<div className="flex items-center gap-2">
				<button
					type="button"
					onClick={() => setBlocks(insertSplit(value.blocks))}
					className="flex items-center gap-1 rounded-lg border border-dashed border-bn-border-subtle px-2.5 py-1.5 text-[12px] font-medium text-bn-text-tertiary transition hover:border-bn-accent/60 hover:text-bn-text-primary"
				>
					<Icon.plus size={13} />
					插入分条符
				</button>
				<span className="text-[11px] text-bn-text-tertiary">
					分条符把一次推送切成多条消息;某条发送失败时,该目标的后续条会中止
				</span>
			</div>

			<Field
				code={separatorCode}
				hint="同一条消息内相邻文本类部件(文本 / 链接)之间的连接符;\n 表示换行"
			>
				<TInput
					value={encodeSeparator(value.separator)}
					onChange={(v) => onChange({ ...value, separator: decodeSeparator(v) })}
					mono
					full={false}
				/>
			</Field>

			<div
				className="rounded-lg border px-3 py-2 text-[11.5px] leading-6 text-bn-text-secondary"
				style={{ borderColor: `${accent}44`, background: `${accent}10` }}
			>
				<span className="font-bold" style={{ color: accent }}>
					发送预览:
				</span>{" "}
				{preview.length === 0 ? (
					<b className="text-red-500">所有部件都被隐藏,本类推送将不发送任何消息</b>
				) : (
					preview.map((line, i) => `第 ${i + 1} 条『${line}』`).join(" · ")
				)}
			</div>

			{cardNotFirst.length > 0 ? (
				<div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11.5px] leading-6 text-amber-600">
					<b>提示:</b>第 {cardNotFirst.join("、")} 条消息里卡片图不在最前面 —— QQ
					上先发文字再发图片会被自动拆成两条消息,卡片图放在最前才能合并成一条。
				</div>
			) : null}
		</div>
	);
}
