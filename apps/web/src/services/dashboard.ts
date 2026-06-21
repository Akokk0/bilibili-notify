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
	/** Emitting subsystem (e.g. "bilibili-notify:dynamic"). Absent on engine-error rows. */
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
 * Group entries into the last `days` daily buckets (inclusive of today).
 * Empty days still appear so the bar chart x-axis is stable.
 */
export function bucketByDay(entries: HistoryEntryView[], days = 7): DailyBucket[] {
	const out: DailyBucket[] = [];
	const today = new Date();
	for (let i = days - 1; i >= 0; i--) {
		const d = new Date(today);
		d.setDate(today.getDate() - i);
		const iso = d.toISOString().slice(0, 10);
		out.push({ d: iso.slice(5).replace("-", "/"), live: 0, dyn: 0, sc: 0, guard: 0 });
	}
	const idxOf = new Map(out.map((b, i) => [b.d, i]));
	for (const e of entries) {
		const iso = e.ts.slice(0, 10).slice(5).replace("-", "/");
		const idx = idxOf.get(iso);
		if (idx == null) continue;
		const bucket = out[idx];
		bucket[FAMILY[e.source]] += 1;
	}
	return out;
}

/** 本地时区的 YYYY-MM-DD —— 「今日」按用户本地 0 点翻篇,而非 UTC(toISOString 的口径)。 */
export function localDayKey(date: Date): string {
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, "0");
	const d = String(date.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

/**
 * 统计「今日」(本地时区)的推送总数与失败数。entry.ts 是后端 `new Date().toISOString()`
 * 生成的 UTC ISO,经 `new Date()` 解析回本地日再与今天比较 —— 北京凌晨 0~8 点的推送不会
 * 被 UTC 日界甩到「昨天」。「今日失败」与「今日推送」同口径(本地日)。
 */
export function countToday(
	entries: HistoryEntryView[],
	now: Date = new Date(),
): { pushes: number; failures: number } {
	const todayKey = localDayKey(now);
	let pushes = 0;
	let failures = 0;
	for (const e of entries) {
		if (localDayKey(new Date(e.ts)) !== todayKey) continue;
		pushes += 1;
		if (!e.ok) failures += 1;
	}
	return { pushes, failures };
}
