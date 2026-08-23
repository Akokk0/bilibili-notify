/**
 * dnd-kit 可排序行的公共壳 —— `cards/BlockListEditor` 与 `rules/MessageLayoutEditor`
 * 曾各抄一份:useSortable 的七字段解构、拖拽态 className、⠿ 手柄、行尾固定宽槽
 * 逐字符相同,两处的 JSDoc 连「useSortable 必须 per-item,故抽成组件」这句话都
 * 抄了同一份。useSortable 必须 per-item,所以壳子是组件而不是 hook;行内容
 * (标签 / 输入 / 开关)由调用方摆。
 */

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ReactNode } from "react";
import { DragHandle } from "./drag-handle";

export interface SortableRowProps {
	id: string;
	/**
	 * 变高行(内嵌模板编辑区那种)传 true 走 `CSS.Translate`:dnd-kit 默认的
	 * Transform 会算 scaleX/scaleY 把被拖行缩放去匹配目标槽位高度,行高差异大时
	 * 拖动有肉眼可见的膨胀/压缩畸变。等高行保持默认 Transform。
	 */
	translate?: boolean;
	/**
	 * 静息态的边框/底色(分条符行要虚线边就从这儿传)。拖拽态两处本就同一份,
	 * 壳子写死,不开口子。
	 */
	restClassName?: string;
	/** ⠿ 手柄右侧的行内容。 */
	children: ReactNode;
	/** 行下方的内嵌区(随行一起拖动);包裹样式由调用方带上。 */
	below?: ReactNode;
}

export function SortableRow({
	id,
	translate = false,
	restClassName = "border-bn-border-subtle bg-bn-surface/60",
	children,
	below,
}: SortableRowProps) {
	const {
		attributes,
		listeners,
		setNodeRef,
		setActivatorNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id });
	const style = {
		transform: translate ? CSS.Translate.toString(transform) : CSS.Transform.toString(transform),
		transition,
	};
	return (
		<li
			ref={setNodeRef}
			style={style}
			className={`relative rounded-lg border px-2.5 py-2 ${
				isDragging
					? "z-bn-raised border-bn-pink/60 bg-bn-surface opacity-90 shadow-bn-elev"
					: restClassName
			}`}
		>
			<div className="flex items-center gap-2">
				<DragHandle
					attributes={attributes}
					listeners={listeners}
					setActivatorNodeRef={setActivatorNodeRef}
				/>
				{children}
			</div>
			{below ?? null}
		</li>
	);
}

/** 行尾固定宽槽 —— 删除钮与 Toggle 占同宽,上下行的边距输入/中缝才对得齐。 */
export function SortableRowEnd({ children }: { children: ReactNode }) {
	return <div className="flex w-7 shrink-0 justify-end">{children}</div>;
}

/**
 * 行标签的三态色:special(分割线 / 分条符)斜体灰、隐藏了划线灰、可见走正文色。
 * 字号与字重刻意不收 —— 两个编辑器一个 `text-bn-base font-medium` 一个
 * `text-bn-sm font-bold`,那是版面密度不同,不是漂移。
 */
export function sortableLabelTone(special: boolean, visible: boolean): string {
	return special
		? "italic text-bn-text-tertiary"
		: visible
			? "text-bn-text-primary"
			: "text-bn-text-tertiary line-through";
}
