/**
 * UP 主的展示名 —— 从 `pages/up/helpers` 挪来:`components/scope-tabs` 也要用它,
 * 而组件层反向 import 页面层是圈套(pages 本来就 import components,迟早成环)。
 * helpers 原地转口,页面侧引用点不用改。
 */

import type { HistoryRowIdentity } from "@bilibili-notify/internal";
import { colorFromUid } from "@bilibili-notify/internal/constants";
import { isBiliSubscription, type Subscription } from "../types/domain";

/**
 * B 站订阅没拿到资料时回落到「UID xxx」;拓展订阅(ADR-0019 决策 9)没有 uid,回落到主人起的
 * 名字、再回落到它的外部 id —— 总得认得出是哪一个。
 */
export function displayName(sub: Subscription): string {
	const cached = sub.cachedProfile?.name?.trim();
	if (cached) return cached;
	if (isBiliSubscription(sub)) return `UID ${sub.uid}`;
	return sub.name?.trim() || sub.externalId;
}

/**
 * 拓展那一支的「人」取色用的那一串(ADR-0019 决策 73):拓展 id + 冒号 + 外部 id。带着冒号和
 * 拓展名,永远不会等于一个纯数字的 uid,不会和某位 B 站 UP 撞成同一个人的颜色。只用来取色 ——
 * 查订阅不拼串(外部 id 是不透明字符串,拼就得选分隔符)。
 */
function extensionColorSeed(extensionId: string, externalId: string): string {
	return `${extensionId}:${externalId}`;
}

/**
 * 这条订阅在页面上的颜色 —— 跟着人走。B 站订阅按 uid 取(与服务端渲染周报图时同一套,同一位 UP
 * 在页面与图上是同一个颜色);拓展订阅按「拓展 id:外部 id」取(决策 73):删了再加订阅 id 变了,
 * 颜色不变。历史行用 {@link historyRowColor},同一个人同一个颜色。
 */
export function subscriptionColor(sub: Subscription): string {
	return colorFromUid(
		isBiliSubscription(sub) ? sub.uid : extensionColorSeed(sub.extensionId, sub.externalId),
	);
}

/** 这一行历史是拓展行吗(决策 73:两格都有就是拓展行)。 */
export function isExtensionRow<T extends HistoryRowIdentity>(
	row: T,
): row is T & { extensionId: string; externalId: string } {
	return row.extensionId !== undefined && row.externalId !== undefined;
}

/**
 * 历史行的颜色,与 {@link subscriptionColor} 同一条规矩:B 站行按 uid、拓展行按「拓展 id:外部 id」——
 * 订阅卡与历史行是同一个颜色,订阅删了也不变。两格都没有才退订阅 id。
 */
export function historyRowColor(row: HistoryRowIdentity): string {
	if (isExtensionRow(row)) return colorFromUid(extensionColorSeed(row.extensionId, row.externalId));
	return colorFromUid(row.uid || row.subscriptionId);
}

/**
 * 历史行「这是谁」的那行字(决策 73),名字对不上时拿它兜底:B 站行「UID xxx」;拓展行「平台名 ·
 * 外部 id」。平台名由调用方按已装拓展的清单取(`subscriptionPlatformOf`);不给、或拓展卸载了取不到,
 * 写拓展 id(同决策 10)。
 */
export function historyRowIdentity(
	row: HistoryRowIdentity,
	platformLabelOf: (extensionId: string) => string = (extensionId) => extensionId,
): string {
	if (isExtensionRow(row)) return `${platformLabelOf(row.extensionId)} · ${row.externalId}`;
	return row.uid ? `UID ${row.uid}` : "未知";
}
