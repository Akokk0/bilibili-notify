import { type FeatureFlags, needsLiveMonitor, type SpecialViewer } from "@bilibili-notify/internal";

/**
 * 统计「这一项在不在记」要看的开关(ADR-0027 决策 1 / 2):作品开关开着,与直播类开关任一开着
 * (监听直播间的那份判定,internal 的 {@link needsLiveMonitor},只此一份)。
 * 两边都已经把订阅覆盖合并进全局默认(`resolve` 之后的 `features`),这里不再合并。
 */
export interface RecordingSwitches {
	/** 作品开关开着。 */
	posts: boolean;
	/** 直播类开关任一开着,或某把特别开关开着且名单上有人带它。 */
	live: boolean;
}

export function recordingSwitches(
	features: Pick<
		FeatureFlags,
		| "post"
		| "liveStart"
		| "liveStreaming"
		| "liveEnd"
		| "membership"
		| "superchat"
		| "viewerChat"
		| "viewerEnter"
	>,
	specialViewers: readonly Pick<SpecialViewer, "features">[],
): RecordingSwitches {
	return {
		posts: features.post,
		live: needsLiveMonitor({ features, specialViewers }),
	};
}
