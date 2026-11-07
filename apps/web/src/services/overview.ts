/**
 * Overview 数据形状 + query-key 工具。
 *
 * wire 类型的单一来源是 `@bilibili-notify/contract`(apps/server 同源消费),
 * 这里只做 re-export 与旧名别名(`import type`,编译后全擦除);本文件自留的
 * 只剩 UI 侧的 query key 常量与分桶工具。
 */

import type { DailyHistoryCount } from "@bilibili-notify/contract";
import { FEATURE_DESCRIPTORS, type PushFamily } from "../config/push-features";
import type { FeatureKey } from "../types/domain";

export type {
	DailyHistoryCount as DailyHistoryCountView,
	FollowersRefreshEntry,
	FollowersResponse,
	HistoryDailyResponse,
	HistoryEntryView,
	HistoryMessageView,
	HistoryRepushResponse,
	HistoryRepushView,
	HistoryResponse,
	// `/api/live/listening` 的一行:一条此刻在播的订阅,来源看 `identity`。
	LiveListeningEntry,
	// `/api/system/logs` 归档行与 WS `log` 帧共用的行视图。
	LogArchiveEntry as LogLineView,
	// wire 4 值日志级别(含 warn)比 3 值配置枚举宽,别名维持旧命名。
	LogLevel as LogLineLevel,
	LogsResponse,
	PushStatus,
} from "@bilibili-notify/contract";

/**
 * HI1:history 缓存按 limit 分键的消费者集合 —— Overview(100,KPI/趋势)
 * 与 History 页(200,完整列表)。三处(两页 + usePushEventsChannel 的 WS
 * patch)共用此单一来源,避免魔数漂移导致缓存键/WS patch 不一致。
 */
export const HISTORY_QUERY_LIMITS = [100, 200] as const;
export const historyQueryKey = (limit: number) => ["history", { limit }] as const;

/**
 * 粉丝快照(`GET /api/stats/followers`)的缓存键。首页粉丝面板读它,WS `followers-refreshed` 整体覆盖它 ——
 * 读与写必须是**同一个键**:写错了键,WS 推过来的新快照落进一个没人读的缓存,面板停在旧值上,而两头
 * 各自的测试照样全绿。所以两处都从这儿取,别各写一份字面量。
 */
export const FOLLOWERS_QUERY_KEY = ["stats", "followers"] as const;

/**
 * `day` undefined = the live view (today + recent, newest-first); this is the
 * key the WS `log` tail `setQueryData`-appends to. Picking a past day yields a
 * DIFFERENT key so the frozen historical view isn't polluted by live frames —
 * same per-key isolation trick as `historyQueryKey(limit)`.
 */
const LOGS_LIVE_KEY = "live";
export const logsQueryKey = (day?: string) =>
	["system", "logs", { day: day ?? LOGS_LIVE_KEY }] as const;

/** Bucket history entries by ISO date (YYYY-MM-DD) and by 4 feature families. */
/** 柱状图的一天:四个家族各一根柱。键是 ui 的 StatsBar 定的(动态那根叫 `dyn`)。 */
export interface DailyBucket {
	d: string;
	live: number;
	dyn: number;
	sc: number;
	guard: number;
}

/** 家族 → 柱子键。八把特性折成四族那条规则只有 FEATURE_DESCRIPTORS 一份,这里只改个名(柱子键是 ui 的 StatsBar 定的)。 */
const BAR_KEY_OF_FAMILY = {
	live: "live",
	post: "dyn",
	superchat: "sc",
	membership: "guard",
} as const satisfies Record<PushFamily, keyof Omit<DailyBucket, "d">>;

function barKeyOf(feature: FeatureKey): keyof Omit<DailyBucket, "d"> {
	return BAR_KEY_OF_FAMILY[FEATURE_DESCRIPTORS[feature].family];
}

export const HISTORY_DAILY_DAYS = 7;
/** 单一来源:Overview 的 useQuery 与 usePushEventsChannel 的 WS patch 共用此键。 */
export const HISTORY_DAILY_QUERY_KEY = ["history-daily", { days: HISTORY_DAILY_DAYS }] as const;

/** tzOffset 用 JS getTimezoneOffset() 口径(UTC+8 → -480),日界跟随客户端本地时区。 */
export function historyDailyPath(): string {
	return `/api/history/daily?days=${HISTORY_DAILY_DAYS}&tzOffset=${new Date().getTimezoneOffset()}`;
}

/** 把按日计数折叠成柱状图的 4 家族桶,标签 YYYY-MM-DD → MM/DD。 */
export function foldDailyBuckets(days: DailyHistoryCount[]): DailyBucket[] {
	return days.map((day) => {
		const bucket: DailyBucket = {
			d: day.d.slice(5).replace("-", "/"),
			live: 0,
			dyn: 0,
			sc: 0,
			guard: 0,
		};
		for (const [feature, n] of Object.entries(day.counts) as [FeatureKey, number][]) {
			bucket[barKeyOf(feature)] += n;
		}
		return bucket;
	});
}

/**
 * 本地时区的 YYYY-MM-DD —— 「今日」按用户本地 0 点翻篇,而非 UTC(toISOString 的口径)。
 * 与 historyDailyPath 传给后端的 tzOffset 同一口径,WS patch 据此定位 entry 所属的日桶。
 */
export function localDayKey(date: Date): string {
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, "0");
	const d = String(date.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}
