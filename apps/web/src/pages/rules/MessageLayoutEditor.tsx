import { i18n, useT } from "../../i18n";
/**
 * 消息版式编辑器 —— 编辑单一推送类型(动态 / 开播)的 MessageKindLayout:
 * @dnd-kit 拖拽重排(拖动实时让位、手柄仅 ⠿)/
 * 内容块显隐 / 分条符增删 / 分隔符,附「每条消息装什么」的实时预览。
 * 文本模板编辑区经 `textSlot` 内嵌在「文本」块行内(随块拖动、块隐藏即收起;
 * 全局绑 defaults.templates,per-UP 绑 overrides.templates,由调用方组合)。
 */

import { AddButton, Icon, IconButton, StatusDot, Toggle, WarnNote } from "@bilibili-notify/ui";
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
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type { ReactNode } from "react";
import { Field, TInput } from "../../components/forms";
import { SortableRow, SortableRowEnd, sortableLabelTone } from "../../components/sortable-row";
import { SECTION_ACCENT } from "../../config/section-accents";
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
	get card() {
		return i18n.t("panelUi.pages.rules.MessageLayoutEditor.1");
	},
	get text() {
		return i18n.t("panelUi.pages.rules.MessageLayoutEditor.2");
	},
	get link() {
		return i18n.t("panelUi.pages.rules.MessageLayoutEditor.3");
	},
};

/**
 * 单个可排序块行 —— 壳子(useSortable/拖拽态/手柄)在 components/sortable-row。
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
	const tx = useT();

	const isSplit = block.type === MESSAGE_SPLIT_TYPE;
	return (
		<SortableRow
			id={block.id}
			// 「文本」块内嵌模板编辑区,行高与其他块差异很大 —— 走 Translate 避免拖动畸变。
			translate
			restClassName={isSplit ? "border-dashed border-bn-border bg-bn-surface/40" : undefined}
			below={
				slot ? (
					<div
						className="mt-2 border-l-2 pl-3"
						style={{ borderColor: `color-mix(in srgb, ${accent} 27%, transparent)` }}
						// 编辑区在可拖拽行内部:拖拽手柄只绑 ⠿,这里的输入交互不会触发拖动。
					>
						{slot}
					</div>
				) : undefined
			}
		>
			<StatusDot size="sm" color={isSplit ? "var(--color-bn-inactive)" : accent} />
			<span className={`flex-1 text-bn-sm font-bold ${sortableLabelTone(isSplit, block.visible)}`}>
				{isSplit ? (
					<>
						{/* 行内图标:父 span 是文本流(还带 italic),用 align 微调基线而不是改成 flex
						    —— 非分条符那支还要跟后面的 PART_HINTS 并排。 */}
						<Icon.scissors size={11} className="mr-1 inline-block align-[-1px]" />
						{tx("panelUi.pages.rules.MessageLayoutEditor.4")}
					</>
				) : (
					(PART_LABELS[block.type] ?? block.type)
				)}
				{!isSplit && PART_HINTS[block.type] ? (
					<span className="ml-2 text-bn-xs font-normal text-bn-text-tertiary">
						{PART_HINTS[block.type]}
					</span>
				) : null}
			</span>
			<SortableRowEnd>
				{isSplit ? (
					<IconButton
						icon={<Icon.close size={13} />}
						label={tx("panelUi.pages.rules.MessageLayoutEditor.5")}
						tone="danger"
						onClick={() => onRemove(block.id)}
					/>
				) : (
					<Toggle value={block.visible} size="sm" onChange={(v) => onToggle(block.id, v)} />
				)}
			</SortableRowEnd>
		</SortableRow>
	);
}

export function MessageLayoutEditor({
	value,
	onChange,
	separatorCode,
	textSlot,
	accent = SECTION_ACCENT.message,
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
	const tx = useT();

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
				<AddButton onClick={() => setBlocks(insertSplit(value.blocks))}>
					<Icon.plus size={13} />
					{tx("panelUi.pages.rules.MessageLayoutEditor.6")}
				</AddButton>
				<span className="text-bn-xs text-bn-text-tertiary">
					{tx("panelUi.pages.rules.MessageLayoutEditor.7")}
				</span>
			</div>

			<Field code={separatorCode} hint={tx("panelUi.pages.rules.MessageLayoutEditor.8")}>
				<TInput
					value={encodeSeparator(value.separator)}
					onChange={(v) => onChange({ ...value, separator: decodeSeparator(v) })}
					mono
					full={false}
				/>
			</Field>

			<div
				className="rounded-lg border px-3 py-2 text-bn-xs leading-6 text-bn-text-secondary"
				style={{
					borderColor: `color-mix(in srgb, ${accent} 27%, transparent)`,
					background: `color-mix(in srgb, ${accent} 6%, transparent)`,
				}}
			>
				<span className="font-bold" style={{ color: accent }}>
					{tx("panelUi.pages.rules.MessageLayoutEditor.9")}
				</span>{" "}
				{preview.length === 0 ? (
					<b className="text-bn-danger">{tx("panelUi.pages.rules.MessageLayoutEditor.10")}</b>
				) : (
					preview
						.map((line, i) =>
							tx("panelUi.pages.rules.MessageLayoutEditor.11", { value0: i + 1, value1: line }),
						)
						.join(" · ")
				)}
			</div>

			{cardNotFirst.length > 0 ? (
				<WarnNote className="leading-6">
					<b>{tx("panelUi.pages.rules.MessageLayoutEditor.12")}</b>
					{tx("panelUi.pages.rules.MessageLayoutEditor.13", { messages: cardNotFirst.join("、") })}
				</WarnNote>
			) : null}
		</div>
	);
}
