/**
 * Dashboard data shapes — local mirrors of the standalone server's
 * /api/live + /api/history responses. Wire-compatible with
 * apps/server/src/routes/{live,history}.ts.
 */

export interface LiveListenerSnapshot {
	uid: string;
	roomId?: string;
	title?: string;
	cover?: string;
	/**
	 * B 站 WATCHED_CHANGE 给出的预格式化累计观看人数(如 "1.2万")。后端只在收到该
	 * WS 帧后才有值,刚开播前几秒可能仍是 undefined,UI 显示 "—"。
	 */
	viewers?: string;
	startedAt?: string;
	areaName?: string;
}

export type HistorySource =
	| "dynamic"
	| "live"
	| "sc"
	| "guard"
	| "special-danmaku"
	| "special-enter"
	| "live-summary";

export interface HistoryEntryView {
	id: string;
	ts: string;
	source: HistorySource;
	uid: string;
	subscriptionId: string;
	targetIds: string[];
	ok: boolean;
	text?: string;
	/** 写入时由后端 snapshot 的 UP 主名称 / 头像;老 entry 无此字段,前端 fallback 走 sub 查询。 */
	unameSnapshot?: string;
	uavatarSnapshot?: string;
}

export interface HistoryResponse {
	entries: HistoryEntryView[];
	cursor?: string;
}

/**
 * HI1:history 缓存按 limit 分键的消费者集合 —— Dashboard(100,KPI/趋势)
 * 与 History 页(200,完整列表)。三处(两页 + usePushEventsChannel 的 WS
 * patch)共用此单一来源,避免魔数漂移导致缓存键/WS patch 不一致。
 */
export const HISTORY_QUERY_LIMITS = [100, 200] as const;
export const historyQueryKey = (limit: number) => ["history", { limit }] as const;

/**
 * Wire-compat with apps/server/src/routes/logs.ts (LogArchiveEntry) + the WS
 * `log` channel level frames. Note 4 wire levels incl `warn` — wider than the
 * 3-value `LogLevel` config enum (error|info|debug).
 */
export type LogLineLevel = "debug" | "info" | "warn" | "error";

export interface LogLineView {
	ts: string;
	level: LogLineLevel;
	/** Emitting subsystem (e.g. "dynamic"). Absent on engine-error rows. */
	name?: string;
	msg: string;
	args?: unknown[];
}

export interface LogsResponse {
	entries: LogLineView[];
}

/**
 * `day` undefined = the live view (today + recent, newest-first); this is the
 * key the WS `log` tail `setQueryData`-appends to. Picking a past day yields a
 * DIFFERENT key so the frozen historical view isn't polluted by live frames —
 * same per-key isolation trick as `historyQueryKey(limit)`.
 */
export const LOGS_LIVE_KEY = "live";
export const logsQueryKey = (day?: string) => ["logs", { day: day ?? LOGS_LIVE_KEY }] as const;

/**
 * Wire-compat with apps/server/src/routes/fans.ts + WS `fans-refreshed` 事件。
 * 后端 FansPoller 每个 cron tick 输出一批 entries(本轮采到的所有 enabled subs)。
 * Bootstrap 阶段 entries 为空,FansPanel 显示"采样中…"。
 */
export interface FansEntry {
	uid: string;
	current: number;
	ts: string;
	deltaSubscribed: number | null;
	delta24h: number | null;
	delta7d: number | null;
}

export interface FansResponse {
	entries: FansEntry[];
}

/** Bucket history entries by ISO date (YYYY-MM-DD) and by 4 source families. */
export interface DailyBucket {
	d: string;
	live: number;
	dyn: number;
	sc: number;
	guard: number;
}

const FAMILY: Record<HistorySource, keyof Omit<DailyBucket, "d">> = {
	live: "live",
	"live-summary": "live",
	"special-enter": "live",
	"special-danmaku": "live",
	dynamic: "dyn",
	sc: "sc",
	guard: "guard",
};

/**
 * Wire-compat with `GET /api/history/daily`(apps/server/src/routes/history.ts)。
 * 服务端按日文件全量计数,payload 恒定 days 个桶 —— 此前趋势图用 limit=100 的
 * listing 结果在前端分桶,高推送量实例的 7 天窗口被截断,左侧柱子永远为空。
 */
export interface DailyHistoryCountView {
	/** YYYY-MM-DD,按客户端时区口径(tzOffset 随请求传给后端)。 */
	d: string;
	counts: Record<HistorySource, number>;
	total: number;
	failures: number;
}

export interface HistoryDailyResponse {
	days: DailyHistoryCountView[];
}

export const HISTORY_DAILY_DAYS = 7;
/** 单一来源:Dashboard 的 useQuery 与 usePushEventsChannel 的 WS patch 共用此键。 */
export const HISTORY_DAILY_QUERY_KEY = ["history-daily", { days: HISTORY_DAILY_DAYS }] as const;

/** tzOffset 用 JS getTimezoneOffset() 口径(UTC+8 → -480),日界跟随客户端本地时区。 */
export function historyDailyPath(): string {
	return `/api/history/daily?days=${HISTORY_DAILY_DAYS}&tzOffset=${new Date().getTimezoneOffset()}`;
}

/** 把按日计数折叠成柱状图的 4 源族桶,标签 YYYY-MM-DD → MM/DD。 */
export function foldDailyBuckets(days: DailyHistoryCountView[]): DailyBucket[] {
	return days.map((day) => {
		const bucket: DailyBucket = {
			d: day.d.slice(5).replace("-", "/"),
			live: 0,
			dyn: 0,
			sc: 0,
			guard: 0,
		};
		for (const [source, n] of Object.entries(day.counts) as [HistorySource, number][]) {
			bucket[FAMILY[source]] += n;
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
