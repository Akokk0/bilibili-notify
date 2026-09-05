import type { HistoryEntryView } from "@bilibili-notify/contract";

/**
 * 一行历史在面板上显示的那句文案:第一条**本体**(卡片 / 分条正文)。@全体 可能抢在卡片
 * 前面落地、图集 / 词云 / 总结排在后面 —— 它们都是附加项,不当标题。一条本体都没有
 * (还没落地)就退到第一条。
 */
export function headlineOf(entry: HistoryEntryView): string | undefined {
	const main = entry.messages.find((m) => m.role === "main") ?? entry.messages[0];
	return main?.text;
}

/** 这一行的消息条数;面板上多条才挂「N 条」胶囊。 */
export function messageCountOf(entry: HistoryEntryView): number {
	return entry.messages.length;
}

/** 这行有没有值得点开看的东西:多条、带图、或哪条带错误信息。 */
export function hasDetails(entry: HistoryEntryView): boolean {
	return entry.messages.length > 1 || entry.messages.some((m) => m.imageRef || m.err);
}
