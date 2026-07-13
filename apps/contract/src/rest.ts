/**
 * REST wire 契约 —— apps/server 各路由的响应 DTO,apps/web 按原样消费。
 * 域模型本体(Subscription / GlobalConfig / …)在 `@bilibili-notify/internal`,
 * 这里只放「服务端 join / 投影出来的」wire 形状。
 */

import type {
	CachedProfile,
	FansRefreshEntry,
	HistorySource,
	Subscription,
	SubscriptionState,
} from "@bilibili-notify/internal";
import type { LogLevel } from "./ws";

export type { FansRefreshEntry, HistorySource };

// ---- /api/subs ------------------------------------------------------------

/**
 * `Subscription` 的 wire 形状:internal 域模型 + 服务端 SubRuntimeStore join
 * 回来的外置运行时字段(cachedProfile / state / 关注状态)。
 *
 * **followed 决定订阅能不能工作**:动态走 `feed/all`(关注流),没关注就一条动态
 * 都收不到。`undefined` = 服务端还没检查过(老数据 / 当时未登录),**不等于**
 * 「未关注」—— 别拿它去吓用户。
 */
export type SubscriptionDTO = Subscription & {
	cachedProfile?: CachedProfile;
	state: SubscriptionState;
	followed?: boolean;
	/** `followed === false` 时的原因(风控 / 被拉黑 / 断网…),直接展示给用户。 */
	followError?: string;
};

// ---- /api/history ----------------------------------------------------------

export interface HistoryEntryView {
	id: string;
	ts: string;
	source: HistorySource;
	uid: string;
	subscriptionId: string;
	targetIds: string[];
	ok: boolean;
	text?: string;
	imageRef?: string;
	/** 写入时 snapshot 的 UP 主名称 / 头像;老 entry 无此字段。 */
	unameSnapshot?: string;
	uavatarSnapshot?: string;
}

export interface HistoryResponse {
	entries: HistoryEntryView[];
}

/** `GET /api/history/daily` 的单日桶,日界按请求携带的 tzOffset(客户端时区)。 */
export interface DailyHistoryCount {
	/** 按 tzOffsetMin 口径的本地日 YYYY-MM-DD。 */
	d: string;
	counts: Record<HistorySource, number>;
	total: number;
	failures: number;
}

export interface HistoryDailyResponse {
	days: DailyHistoryCount[];
}

// ---- /api/logs -------------------------------------------------------------

/** Archived line shape. `args` kept as opaque JSON (already redacted). */
export interface LogArchiveEntry {
	ts: string;
	level: LogLevel;
	name?: string;
	msg: string;
	args?: unknown[];
}

export interface LogsResponse {
	entries: LogArchiveEntry[];
}

// ---- /api/fans -------------------------------------------------------------

export interface FansResponse {
	entries: FansRefreshEntry[];
}

// ---- /api/live -------------------------------------------------------------

/** `GET /api/live/listening` 的单房间条目,由 LiveEngine 的 per-session 快照投影。 */
export interface LiveListenerSnapshot {
	uid: string;
	roomId: string;
	isLive: boolean;
	title?: string;
	cover?: string;
	areaName?: string;
	startedAt?: string;
	/** B 站 WATCHED_CHANGE 帧给出的累计观看(预格式化字符串,如 "1.2万")。 */
	viewers?: string;
}
