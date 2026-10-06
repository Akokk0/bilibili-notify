/**
 * UP 主的展示名 —— 从 `pages/up/helpers` 挪来:`components/scope-tabs` 也要用它,
 * 而组件层反向 import 页面层是圈套(pages 本来就 import components,迟早成环)。
 * helpers 原地转口,页面侧引用点不用改。
 */

import type { HistoryEntryView } from "@bilibili-notify/contract";
import type { HistoryRowIdentity } from "@bilibili-notify/internal";
import {
	BILIBILI_SOURCE_KEY,
	type Identity,
	identityColor,
	type Subscription,
	subscriptionIdentityOf,
} from "../types/domain";
import { imageUrl } from "./image-url";

/** 这个身份是拓展来的吗:来源键不是 B 站。订阅与历史行共用这一个判断。 */
export function isExtensionIdentity(identity: Identity): boolean {
	return identity.sourceKey !== BILIBILI_SOURCE_KEY;
}

/**
 * B 站订阅没拿到资料时回落到「UID xxx」;拓展订阅(ADR-0019 决策 9)没有 uid,回落到它的外部 id ——
 * 总得认得出是哪一个(别名已退役,ADR-0021 决策 16)。
 */
export function displayName(sub: Subscription): string {
	const cached = sub.cachedProfile?.name?.trim();
	if (cached) return cached;
	const identity = subscriptionIdentityOf(sub);
	return isExtensionIdentity(identity) ? identity.externalId : `UID ${identity.externalId}`;
}

/**
 * 订阅资料里头像的显示地址(ADR-0022 决策 9 下 10-04「⑳ 开片」的 🔗):存进图库的头像 `avatar`(拓展订阅)走图库的
 * 同源读口 `/api/images/<ref>`;否则是远端网址 `avatarUrl`(B 站订阅的 CDN 图链,也可能是新建拓展订阅时草稿里装着的
 * 候选头像 data URL —— 它是个网址,提交后服务端落图库、回来的资料里换成 `avatar`);都没有就是 `undefined`
 * (头像件画首字)。所有读订阅头像的地方都走这一个,别各自去挑哪一格。
 */
export function profileAvatarUrl(
	profile: { avatar?: string; avatarUrl?: string } | undefined,
): string | undefined {
	if (profile?.avatar) return imageUrl(profile.avatar);
	return profile?.avatarUrl || undefined;
}

/**
 * 历史行上 UP 的头像地址(ADR-0022 决策 9 下 10-04「⑳ 开片」的 🔗):行写入那一刻的头像快照(图库引用,只有拓展行有)优先;
 * 没有快照(B 站行,抓图服务在 3a)就退到订阅**现在**的头像({@link profileAvatarUrl}),再没有就是 `undefined`(头像件画首字)。
 *
 * **过了保留期的行不用快照**:那几天的行已经不是图库的引用方,图随时可能被清扫收走,用它就是一张裂图;
 * 退到订阅现在的头像更稳。Dashboard 与历史页的行都走这一个。
 */
export function historyRowAvatarUrl(
	row: Pick<HistoryEntryView, "avatarSnapshot" | "isPastRetention">,
	profile: { avatar?: string; avatarUrl?: string } | undefined,
): string | undefined {
	if (row.avatarSnapshot && !row.isPastRetention) return imageUrl(row.avatarSnapshot);
	return profileAvatarUrl(profile);
}

/**
 * 这条订阅在页面上的颜色 —— 跟着人走。B 站订阅按 uid 取,拓展订阅按「拓展 id:外部 id」取(决策 73):
 * 删了再加订阅 id 变了,颜色不变。算法住 internal 的 `identityColor` / `upColor`(ADR-0020 决策 15),服务端出图(周报 /
 * 锐评卡)用的是同一份,同一个人在页面与图上是同一个颜色。历史行用 {@link historyRowColor}。
 */
export function subscriptionColor(sub: Subscription): string {
	return identityColor(subscriptionIdentityOf(sub));
}

/**
 * 历史行的颜色,与 {@link subscriptionColor} 同一条规矩:跟着 `identity` 走(B 站行是 uid、拓展行是
 * 「拓展 id:外部 id」)—— 订阅卡与历史行是同一个颜色,订阅删了也不变。
 */
export function historyRowColor(row: HistoryRowIdentity): string {
	return identityColor(row.identity);
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
	const { sourceKey, externalId } = row.identity;
	return isExtensionIdentity(row.identity)
		? `${platformLabelOf(sourceKey)} · ${externalId}`
		: `UID ${externalId}`;
}
