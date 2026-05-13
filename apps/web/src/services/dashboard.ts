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
}

export interface HistoryResponse {
	entries: HistoryEntryView[];
	cursor?: string;
}

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
