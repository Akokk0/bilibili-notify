/**
 * UP 主的展示名 —— 从 `pages/up/helpers` 挪来:`components/scope-tabs` 也要用它,
 * 而组件层反向 import 页面层是圈套(pages 本来就 import components,迟早成环)。
 * helpers 原地转口,页面侧引用点不用改。
 */

import type { HistoryRowIdentity } from "@bilibili-notify/internal";
import { upColor } from "@bilibili-notify/internal/constants";
import {
	BILIBILI_SOURCE_KEY,
	identityColor,
	type Subscription,
	subscriptionIdentityOf,
} from "../types/domain";

/**
 * B 站订阅没拿到资料时回落到「UID xxx」;拓展订阅(ADR-0019 决策 9)没有 uid,回落到它的外部 id ——
 * 总得认得出是哪一个(别名已退役,ADR-0021 决策 16)。
 */
export function displayName(sub: Subscription): string {
	const cached = sub.cachedProfile?.name?.trim();
	if (cached) return cached;
	const identity = subscriptionIdentityOf(sub);
	if (identity.sourceKey === BILIBILI_SOURCE_KEY) return `UID ${identity.externalId}`;
	return identity.externalId;
}

/**
 * 这条订阅在页面上的颜色 —— 跟着人走。B 站订阅按 uid 取,拓展订阅按「拓展 id:外部 id」取(决策 73):
 * 删了再加订阅 id 变了,颜色不变。算法住 internal 的 `identityColor` / `upColor`(ADR-0020 决策 15),服务端出图(周报 /
 * 锐评卡)用的是同一份,同一个人在页面与图上是同一个颜色。历史行用 {@link historyRowColor}。
 */
export function subscriptionColor(sub: Subscription): string {
	return identityColor(subscriptionIdentityOf(sub));
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
	return upColor(row, row.subscriptionId);
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
