/**
 * 面板上「这一行 / 这个房间是哪条订阅」(ADR-0019 决策 50)。
 *
 * 推送链、历史、在播快照都按**订阅自己的 id** 记;B 站 uid 只是身份,同一个 UP 可以配几条订阅,
 * 按 uid 对就只能随手挑一条。纯函数、不碰 api:订阅列表由页面拿,这里只折成查表。
 */

import type { HistoryRowIdentity } from "@bilibili-notify/internal";
import { type SourceKey, type Subscription, subscriptionIdentityOf } from "../../types/domain";

export interface SubscriptionLookup {
	/** 按订阅自己的 id 查;没有就是 undefined。 */
	byId(id: string): Subscription | undefined;
	/**
	 * 历史行 → 订阅:先认订阅、再认人(决策 73)。先认行上的 `subscriptionId`;不在了(删了又重加的
	 * UP),找第一个**身份相同**(来源键 + 外部 id 两格一起比)的订阅 —— 与服务端重推的
	 * `currentSubscriptionOf` 同一条规矩,同一个人几条时**先出现的**说了算。**绝不跨来源**:外部 id
	 * 恰好等于某个 B 站 uid 不算,那是另一个平台上的另一个人。
	 */
	forRow(row: HistoryRowIdentity): Subscription | undefined;
}

export function createSubscriptionLookup(subs: readonly Subscription[]): SubscriptionLookup {
	const byId = new Map<string, Subscription>();
	// 来源键 → 外部 id 两层,不拼成一串:外部 id 是来源给的不透明字符串,拼就得选分隔符。
	const byIdentity = new Map<SourceKey, Map<string, Subscription>>();
	for (const sub of subs) {
		byId.set(sub.id, sub);
		const { sourceKey, externalId } = subscriptionIdentityOf(sub);
		let ofSource = byIdentity.get(sourceKey);
		if (!ofSource) {
			ofSource = new Map();
			byIdentity.set(sourceKey, ofSource);
		}
		if (!ofSource.has(externalId)) ofSource.set(externalId, sub);
	}
	return {
		byId: (id) => byId.get(id),
		forRow: (row) => {
			const own = byId.get(row.subscriptionId);
			if (own) return own;
			return byIdentity.get(row.identity.sourceKey)?.get(row.identity.externalId);
		},
	};
}
