import type { Identity } from "@bilibili-notify/internal";

/** 一个来源报给叫法函数的几格(都来自来源描述符或拓展清单)。 */
export interface SourceNounsInput {
	label?: string;
	creatorNoun?: string;
	postNoun?: string;
}

/** 叫法函数给出的三样:提示词变量 `{creatorNoun}` `{postNoun}` `{sources}` 就填它们。 */
export interface SourceNouns {
	creatorNoun: string;
	postNoun: string;
	sources: string;
}

/**
 * 按这次涉及的来源给叫法。调用方要先把来源去重,一个来源只交一项。
 * 恰好一个来源时用它的叫法;零个或多个来源时落调用方递进来的中性词,混着时不让任何一个来源替别的来源说话。
 * 给人看的中性词从字典取;给模型的中性词用 `packages/ai` 的 `PROMPT_NEUTRAL_NOUNS`。
 */
export function sourceNounsOf(
	platforms: readonly SourceNounsInput[],
	neutral: SourceNouns,
): SourceNouns {
	if (platforms.length === 1) {
		const [platform] = platforms;
		if (platform !== undefined) {
			return {
				creatorNoun: filled(platform.creatorNoun) ?? neutral.creatorNoun,
				postNoun: filled(platform.postNoun) ?? neutral.postNoun,
				sources: filled(platform.label) ?? neutral.sources,
			};
		}
	}

	const labels = new Set<string>();
	for (const platform of platforms) {
		const label = filled(platform.label);
		if (label !== undefined) labels.add(label);
	}
	return {
		creatorNoun: neutral.creatorNoun,
		postNoun: neutral.postNoun,
		sources: labels.size > 0 ? [...labels].join("、") : neutral.sources,
	};
}

/** 按来源的叫法拼身份标签:声明了叫法写「UID 123」,否则写「平台 · 123」。 */
export function subscriptionIdentityLabel(
	identity: Pick<Identity, "externalId">,
	platform: { label: string; externalIdNoun?: string },
): string {
	const noun = platform.externalIdNoun?.trim();
	return noun ? `${noun} ${identity.externalId}` : `${platform.label} · ${identity.externalId}`;
}

/**
 * 显示名只有一条链:事件名 → 资料名 → 身份标签。空串与只有空白的都不算名字。
 * 面板上标「备注」的 `notes` 是自由文字(「推给一群,周末别推」),不当名字用,所以这里不收它。
 */
export function displayNameOf(
	names: { eventName?: string; profileName?: string },
	identityLabel: string,
): string {
	return filled(names.eventName) ?? filled(names.profileName) ?? identityLabel;
}

function filled(text: string | undefined): string | undefined {
	return text !== undefined && text.trim() !== "" ? text : undefined;
}
