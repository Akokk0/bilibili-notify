import {
	type SourceNouns,
	sourceNounsOf,
	subscriptionIdentityLabel,
} from "@bilibili-notify/contract";
import {
	type Identity,
	type SourceDescriptor,
	type Subscription,
	subscriptionIdentityOf,
} from "@bilibili-notify/internal";

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

/** 提示词叫法还要问登记表在册的来源、启用订阅,以及拓展清单里的作品叫法。 */
export interface SourceNounsDeps extends PlatformLabelDeps {
	sources: {
		get(sourceKey: string):
			| {
					descriptor: Pick<
						SourceDescriptor,
						"label" | "creatorNoun" | "externalIdNoun" | "postNoun"
					>;
			  }
			| undefined;
		/** 一个启用订阅都没有时,取登记表里在册的来源。 */
		list(): readonly { sourceKey: string }[];
	};
	/** 拓展清单的 `display.postNoun`;取不到交 `undefined`,由 contract 落中性词。 */
	extensionPostNoun?: (extensionId: string) => string | undefined;
	/** 全局范围取其中启用的订阅的来源键。 */
	subscriptions: () => readonly Subscription[];
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

/** 按这次涉及的范围给提示词叫法;不给范围时取全局,选择只交给 contract。 */
export function sourceNounsFor(
	sourceKeys: readonly string[] | undefined,
	deps: SourceNounsDeps,
	neutral: SourceNouns,
): SourceNouns {
	const keys = sourceKeys ?? fallbackSourceKeys(deps);
	const platforms = [...new Set(keys)].map((sourceKey) => {
		const descriptor = deps.sources.get(sourceKey)?.descriptor;
		return descriptor === undefined
			? {
					label: platformLabelOf(sourceKey, deps),
					postNoun: deps.extensionPostNoun?.(sourceKey),
				}
			: {
					label: descriptor.label,
					creatorNoun: descriptor.creatorNoun,
					postNoun: descriptor.postNoun,
				};
	});
	return sourceNounsOf(platforms, neutral);
}

function fallbackSourceKeys(deps: SourceNounsDeps): readonly string[] {
	const enabled = deps
		.subscriptions()
		.filter((sub) => sub.enabled)
		.map((sub) => subscriptionIdentityOf(sub).sourceKey);
	return enabled.length > 0 ? enabled : deps.sources.list().map((source) => source.sourceKey);
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
