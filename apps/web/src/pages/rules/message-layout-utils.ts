/**
 * 消息版式编辑器的纯函数工具 —— 块排序 / 分条符增删 / 分组预览 / 分隔符编解码。
 * 与后端 `planMessageGroups`(packages/internal)语义对齐:分条符切组、隐藏块
 * 不进组、空组丢弃。
 */

import type { MessageBlockFull } from "../../types/domain";

export const MESSAGE_SPLIT_TYPE = "split";

/** 部件中文名(预览与块行共用)。 */
export const PART_LABELS: Record<string, string> = {
	card: "卡片图",
	text: "文本",
	link: "链接",
	[MESSAGE_SPLIT_TYPE]: "分条符",
};

/** 把 from 处的块移动到 to(dnd 拖拽落点语义,与 cards/layout-ops 同款);越界原样返回。 */
export function moveBlock(
	blocks: MessageBlockFull[],
	from: number,
	to: number,
): MessageBlockFull[] {
	if (from < 0 || from >= blocks.length || to < 0 || to >= blocks.length || from === to) {
		return blocks;
	}
	const next = [...blocks];
	const [moved] = next.splice(from, 1);
	if (!moved) return blocks;
	next.splice(to, 0, moved);
	return next;
}

/** 末尾追加一个分条符,id 取当前不冲突的最小序号(split-1, split-2, …)。 */
export function insertSplit(blocks: MessageBlockFull[]): MessageBlockFull[] {
	const used = new Set(blocks.map((b) => b.id));
	let n = 1;
	while (used.has(`split-${n}`)) n += 1;
	return [...blocks, { id: `split-${n}`, type: MESSAGE_SPLIT_TYPE, visible: true }];
}

/** 按实例 id 删除块(仅分条符可删;内容块由 visible 控显隐)。 */
export function removeBlock(blocks: MessageBlockFull[], id: string): MessageBlockFull[] {
	return blocks.filter((b) => b.id !== id);
}

/**
 * 按分条符切组,每组= 一条消息内按序可见的部件 type 列表(隐藏块不进组 / 隐藏
 * 分条符不切 / 空组丢弃)。与后端 planMessageGroups 语义对齐,`describeGroups`
 * 与 `groupsWithCardNotFirst` 共用。
 */
function groupVisibleTypes(blocks: MessageBlockFull[]): string[][] {
	const groups: string[][] = [];
	let current: string[] = [];
	const flush = (): void => {
		if (current.length > 0) groups.push(current);
		current = [];
	};
	for (const b of blocks) {
		if (!b.visible) continue;
		if (b.type === MESSAGE_SPLIT_TYPE) {
			flush();
			continue;
		}
		current.push(b.type);
	}
	flush();
	return groups;
}

/**
 * 分组预览:每条消息一行文案,如 ["卡片图", "文本 + 链接"]。返回 [] = 该版式
 * 当前什么都不发。
 */
export function describeGroups(blocks: MessageBlockFull[]): string[] {
	return groupVisibleTypes(blocks).map((g) => g.map((t) => PART_LABELS[t] ?? t).join(" + "));
}

/**
 * QQ 场景提示:同一条消息里卡片图不是第一个部件时,QQ 客户端会把图文自动拆成
 * 两条独立消息(卡片图放最前才能合并成一条)。返回命中该问题的消息序号
 * (1-based,与 `describeGroups` 的下标对齐)。
 */
export function groupsWithCardNotFirst(blocks: MessageBlockFull[]): number[] {
	const affected: number[] = [];
	groupVisibleTypes(blocks).forEach((g, i) => {
		if (g.indexOf("card") > 0) affected.push(i + 1);
	});
	return affected;
}

/** 分隔符在单行输入框中的显示编码:真换行 → 字面 `\n`。 */
export function encodeSeparator(sep: string): string {
	return sep.replace(/\n/g, "\\n");
}

/** 反向解码:字面 `\n` → 真换行。 */
export function decodeSeparator(raw: string): string {
	return raw.replace(/\\n/g, "\n");
}
