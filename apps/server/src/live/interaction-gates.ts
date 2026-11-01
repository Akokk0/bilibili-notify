/**
 * 醒目留言与会员的门槛(㉓d,原先是 `minScPrice` / `minGuardLevel`)。两条纯函数,直播间会话在推之前各问一次;
 * 门槛是订阅折好的生效值(`SubItemView.minSuperchatAmount` / `minGuardRank`),这里不读配置。
 *
 * **运行时不再有任何地方拿原始 `guard_level` 比大小**:会员的门槛按事件的档位 `tier.rank` 比(从 1 起、1 最低),
 * `guard_level` 与 rank 的倒序换算全在 B 站的档位表里(`bilibili/guard-program.ts` 的 `guardTierOf`)。
 */

import type { MembershipEvent, SuperchatEvent } from "@bilibili-notify/internal";

/**
 * 醒目留言过不过门槛:金额**低于** `minAmount` 才拦(等于放行),没配门槛不拦。门槛按人民币算,所以只在币种是 `CNY` 时比,
 * 别的币种放行(拿美元的 5 去和人民币的 30 比没有意义)。
 */
export function passesSuperchatMinAmount(
	event: Pick<SuperchatEvent, "amount" | "currency">,
	minAmount: number | undefined,
): boolean {
	if (minAmount === undefined || event.currency !== "CNY") return true;
	return event.amount >= minAmount;
}

/**
 * 会员事件过不过门槛:档位 `rank` **低于** `minRank` 才拦,没配门槛不拦。事件没带 rank(档位由主播自定的体系)没有可比的,
 * 放行 —— 这样的体系没有门槛可配,只能开或关(特性开关)。
 */
export function passesMembershipMinRank(
	event: Pick<MembershipEvent, "tier">,
	minRank: number | undefined,
): boolean {
	if (minRank === undefined || event.tier.rank === undefined) return true;
	return event.tier.rank >= minRank;
}
