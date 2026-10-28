import {
	FEATURE_KEYS,
	type FeatureKey,
	type SourceSubscriptionView,
} from "@bilibili-notify/internal";
import { createDevtoolsProviderRegistry } from "../../../../devtools/providers.js";
import {
	createDevRegistry,
	type DevRegistry,
	type DevScenarioDef,
} from "../../../../devtools/registry.js";

/**
 * 测试里建注册表的方式与真入口一致:场景先登进登记表认领 `bilibili`,再由登记表建注册表 —— 断言里的
 * id 就是面板上看到的 id。`roster` 是 B 站的名单:`creator` 参数照它核(真入口里核的是同一份订阅表)。
 */
export function biliRegistry(
	scenarios: DevScenarioDef[],
	roster: readonly SourceSubscriptionView[] = [],
): DevRegistry {
	const providers = createDevtoolsProviderRegistry();
	providers.claim("bilibili", { scenarios });
	return createDevRegistry(providers, {
		creators: (sourceKey) =>
			sourceKey === "bilibili" ? roster.map((view) => view.externalId) : [],
	});
}

/** 名单里的一个人(`ctx.subscriptions()` 那一份的形状),默认全部特性开着。 */
export function rosterEntry(
	externalId: string,
	features: readonly FeatureKey[] = FEATURE_KEYS,
): SourceSubscriptionView {
	return { externalId, features: new Set(features), monitorsLive: true };
}
