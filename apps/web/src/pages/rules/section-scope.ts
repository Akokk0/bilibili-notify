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
const LIVE_FILTER_KEYS = [
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

/**
 * 「AI 人格」域是否真的覆盖着 —— 判据是**挑中的那份人格真实存在**,而不是
 * `overrides.ai` 这个键在不在。
 *
 * 盘上有三种指不着人格的老值:当年那档「继承全局」(`'inherit'`)、当年那档
 * 「完全自定义」(`'custom'`)、以及指向一份后来被删掉的人格。它们在 `resolveAI`
 * 眼里都是完整继承全局,所以设置页那一格照实显示「继承」—— 侧栏小点必须跟着同一
 * 个判据,否则就会在一个明明写着「继承」的分类旁边亮起来。
 */
export function hasAiPersonaOverride(
	ai: Subscription["overrides"]["ai"],
	presets: readonly { id: string }[],
): boolean {
	return ai !== undefined && presets.some((p) => p.id === ai.preset);
}

/**
 * per-UP 子分类是否当前 sub 已设置覆盖 → 侧栏小红点。
 *
 * `presets` 只有 AI 那一格用得上(见 {@link hasAiPersonaOverride})。缺省空列表 =
 * 任何 preset 都指不着 = AI 那格恒不亮,对其余分类没有影响。
 */
export function isSectionCustomized(
	sub: Subscription,
	sectionId: SectionId,
	presets: readonly { id: string }[] = [],
): boolean {
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
			return hasAiPersonaOverride(sub.overrides.ai, presets);
		case "imageGroup":
			return sub.overrides.imageGroup !== undefined;
		default:
			return false;
	}
}
