/**
 * Dynamic 折叠层 —— Subscription → DynamicEngine 视图的两层折算
 * (per-UP override ?? 静态默认),koishi-free。
 *
 * 收敛 dynamic-service.ts 原本散落的三处重复:
 *   - storeToSubscriptionsView(store, defaults) → storeToDynamicView(store)
 *   - applyOps 翻译 add/update 时手写 resolve()+视图 → subToDynamicView
 *
 * 与 live 端 sub-view.ts 同模式:dynamic 消费 features.dynamic + cardStyle +
 * imageGroup + templates.dynamic/dynamicVideo 的 per-UP 覆盖,不消费 filters /
 * schedule / ai。
 */

import type { SubscriptionsView } from "@bilibili-notify/dynamic";
import { DEFAULT_FEATURE_FLAGS, type Subscription } from "@bilibili-notify/internal";

/** per-UP override ?? 静态默认。false 不会被默认 true 吃掉。 */
export function resolveDynamicFeature(sub: Subscription): boolean {
	return sub.overrides.features?.dynamic ?? DEFAULT_FEATURE_FLAGS.dynamic;
}

/** Subscription → DynamicEngine 单条视图(含 customCardStyle 折算)。 */
export function subToDynamicView(sub: Subscription): SubscriptionsView[string] {
	return {
		uid: sub.uid,
		uname: sub.uid,
		dynamic: resolveDynamicFeature(sub),
		customCardStyle: sub.overrides.cardStyle
			? {
					enable: true,
					cardColorStart: sub.overrides.cardStyle.cardColorStart,
					cardColorEnd: sub.overrides.cardStyle.cardColorEnd,
				}
			: { enable: false },
		// per-UP imageGroup override 直接透传 raw 值;engine 内 `?? config.imageGroup`
		// 兜底到 BilibiliNotifyDynamicConfig.imageGroup.{enable,forward}。
		imageGroupEnable: sub.overrides.imageGroup?.enable,
		imageGroupForward: sub.overrides.imageGroup?.forward,
		// per-UP 动态/视频文本模板覆盖;engine 内 `?? config.dynamicTemplate/videoTemplate`
		// 兜底。advanced-subscription 折叠 customDynamicMsg 后写进 overrides.templates。
		customDynamicTemplate: sub.overrides.templates?.dynamic,
		customVideoTemplate: sub.overrides.templates?.dynamicVideo,
	};
}

/** SubscriptionStore → DynamicEngine 全量视图,跳过 disabled 订阅。 */
export function storeToDynamicView(store: { list: () => Subscription[] }): SubscriptionsView {
	const view: SubscriptionsView = {};
	for (const sub of store.list()) {
		if (!sub.enabled) continue;
		view[sub.uid] = subToDynamicView(sub);
	}
	return view;
}
