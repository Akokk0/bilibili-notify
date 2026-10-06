import type { FeatureFlags } from "@bilibili-notify/internal";
import { needsLiveMonitor } from "@bilibili-notify/live";

/**
 * 统计「这一项在不在记」要看的开关(ADR-0027 决策 1 / 2):作品开关开着,与直播类开关任一开着
 * (监听直播间的那份判定,`@bilibili-notify/live` 的 {@link needsLiveMonitor},只此一份)。
 * 两边都已经把订阅覆盖合并进全局默认(`resolve` 之后的 `features`),这里不再合并。
 */
export interface RecordingSwitches {
	/** 作品开关开着。 */
	posts: boolean;
	/** 直播类开关任一开着(含特别弹幕 / 特别关注进场)。 */
	live: boolean;
}

/** 特别弹幕、特别关注进场两个条件是否成立(订阅的 `specialUsers` 里有对应种类)。拓展订阅没有,传 `false`。 */
export interface SpecialUserFlags {
	danmaku: boolean;
	enter: boolean;
}

export function recordingSwitches(
	features: Pick<
		FeatureFlags,
		"post" | "liveStart" | "liveStreaming" | "liveEnd" | "membership" | "superchat"
	>,
	special: SpecialUserFlags,
): RecordingSwitches {
	return {
		posts: features.post,
		live: needsLiveMonitor({
			liveStart: features.liveStart,
			liveStreaming: features.liveStreaming,
			liveEnd: features.liveEnd,
			membership: features.membership,
			superchat: features.superchat,
			customSpecialDanmakuUsers: { enable: special.danmaku, msgTemplate: "" },
			customSpecialUsersEnterTheRoom: { enable: special.enter, msgTemplate: "" },
		}),
	};
}

/**
 * 一条订阅的特殊用户条件:看它的 `specialUsers` 里有没有对应种类。拓展订阅没有设置特殊用户的入口,
 * 这两格天然是空(与「传关」同一个结果)。
 */
export function specialUserFlagsOf(sub: {
	specialUsers: readonly { kinds: readonly string[] }[];
}): SpecialUserFlags {
	return {
		danmaku: sub.specialUsers.some((u) => u.kinds.includes("danmaku")),
		enter: sub.specialUsers.some((u) => u.kinds.includes("enter")),
	};
}
