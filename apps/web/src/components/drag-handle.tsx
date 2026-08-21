/**
 * dnd-kit 可排序行的 ⠿ 拖拽手柄。
 *
 * 三处可排序列表(卡片区块 / 消息排版 / 顶栏标签页)此前各抄了一份,而这段里
 * 每一项都是**丢了就坏**的:
 * - `touch-none` —— 触屏上不写这条,手指按住拖会被浏览器判成滚页,行纹丝不动。
 * - `setActivatorNodeRef` 挂在手柄本身 —— 挂到整行的话行内的开关、边距输入、
 *   删除钮全部点不动,一按就开始拖。
 * - `aria-label` —— ⠿ 对读屏器是个无意义字形,没有 label 这颗钮就没有名字。
 *
 * 字号取三份里的多数派 15px(顶栏那份此前是 14px + px-0.5,是 copy-forward
 * 时的顺手改动,没留下理由)。
 */

import type { useSortable } from "@dnd-kit/sortable";
import type { Ref } from "react";

type Sortable = ReturnType<typeof useSortable>;

export interface DragHandleProps {
	attributes: Sortable["attributes"];
	listeners: Sortable["listeners"];
	setActivatorNodeRef: Sortable["setActivatorNodeRef"];
	/** 拼到读屏器名字后面,区分是哪一行的手柄;`title` 保持通用的「拖动排序」。 */
	label?: string;
}

export function DragHandle({ attributes, listeners, setActivatorNodeRef, label }: DragHandleProps) {
	return (
		<button
			type="button"
			ref={setActivatorNodeRef as Ref<HTMLButtonElement>}
			{...attributes}
			{...listeners}
			title="拖动排序"
			aria-label={label ? `拖动排序 ${label}` : "拖动排序"}
			className="cursor-grab touch-none select-none text-bn-md leading-none text-bn-text-tertiary active:cursor-grabbing"
		>
			⠿
		</button>
	);
}
