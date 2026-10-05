/**
 * per-UP section 的「字段分域」判定 —— 单一真源。
 *
 * 「动态过滤」域是 `overrides.filters`(block* / allow*,见 FILTER_CONTENT_KEYS);「直播阈值」域是
 * `overrides.superchat`(醒目留言金额门槛)、`overrides.membership`(上舰档位门槛,B 站的是 `minRank.guard`)、独立的
 * `overrides.schedule`,与直播拆键搬出来的 `overrides.liveStart` / `overrides.liveStreaming`。
 * ㉓d 之前两个门槛和过滤共用 `overrides.filters` 一个切片,开一个域会让另一个 section 的 toggle / 侧栏小点被动亮起;
 * 搬成各自的切片以后这类误判从结构上没有了,但「这个 section 是否已覆盖 / 是否开启」的判定仍要按各自域内的字段来判,
 * box 内部 toggle 与侧栏 isSectionCustomized 共用此处常量,保证两处口径一致。
 */

import { GUARD_PROGRAM_ID } from "../../config/membership-programs";
import type {
	ContentFiltersOverride,
	LiveStartOverride,
	LiveStreamingOverride,
	MembershipOverride,
	ScheduleOverride,
	Subscription,
	SuperchatOverride,
} from "../../types/domain";
import type { SectionId } from "./sections";

/**
 * ContentFilters 里属于「动态过滤」域的字段:看内容的那几格 + 看作品「有没有转发 / 专栏 / 图集 / 视频」的四个开关。
 * 过滤吃中立的 `Post`,这两样对所有来源(B 站、拓展)一视同仁(ADR-0021 决策 43)。
 */
export const FILTER_CONTENT_KEYS = [
	"blockKeywords",
	"blockRegex",
	"allowKeywords",
	"allowRegex",
	"blockReposts",
	"blockArticles",
	"blockImages",
	"blockVideos",
] as const satisfies readonly (keyof ContentFiltersOverride)[];

/** 「动态过滤」域是否有任何覆盖字段。 */
export function hasFilterContentOverride(f: ContentFiltersOverride | undefined): boolean {
	return FILTER_CONTENT_KEYS.some((k) => f?.[k] !== undefined);
}

/**
 * 推送时间那几段 —— 免扰 / 断流接续(`schedule`),外加直播拆键(⑬d)从 `schedule` 里搬出来的周期间隔
 * (`liveStreaming`)与启动补报(`liveStart`)。拓展订阅的「推送时段」就是这几段。
 */
export interface LiveTimingSlices {
	schedule: ScheduleOverride | undefined;
	liveStart: LiveStartOverride | undefined;
	liveStreaming: LiveStreamingOverride | undefined;
}

/** 推送时间那几段是否有任何覆盖。 */
export function hasLiveTimingOverride(slices: LiveTimingSlices): boolean {
	return (
		slices.schedule !== undefined ||
		slices.liveStart !== undefined ||
		slices.liveStreaming !== undefined
	);
}

/** 「直播阈值」域里两个门槛的覆盖(㉓d,原先是 `overrides.filters` 里的 minScPrice / minGuardLevel)。 */
export interface LiveThresholdSlices {
	superchat: SuperchatOverride | undefined;
	membership: MembershipOverride | undefined;
}

/** 门槛那两段是否有任何覆盖:金额门槛,或 B 站的上舰档位门槛(别的体系的门槛没有界面,不看)。 */
export function hasLiveGateOverride(slices: LiveThresholdSlices): boolean {
	return (
		slices.superchat?.minAmount !== undefined ||
		slices.membership?.minRank?.[GUARD_PROGRAM_ID] !== undefined
	);
}

/** 「直播阈值」域是否有任何覆盖(两个门槛 或 推送时间那几段)。 */
export function hasLiveThresholdOverride(slices: LiveThresholdSlices & LiveTimingSlices): boolean {
	return hasLiveGateOverride(slices) || hasLiveTimingOverride(slices);
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
				superchat: sub.overrides.superchat,
				membership: sub.overrides.membership,
				schedule: sub.overrides.schedule,
				liveStart: sub.overrides.liveStart,
				liveStreaming: sub.overrides.liveStreaming,
			});
		case "schedule":
			return hasLiveTimingOverride({
				schedule: sub.overrides.schedule,
				liveStart: sub.overrides.liveStart,
				liveStreaming: sub.overrides.liveStreaming,
			});
		case "summary":
			return (
				sub.overrides.templates?.liveSummary !== undefined ||
				sub.overrides.templates?.wordcloudStopWords !== undefined
			);
		case "msg":
			return (
				sub.overrides.templates?.liveStart !== undefined ||
				sub.overrides.templates?.liveStreaming !== undefined ||
				sub.overrides.templates?.liveEnd !== undefined
			);
		case "dynamicMsg":
			return (
				sub.overrides.templates?.post !== undefined ||
				sub.overrides.templates?.postVideo !== undefined
			);
		case "messageLayout":
			return sub.overrides.messageLayout !== undefined;
		case "guard":
			return sub.overrides.templates?.membership?.[GUARD_PROGRAM_ID]?.enabled === true;
		// 特别关注是订阅的公共格;来源不支持的这一格恒空,自然判成没自定义。
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
