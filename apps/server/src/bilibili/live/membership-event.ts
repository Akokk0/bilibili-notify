/**
 * **B 站上舰事件 → 中立的会员事件**(ADR-0021 决策 26 下 2026-10-05 的 🔗,㉓b)。
 *
 * 这一步还没有调用方:直播引擎今天仍直接拿 `guard-buy` 拼文字、出卡(`room-session.ts`),㉓c 接线时换成先翻成
 * {@link MembershipEvent} 再交给出卡与文案。档位怎么认(`guard_level` 与 rank 的倒序换算)全在 `guardTierOf`,
 * 这里不重复。
 */

import { guardTierOf, type MembershipEvent } from "@bilibili-notify/internal";
import type { LiveEvent } from "./events.js";

type GuardBuyEvent = Extract<LiveEvent, { kind: "guard-buy" }>;

/**
 * 上舰事件 → {@link MembershipEvent}。认不出的档位(`guard_level` 不是 1 / 2 / 3)回 `undefined`,
 * 由调用方丢弃并记一条警告(原来是带着一张空图推出去,㉓c 改)。
 *
 * 只填上舰消息里真有的格子,缺了就缺键:
 * - 观众只有 id 与名字,**没有头像**(会员卡的头像要重新接一次查询,3a);
 * - 月数取事件的 `num`;金额取 `price`(金瓜子,÷1000 为人民币)并标明币种 `CNY`;
 * - **不填** `action` / `gift` / `tenure`:开通还是续费、谁送的,上舰消息里没有(续费时 B 站同秒发三帧,
 *   业务只消费这一帧,另两帧带的 `opType` 不并流)。
 *
 * @param subscriptionId 核心查出来的订阅 id,来源不知道;调用方传进来。
 */
export function membershipEventFromLiveEvent(
	event: GuardBuyEvent,
	subscriptionId: string,
): MembershipEvent | undefined {
	const tier = guardTierOf(event.guardLevel);
	if (tier === undefined) return undefined;
	return {
		subscriptionId,
		viewer: { id: String(event.user.uid), name: event.user.name },
		program: "guard",
		tier: { key: tier.key, name: tier.name, rank: tier.rank },
		...(event.num !== undefined ? { months: event.num } : {}),
		...(event.price !== undefined ? { amount: event.price / 1000, currency: "CNY" } : {}),
	};
}
