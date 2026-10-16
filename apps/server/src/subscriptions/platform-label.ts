import type { SourceDescriptor } from "@bilibili-notify/internal";

/** 取平台名要问的两处:来源登记表(只读描述符的 `label`),与拓展装载器(清单订阅源的平台名)。 */
export interface PlatformLabelDeps {
	sources: { get(sourceKey: string): { descriptor: Pick<SourceDescriptor, "label"> } | undefined };
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
