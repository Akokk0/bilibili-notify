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

/**
 * 这次推送**本来**要发几条;面板上多条才挂「N 条」胶囊。
 *
 * 重推是追加进原行的(ADR-0017 决策 14),行会越补越长 —— 数 `messages.length` 的话,一个
 * 3 条的行补过一次就写「5 条」,而展开逐条看到的号只有 1/2/3(那儿按 `retryOf ?? 下标`
 * 印),面板自己跟自己对不上。所以数的是没有 `retryOf` 的那些:补几次都不变。
 *
 * ⚠️ 这只是一句本地可见的事实(`retryOf` 缺省 = 不是重投),**不是**决策 16 那条
 * 「每一号只认它最后那次尝试」的判定 —— 那条只在服务端有一份,面板不重做。
 */
export function messageCountOf(entry: HistoryEntryView): number {
	return entry.messages.reduce((n, m) => n + (m.retryOf === undefined ? 1 : 0), 0);
}

/**
 * 这行有没有值得点开看的东西:多条、带图、或哪条带错误信息。
 *
 * 这儿数的是**行里实际有几条**(不是上面那个「本来几条」):一条本体补过一次 = 行里躺着
 * 两次尝试,「本来」只有一条,可那两次尝试正是最该点开看的东西。
 */
export function hasDetails(entry: HistoryEntryView): boolean {
	return entry.messages.length > 1 || entry.messages.some((m) => m.imageRef || m.err);
}
