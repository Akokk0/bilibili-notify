import { subscriptionIdentityLabel } from "@bilibili-notify/contract";
import type { Identity, SourceDescriptor } from "@bilibili-notify/internal";

/** 取平台名与外部 id 叫法要问的两处:来源登记表,与拓展装载器(清单订阅源的平台名)。 */
export interface PlatformLabelDeps {
	sources: {
		get(
			sourceKey: string,
		): { descriptor: Pick<SourceDescriptor, "label" | "externalIdNoun"> } | undefined;
	};
	/** 拓展装载器说的平台名;取不到(拓展卸了、装载器还没起来)交 `undefined`。 */
	extensionPlatformLabel?: (extensionId: string) => string | undefined;
}

/**
 * 订阅所属平台的叫法(锐评的「平台」一列、女仆的订阅视图共用这一条链,ADR-0020 决策 12):在来源登记表里的来源
 * (B 站、以后别的内置来源)写它描述符的 `label`;不在登记表里的(拓展)写它清单里订阅源的平台名,取不到
 * 写来源键 —— 同面板(ADR-0019 决策 10)。
 */
export function platformLabelOf(sourceKey: string, deps: PlatformLabelDeps): string {
	return (
		deps.sources.get(sourceKey)?.descriptor.label ??
		deps.extensionPlatformLabel?.(sourceKey) ??
		sourceKey
	);
}

/**
 * 订阅的身份标签:平台名与外部 id 叫法都按来源现取,拼法只留在 contract。登记表里的来源优先于
 * 拓展装载器;不在册时退到清单平台名,再退到来源键。
 */
export function subscriptionIdentityLabelOf(identity: Identity, deps: PlatformLabelDeps): string {
	return subscriptionIdentityLabel(identity, {
		label: platformLabelOf(identity.sourceKey, deps),
		externalIdNoun: deps.sources.get(identity.sourceKey)?.descriptor.externalIdNoun,
	});
}
