/** 来源表的面板投影。来源身份、声明与运行态共用一个公共读口。 */
import type { SourceEntry, SourceRunStatus } from "@bilibili-notify/contract";
import type { ExtraKey, Identity, MembershipProgram } from "@bilibili-notify/internal";
import { i18n } from "../../i18n";
import { FEATURE_KEYS, type FeatureKey, type Subscription } from "../../types/domain";

export function registeredSources(sources: readonly SourceEntry[] | undefined): SourceEntry[] {
	return (sources ?? []).filter((entry) => entry.has !== undefined);
}

export interface SubscriptionPlatform {
	label: string;
	shortLabel?: string;
	icon?: string;
	color?: string;
	colorByExternalId?: boolean;
	postNoun?: string;
	creatorNoun?: string;
	externalIdNoun?: string;
	features: readonly FeatureKey[];
	featureHints?: Partial<Record<FeatureKey, string>>;
	supportedExtras: readonly ExtraKey[];
	membershipPrograms?: MembershipProgram[];
	status: SourceRunStatus;
	absent: boolean | undefined;
	showBadge: boolean;
}

export function subscriptionPlatformOf(
	identity: Pick<Identity, "sourceKey">,
	sources: readonly SourceEntry[] | undefined,
): SubscriptionPlatform {
	const entry = sources?.find((one) => one.key === identity.sourceKey);
	const descriptor = entry?.descriptor;
	return {
		label: descriptor?.label ?? identity.sourceKey,
		shortLabel: descriptor?.shortLabel,
		icon: descriptor?.icon,
		color: descriptor?.color,
		colorByExternalId: descriptor?.colorByExternalId,
		postNoun: descriptor?.postNoun,
		creatorNoun: descriptor?.creatorNoun,
		externalIdNoun: descriptor?.externalIdNoun,
		features: FEATURE_KEYS.filter((key) => descriptor?.supportedFeatures.includes(key)),
		featureHints: descriptor?.featureHints,
		supportedExtras: descriptor?.supportedExtras ?? [],
		membershipPrograms: descriptor?.membershipPrograms,
		status: entry?.status ?? "unknown",
		absent: sources === undefined ? undefined : entry === undefined,
		showBadge: sources === undefined || entry === undefined || sources.length > 1,
	};
}

export function visibleFeaturesOf(
	_sub: Subscription,
	platform: SubscriptionPlatform | undefined,
): readonly FeatureKey[] {
	return platform?.features ?? [];
}

export function featureLabelOf(
	key: FeatureKey,
	platform: Pick<SubscriptionPlatform, "postNoun"> | undefined,
): string {
	if (key === "post" && platform?.postNoun) return platform.postNoun;
	const labels: Record<FeatureKey, string> = {
		post: i18n.t("sources.features.post"),
		liveStart: i18n.t("sources.features.liveStart"),
		liveStreaming: i18n.t("sources.features.liveStreaming"),
		liveEnd: i18n.t("sources.features.liveEnd"),
		superchat: i18n.t("sources.features.superchat"),
		membership: i18n.t("sources.features.membership"),
		viewerChat: i18n.t("sources.features.viewerChat"),
		viewerEnter: i18n.t("sources.features.viewerEnter"),
	};
	return labels[key];
}

export function extraLabelOf(key: ExtraKey): string {
	const labels: Record<ExtraKey, string> = {
		atAllPost: i18n.t("sources.extras.atAllPost"),
		atAllLiveStart: i18n.t("sources.extras.atAllLiveStart"),
		wordcloud: i18n.t("sources.extras.wordcloud"),
		liveSummary: i18n.t("sources.extras.liveSummary"),
	};
	return labels[key];
}
