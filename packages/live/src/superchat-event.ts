/**
 * **B 站醒目留言事件 → 中立的醒目留言事件**(ADR-0021 决策 26 下 2026-10-05 的 🔗,㉓b)。
 *
 * 「按价格算档」原来住在出图器里(`getSCLevel(price * 10)`),现在归 B 站这一侧:档由来源按平台规矩算,
 * 出图只认 {@link SuperchatEvent.tier} 的 `rank`。这一步还没有调用方,㉓c 接线。
 */

import type { LiveEvent } from "@bilibili-notify/blive";
import type { SuperchatEvent } from "@bilibili-notify/internal";

type SuperChatEvent = Extract<LiveEvent, { kind: "superchat" }>;

/**
 * 醒目留言的档(rank 从 1 起、1 最低),按元算。六档的线 —— 50 / 100 / 500 / 1000 / 2000 —— 与出图器
 * 原来的 `getSCLevel(price * 10)`(电池 500 / 1000 / 5000 / 10000 / 20000)是同一组,边界照今天:
 * 等于线算上一档。
 */
function rankOfPrice(yuan: number): number {
	if (yuan >= 2000) return 6;
	if (yuan >= 1000) return 5;
	if (yuan >= 500) return 4;
	if (yuan >= 100) return 3;
	if (yuan >= 50) return 2;
	return 1;
}

/**
 * 醒目留言事件 → {@link SuperchatEvent}。金额是事件的 `price`(元)、币种 `CNY`,档是 `tier.rank`
 * (见 {@link rankOfPrice})。
 *
 * @param subscriptionId 核心查出来的订阅 id,来源不知道;调用方传进来。
 */
export function superchatEventFromLiveEvent(
	event: SuperChatEvent,
	subscriptionId: string,
): SuperchatEvent {
	return {
		subscriptionId,
		viewer: { id: String(event.user.uid), name: event.user.uname },
		text: event.content,
		amount: event.price,
		currency: "CNY",
		tier: {
			rank: rankOfPrice(event.price),
			// 留言挂多久取消息自带的秒数(解析器早就读出来了,原来没往下传);没带就缺键。
			...(event.durationSec !== undefined ? { durationSec: event.durationSec } : {}),
		},
	};
}
