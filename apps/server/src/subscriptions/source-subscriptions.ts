import {
	FEATURE_KEYS,
	type FeatureKey,
	type GlobalConfig,
	needsLiveMonitor,
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
 * - `monitorsLive` 是每条折好后经 `needsLiveMonitor` 的判定,重复订阅取或;
 * - 同一个人遗留的重复订阅合成一条,`features` 取并集;条目按第一次出现的先后。
 *
 * 作品开关关着的人也在名单里(只是 `features` 里没有 `post`):名单只按启用与否列,开着哪些由 `features` 说,
 * 来源自己照它决定查不查(没开作品的不抓动态;B 站的关注同步也只对 `features` 里有 `post` 的人做)。
 */
export function sourceSubscriptionViews(
	subscriptions: readonly Subscription[],
	sourceKey: string,
	defaults: GlobalConfig["defaults"],
): SourceSubscriptionView[] {
	const merged = new Map<string, { features: Set<FeatureKey>; monitorsLive: boolean }>();
	for (const sub of subscriptions) {
		const identity = subscriptionIdentityOf(sub);
		if (identity.sourceKey !== sourceKey || !sub.enabled) continue;
		const effective = resolve(sub, defaults);
		const monitorsLive = needsLiveMonitor(effective);
		let entry = merged.get(identity.externalId);
		if (!entry) {
			entry = { features: new Set(), monitorsLive: false };
			merged.set(identity.externalId, entry);
		}
		entry.monitorsLive ||= monitorsLive;
		for (const key of FEATURE_KEYS) if (effective.features[key]) entry.features.add(key);
	}
	return [...merged].map(([externalId, entry]) => ({ externalId, ...entry }));
}

/**
 * 一个来源里「名单上开着这项特性的人」名下的全部订阅(与 {@link sourceSubscriptionViews} 同一份算法)。
 * 同一个人遗留的重复订阅有一条符合,这个人就算,他名下的每一条(连停用的、没开这一项的)都归入 —— 按人做的事
 * (比如关注)结果要记给他名下的每一条。
 */
export function subscriptionsOfFeature(
	subscriptions: readonly Subscription[],
	sourceKey: string,
	defaults: GlobalConfig["defaults"],
	feature: FeatureKey,
): Subscription[] {
	const wanted = new Set(
		sourceSubscriptionViews(subscriptions, sourceKey, defaults)
			.filter((view) => view.features.has(feature))
			.map((view) => view.externalId),
	);
	return subscriptions.filter((sub) => {
		const identity = subscriptionIdentityOf(sub);
		return identity.sourceKey === sourceKey && wanted.has(identity.externalId);
	});
}
