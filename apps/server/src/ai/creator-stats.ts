import type { AiPostView, AiStatsView } from "@bilibili-notify/ai";
import type { StatsOverviewResponse } from "@bilibili-notify/contract";
import { timezoneOffsetMinutes } from "@bilibili-notify/internal";
import { statsFileKey } from "../stats/file-key.js";
import type { StatsStore } from "../stats/store.js";

/** 女仆读统计的口(`createEngines` 的 `creatorStats` 选项就是它)。按**订阅 id**认,不认来源。 */
export interface CreatorStatsReader {
	/** 数据统计总开关此刻开着没有(每次现问,不留快照)。 */
	isEnabled(): boolean;
	/** 这条订阅最近 `limit` 条作品,新的在前;没记到是空数组。 */
	recentPosts(subscriptionId: string, limit: number): Promise<AiPostView[]>;
	/** 这条订阅最近 `days` 天在统计总览里的那一行(挑出女仆要的几格);总览里没有这一行回 `undefined`。 */
	statsRow(subscriptionId: string, days: number): Promise<Omit<AiStatsView, "days"> | undefined>;
}

/**
 * 造女仆读统计的口:作品读统计仓、统计读统计总览读口(面板、锐评共用的那一个,同一份缓存、同一套聚合,不另写一份),
 * 总开关问装配处递进来的缓存读口。
 *
 * 切天按设置里的全局时区(同定时锐评,`runtime/roast-scheduler.ts`);偏移取「此刻」那一个。
 */
export function createCreatorStatsReader(deps: {
	store: Pick<StatsStore, "listRecentPosts">;
	isEnabled: () => boolean;
	timezone: () => string;
	overview: (days: number, tzOffsetMin: number) => Promise<StatsOverviewResponse>;
}): CreatorStatsReader {
	return {
		isEnabled: () => deps.isEnabled(),
		async recentPosts(subscriptionId, limit) {
			const entries = await deps.store.listRecentPosts(statsFileKey({ id: subscriptionId }), limit);
			return entries.map((e) => ({
				publishedAt: e.publishedAt,
				...(e.title === undefined ? {} : { title: e.title }),
				...(e.summary === undefined ? {} : { summary: e.summary }),
			}));
		},
		async statsRow(subscriptionId, days) {
			const { rows } = await deps.overview(
				days,
				timezoneOffsetMinutes(deps.timezone(), new Date()),
			);
			const row = rows.find((r) => r.subscriptionId === subscriptionId);
			if (!row) return undefined;
			return {
				followers: row.followers,
				netWindow: row.netWindow,
				posts: row.posts,
				videoPosts: row.videoPosts,
				liveSessions: row.liveSessions,
				liveHours: row.liveHours,
				lastActivityAt: row.lastActivityAt,
			};
		},
	};
}
