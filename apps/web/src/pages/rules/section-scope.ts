/**
 * per-UP section 的「字段分域」判定 —— 单一真源。
 *
 * `overrides.filters`(ContentFilters)一个切片被两个 section 分域共写:
 * 「动态过滤」域写 block* / whitelist*(见 FILTER_CONTENT_KEYS);「直播阈值」域
 * 写 minScPrice / minGuardLevel(见 LIVE_FILTER_KEYS,外加独立的 overrides.schedule)。
 * 凡是「这个 section 是否已覆盖 / 是否开启」的判定,都必须按各自域内的字段来判,
 * 不能只看整个 `overrides.filters !== undefined` —— 否则开一个域会让另一个 section
 * 的 toggle / 侧栏小点被动亮起(共享切片非空即误判)。box 内部 toggle 与侧栏
 * isSectionCustomized 共用此处常量,保证两处口径一致。
 */

import type { ContentFiltersOverride, ScheduleOverride, Subscription } from "../../types/domain";
import type { SectionId } from "./sections";

/** ContentFilters 里属于「动态过滤」域的字段。 */
export const FILTER_CONTENT_KEYS = [
	"blockKeywords",
	"blockRegex",
	"whitelistKeywords",
	"whitelistRegex",
	"blockForward",
	"blockArticle",
	"blockDraw",
	"blockAv",
] as const satisfies readonly (keyof ContentFiltersOverride)[];

/** ContentFilters 里属于「直播阈值」域的字段(schedule 另算,不在 filters 切片里)。 */
export const LIVE_FILTER_KEYS = [
	"minScPrice",
	"minGuardLevel",
] as const satisfies readonly (keyof ContentFiltersOverride)[];

/** 「动态过滤」域是否有任何覆盖字段。 */
export function hasFilterContentOverride(f: ContentFiltersOverride | undefined): boolean {
	return FILTER_CONTENT_KEYS.some((k) => f?.[k] !== undefined);
}

/** 「直播阈值」域是否有任何覆盖(filters 的阈值字段 或 schedule 整段)。 */
export function hasLiveThresholdOverride(slices: {
	filters: ContentFiltersOverride | undefined;
	schedule: ScheduleOverride | undefined;
}): boolean {
	return (
		LIVE_FILTER_KEYS.some((k) => slices.filters?.[k] !== undefined) || slices.schedule !== undefined
	);
}

/** per-UP 子分类是否当前 sub 已设置覆盖 → 侧栏小红点。 */
export function isSectionCustomized(sub: Subscription, sectionId: SectionId): boolean {
	switch (sectionId) {
		case "filter":
			return hasFilterContentOverride(sub.overrides.filters);
		case "live":
			return hasLiveThresholdOverride({
				filters: sub.overrides.filters,
				schedule: sub.overrides.schedule,
			});
		case "summary":
			return (
				sub.overrides.templates?.liveSummary !== undefined ||
				sub.overrides.templates?.wordcloudStopWords !== undefined
			);
		case "msg":
			return (
				sub.overrides.templates?.liveStart !== undefined ||
				sub.overrides.templates?.liveOngoing !== undefined ||
				sub.overrides.templates?.liveEnd !== undefined
			);
		case "dynamicMsg":
			return (
				sub.overrides.templates?.dynamic !== undefined ||
				sub.overrides.templates?.dynamicVideo !== undefined
			);
		case "messageLayout":
			return sub.overrides.messageLayout !== undefined;
		case "guard":
			return sub.overrides.templates?.guardBuy?.enable === true;
		case "specialDanmaku":
			return (
				sub.specialUsers.some((u) => u.kinds.includes("danmaku")) ||
				Boolean(sub.overrides.templates?.specialDanmaku)
			);
		case "specialEnter":
			return (
				sub.specialUsers.some((u) => u.kinds.includes("enter")) ||
				Boolean(sub.overrides.templates?.specialUserEnter)
			);
		case "ai":
			return sub.overrides.ai !== undefined;
		case "imageGroup":
			return sub.overrides.imageGroup !== undefined;
		default:
			return false;
	}
}
