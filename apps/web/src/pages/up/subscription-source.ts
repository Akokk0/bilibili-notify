/**
 * 订阅源拓展在订阅页上的样子(ADR-0019 决策 4 / 5 / 10 / 41 / 51)—— 平台选择那一排、拓展订阅
 * 那张卡的平台徽章与「没开」、配置弹层只列这个源报的那几种特性,都从这儿取。
 *
 * 纯函数、不碰 api:来源表(`useSources`,名字、颜色、叫法、特性)与拓展列表(`useExtensions`,在不在跑)
 * 由页面拿,这里只翻译。
 */

import type { ExtensionDTO, SourceEntry } from "@bilibili-notify/contract";
import { EXTENSION_SOURCE_FEATURES } from "@bilibili-notify/internal/features";
import { isExtensionPresent } from "../../hooks/useExtensions";
import {
	BILIBILI_SOURCE_KEY,
	FEATURE_KEYS,
	FEATURE_LABELS,
	type FeatureKey,
	type Subscription,
	subscriptionIdentityOf,
} from "../../types/domain";

/** 描述符声明的特性,顺序跟 `FEATURE_KEYS` 走 —— 清单里怎么排都不影响弹层上的次序。 */
function sortedFeaturesOf(descriptor: SourceEntry["descriptor"]): FeatureKey[] {
	const declared: readonly FeatureKey[] = descriptor.supportedFeatures;
	return FEATURE_KEYS.filter((key) => declared.includes(key));
}

/** 拓展订阅最多能有的那几把特性 —— 认不出是哪个源报什么的时候(没装 / 清单读不出)按它画。 */
const EXTENSION_FEATURES_AT_MOST = EXTENSION_SOURCE_FEATURES;

/**
 * 新建订阅时平台选择那一排的拓展来源:**只列在跑的**(决策 10)—— 解析门要拓展本人在,停着的列出来
 * 也只能问出一个 404。来源表或拓展列表没回来就一个都不列,弹窗与今天一模一样。
 */
export function runningSources(
	sources: readonly SourceEntry[] | undefined,
	extensions: readonly ExtensionDTO[] | undefined,
): SourceEntry[] {
	const present = new Set((extensions ?? []).filter(isExtensionPresent).map((ext) => ext.id));
	return (sources ?? []).filter((entry) => present.has(entry.key));
}

/** 一条拓展订阅是哪个平台的、那个平台能报什么、此刻在不在。 */
export interface SubscriptionPlatform {
	/**
	 * 平台的名字:来源表里描述符的 `label`(取自清单);来源表里没有就退拓展的名字;没装、或两张表
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

/**
 * 只看订阅记在哪个拓展名下 —— 首页在播那一行在订阅列表回来之前就要画徽章,手里只有拓展 id。
 */
export function subscriptionPlatformOf(
	sub: { extensionId: string },
	sources: readonly SourceEntry[] | undefined,
	extensions: readonly ExtensionDTO[] | undefined,
): SubscriptionPlatform {
	const ext = extensions?.find((one) => one.id === sub.extensionId);
	const descriptor = sources?.find((one) => one.key === sub.extensionId)?.descriptor;
	return {
		label: descriptor?.label ?? ext?.name ?? sub.extensionId,
		shortLabel: descriptor?.shortLabel,
		color: descriptor?.color,
		postNoun: descriptor?.postNoun,
		features: descriptor ? sortedFeaturesOf(descriptor) : EXTENSION_FEATURES_AT_MOST,
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
	if (subscriptionIdentityOf(sub).sourceKey === BILIBILI_SOURCE_KEY) return FEATURE_KEYS;
	return platform?.features ?? EXTENSION_FEATURES_AT_MOST;
}

/** 特性在面板上叫什么:「动态」按平台的叫法走(`postNoun`,抖音叫「作品」),其余照旧。 */
export function featureLabelOf(
	key: FeatureKey,
	platform: Pick<SubscriptionPlatform, "postNoun"> | undefined,
): string {
	if (key === "post" && platform?.postNoun) return platform.postNoun;
	return FEATURE_LABELS[key];
}
