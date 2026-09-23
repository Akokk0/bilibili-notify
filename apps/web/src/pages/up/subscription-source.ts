/**
 * 订阅源拓展在订阅页上的样子(ADR-0019 决策 4 / 5 / 10 / 41 / 51)—— 平台选择那一排、拓展订阅
 * 那张卡的平台徽章与「没开」、配置弹层只列这个源报的那几种特性,都从这儿取。
 *
 * 纯函数、不碰 api:拓展列表由页面拿(`useExtensions`),这里只翻译。
 */

import type { ExtensionDTO } from "@bilibili-notify/contract";
import type { SubscriptionEventKind } from "@bilibili-notify/internal";
import { SUBSCRIPTION_EVENT_FEATURES } from "@bilibili-notify/internal/constants";
import { isExtensionPresent } from "../../hooks/useExtensions";
import {
	type ExtensionSubscription,
	FEATURE_KEYS,
	FEATURE_LABELS,
	type FeatureKey,
	isBiliSubscription,
	type Subscription,
} from "../../types/domain";

/** 开了订阅那一口、交了外观与事件的拓展。 */
export type SubscriptionSourceExtension = ExtensionDTO & {
	subscription: NonNullable<ExtensionDTO["subscription"]>;
};

/**
 * 这几种事件对应 BN 的哪几把特性(决策 4 那张表),顺序跟 `FEATURE_KEYS` 走 —— 清单里怎么排
 * 都不影响弹层上的次序。
 */
export function featuresForEvents(events: readonly SubscriptionEventKind[]): FeatureKey[] {
	const wanted = new Set<FeatureKey>(events.map((e) => SUBSCRIPTION_EVENT_FEATURES[e]));
	return FEATURE_KEYS.filter((k) => wanted.has(k));
}

/** 拓展订阅最多能有的那几把特性 —— 认不出是哪个源报什么的时候(没装 / 清单读不出)按它画。 */
const EXTENSION_FEATURES_AT_MOST = featuresForEvents(
	Object.keys(SUBSCRIPTION_EVENT_FEATURES) as SubscriptionEventKind[],
);

/**
 * 新建订阅时平台选择那一排:**只列在跑的**(决策 10)—— 解析门要拓展本人在,停着的列出来
 * 也只能问出一个 404。拓展列表没回来就一个都不列,弹窗与今天一模一样。
 */
export function runningSubscriptionSources(
	extensions: readonly ExtensionDTO[] | undefined,
): SubscriptionSourceExtension[] {
	return (extensions ?? []).filter(
		(ext): ext is SubscriptionSourceExtension =>
			ext.subscription !== undefined && isExtensionPresent(ext),
	);
}

/** 一条拓展订阅是哪个平台的、那个平台能报什么、此刻在不在。 */
export interface SubscriptionPlatform {
	/**
	 * 平台的名字:清单里的 `display.label`;清单没交订阅那一口就退拓展的名字;没装、或拓展列表
	 * 没回来时拿不到名字,写拓展 id(决策 10)。
	 */
	label: string;
	/** 徽章上的短名。认不出时没有,徽章退回 `label`。 */
	shortLabel?: string;
	/** 标识色。认不出时没有,徽章退回「认不出」那档灰。 */
	color?: string;
	/** 这个平台管「一条动态」叫什么(抖音:作品)。 */
	postNoun?: string;
	/** 这个源报得出的那几把特性;认不出时按拓展订阅最多能有的那几种。 */
	features: readonly FeatureKey[];
	/**
	 * 拓展此刻不在场(停用 / 没起来 / 没装)。**`undefined` = 不知道**:拓展列表还在读或读失败,
	 * 那一刻说「没开」是冤枉它(同推送目标页的 `absentExtensionOf`)。
	 */
	absent: boolean | undefined;
}

export function subscriptionPlatformOf(
	sub: ExtensionSubscription,
	extensions: readonly ExtensionDTO[] | undefined,
): SubscriptionPlatform {
	const ext = extensions?.find((one) => one.id === sub.extensionId);
	const view = ext?.subscription;
	return {
		label: view?.display.label ?? ext?.name ?? sub.extensionId,
		shortLabel: view?.display.shortLabel,
		color: view?.display.color,
		postNoun: view?.display.postNoun,
		features: view ? featuresForEvents(view.events) : EXTENSION_FEATURES_AT_MOST,
		absent: extensions === undefined ? undefined : !(ext && isExtensionPresent(ext)),
	};
}

/**
 * 这条订阅在面板上列哪几把特性:B 站订阅全列;拓展订阅只列它那个源报得出的(决策 5)——
 * 上舰 / SC / 特别弹幕 / 特别关注进场是 B 站独有的,摆出来就是一个永远不会响的开关。
 */
export function visibleFeaturesOf(
	sub: Subscription,
	platform: SubscriptionPlatform | undefined,
): readonly FeatureKey[] {
	if (isBiliSubscription(sub)) return FEATURE_KEYS;
	return platform?.features ?? EXTENSION_FEATURES_AT_MOST;
}

/** 特性在面板上叫什么:「动态」按平台的叫法走(`postNoun`,抖音叫「作品」),其余照旧。 */
export function featureLabelOf(
	key: FeatureKey,
	platform: Pick<SubscriptionPlatform, "postNoun"> | undefined,
): string {
	if (key === "dynamic" && platform?.postNoun) return platform.postNoun;
	return FEATURE_LABELS[key];
}
