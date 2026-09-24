/**
 * 面板上「这一行 / 这个房间是哪条订阅」(ADR-0019 决策 50)。
 *
 * 推送链、历史、在播快照都按**订阅自己的 id** 记;B 站 uid 只是身份,同一个 UP 可以配几条订阅,
 * 按 uid 对就只能随手挑一条。纯函数、不碰 api:订阅列表由页面拿,这里只折成查表。
 */

import type { HistoryRowIdentity } from "@bilibili-notify/internal";
import { isBiliSubscription, type Subscription } from "../../types/domain";

export interface SubscriptionLookup {
	/** 按订阅自己的 id 查;没有就是 undefined。 */
	byId(id: string): Subscription | undefined;
	/**
	 * 历史行 → 订阅:先认订阅、再认人(决策 73)。先认行上的 `subscriptionId`;不在了(删了又重加的
	 * UP),B 站行找第一个 uid 相同的 **B 站**订阅,拓展行找第一个「同一个拓展 + 同一个外部 id」的
	 * **拓展**订阅 —— 与服务端重推的 `currentSubscriptionOf` 同一条规矩,同一个人几条时**先出现的**
	 * 说了算。**绝不跨支**:外部 id 恰好等于某个 B 站 uid 不算,那是另一个平台上的另一个人。
	 */
	forRow(row: HistoryRowIdentity): Subscription | undefined;
}

export function createSubscriptionLookup(subs: readonly Subscription[]): SubscriptionLookup {
	const byId = new Map<string, Subscription>();
	const byUid = new Map<string, Subscription>();
	// 拓展 id → 外部 id 两层,不拼成一串:外部 id 是拓展给的不透明字符串,拼就得选分隔符。
	const byExternal = new Map<string, Map<string, Subscription>>();
	for (const sub of subs) {
		byId.set(sub.id, sub);
		if (isBiliSubscription(sub)) {
			if (!byUid.has(sub.uid)) byUid.set(sub.uid, sub);
			continue;
		}
		let ofExtension = byExternal.get(sub.extensionId);
		if (!ofExtension) {
			ofExtension = new Map();
			byExternal.set(sub.extensionId, ofExtension);
		}
		if (!ofExtension.has(sub.externalId)) ofExtension.set(sub.externalId, sub);
	}
	return {
		byId: (id) => byId.get(id),
		forRow: ({ subscriptionId, uid, extensionId, externalId }) => {
			const own = byId.get(subscriptionId);
			if (own) return own;
			// 拓展那两格有一格就是拓展行,只在拓展那张表里找 —— 缺了一格也不退去按 uid 找。
			if (extensionId !== undefined || externalId !== undefined) {
				if (extensionId === undefined || externalId === undefined) return undefined;
				return byExternal.get(extensionId)?.get(externalId);
			}
			return uid === undefined ? undefined : byUid.get(uid);
		},
	};
}
