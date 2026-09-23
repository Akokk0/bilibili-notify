/**
 * 面板上「这一行 / 这个房间是哪条订阅」(ADR-0019 决策 50)。
 *
 * 推送链、历史、在播快照都按**订阅自己的 id** 记;B 站 uid 只是身份,同一个 UP 可以配几条订阅,
 * 按 uid 对就只能随手挑一条。纯函数、不碰 api:订阅列表由页面拿,这里只折成查表。
 */

import { isBiliSubscription, type Subscription } from "../../types/domain";

export interface SubscriptionLookup {
	/** 按订阅自己的 id 查;没有就是 undefined。 */
	byId(id: string): Subscription | undefined;
	/**
	 * 历史行 → 订阅:先认行上的 `subscriptionId`;不在了(删了又重加的 UP)再找第一个 uid 相同的
	 * **B 站**订阅 —— 与服务端重推的 `currentSubscriptionOf` 同一条规矩,同 uid 几条时**先出现的**
	 * 说了算。拓展订阅的外部 id 恰好等于那串 uid 不算:那是另一个平台上的另一个人。
	 */
	forRow(row: { subscriptionId: string; uid: string }): Subscription | undefined;
}

export function createSubscriptionLookup(subs: readonly Subscription[]): SubscriptionLookup {
	const byId = new Map<string, Subscription>();
	const byUid = new Map<string, Subscription>();
	for (const sub of subs) {
		byId.set(sub.id, sub);
		if (isBiliSubscription(sub) && !byUid.has(sub.uid)) byUid.set(sub.uid, sub);
	}
	return {
		byId: (id) => byId.get(id),
		forRow: ({ subscriptionId, uid }) => byId.get(subscriptionId) ?? byUid.get(uid),
	};
}
