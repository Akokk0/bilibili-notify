import {
	FEATURE_KEYS,
	type FeatureKey,
	type GlobalConfig,
	resolve,
	type SourceSubscriptionView,
	type Subscription,
	subscriptionIdentityOf,
} from "@bilibili-notify/internal";

/**
 * 一个来源的名单 —— 全仓只有这一个算法。
 *
 * - 只取身份落在这个来源上、且启用中的订阅;
 * - `features` 是折好的开关(订阅覆盖压过全局默认),不看有没有目标;
 * - 同一个人遗留的重复订阅合成一条,`features` 取并集;条目按第一次出现的先后。
 *
 * 作品开关关着的人也在名单里(只是 `features` 里没有 `post`):「没开就不查」是后面的事。
 */
export function sourceSubscriptionViews(
	subscriptions: readonly Subscription[],
	sourceKey: string,
	defaults: GlobalConfig["defaults"],
): SourceSubscriptionView[] {
	const merged = new Map<string, Set<FeatureKey>>();
	for (const sub of subscriptions) {
		const identity = subscriptionIdentityOf(sub);
		if (identity.sourceKey !== sourceKey || !sub.enabled) continue;
		const features = resolve(sub, defaults).features;
		let set = merged.get(identity.externalId);
		if (!set) {
			set = new Set();
			merged.set(identity.externalId, set);
		}
		for (const key of FEATURE_KEYS) if (features[key]) set.add(key);
	}
	return [...merged].map(([externalId, features]) => ({ externalId, features }));
}
