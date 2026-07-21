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

// ---- /api/stats ------------------------------------------------------------

/**
 * 数据统计页的单个 UP 行。
 *
 * **`null` 一律表示「没有记录」,不是 0**:统计数据都是上线后才开始采集的,
 * 分不清「那天没涨粉」和「那天服务没跑」会让图表撒谎。前端对 null 的处理是
 * 不渲染,而不是补 0。
 */
export interface UpStatsRow {
	uid: string;
	/** 最近一次采样到的粉丝数;从未采到为 null。 */
	fans: number | null;
	/**
	 * 近 1 / 7 个本地日的净增 —— **口径固定,不随请求的 days 变**。
	 * 窗口比该口径还短时为 null(窗口里根本没有那么多天可加)。
	 */
	net1d: number | null;
	net7d: number | null;
	/**
	 * **整个请求窗口**的净增合计。UI 上标「近 N 日净增」的就是它。
	 *
	 * 曾经叫 `net30d` 并且恒取末 30 天,于是选「近90日」时标签写着 90 天、
	 * 数字却只加了 30 天。名字改掉是为了让这种错对不上号。
	 */
	netWindow: number | null;
	/** 每日净增序列,长度等于请求的 days,末位是今天。 */
	series: Array<number | null>;
	/**
	 * 每日**末值**(累计粉丝数)序列,长度同 `series`;`null` = 那天没有采样。
	 *
	 * 与 `series` 看似冗余,其实不是:净增的口径是「当日末值 − 前一个有数据的日的
	 * 末值」,窗口内第一个有数据的日没有基线、净增恒为 null,所以光靠净增反推累计
	 * 曲线会丢掉那一天,而今天还没采到样本时更是整条线都推不出来。索引信息在只传
	 * 净增的那一刻就丢了,补不回来 —— 详见 web 侧 `cumulativeFans`。
	 */
	cumulative: Array<number | null>;
	/**
	 * 每日活动次数(动态 + 投稿 + 开播),长度同 `series`,热力图用。
	 * `null` = 那天没有任何采样记录,与「当天没活动」的 0 区分。
	 */
	activity: Array<number | null>;
	/**
	 * 以下计数一律与 `activity` 同口径:窗口内**完全没有采集覆盖**时为 `null`,
	 * 而不是 0。
	 *
	 * 0 的意思是「我们在记,这段时间他确实什么都没发」;`null` 的意思是「我们
	 * 那阵子根本没在记」。曾经这几项恒为 number,于是老库升级后点开近 90 日,
	 * 一位实际投了 40 个稿的 UP 会显示「投稿 0 个」—— 而同一行的热力图正诚实地
	 * 画着一片「无记录」空格,两个数在同一屏里互相打脸。AI 锐评那边也一样:
	 * prompt 里「标注为无记录的字段不要据此判定该 UP 偷懒」对这几项从来没生效过。
	 */
	/** 窗口内的视频投稿数(来自动态流的 DYNAMIC_TYPE_AV)。 */
	archives: number | null;
	/** 窗口内的普通动态数(已剔除开播伪动态)。 */
	dynamics: number | null;
	/** 窗口内的开播场次(含仍在进行的那场)。 */
	liveSessions: number | null;
	/** 已闭合场次的总时长(小时)。 */
	liveHours: number | null;
	/**
	 * `liveSessions` 中**时长已知**的场次数 —— 求场均时长时用它当分母。
	 *
	 * 硬杀进程会留下没有下播帧的场次:它确实发生过,但时长无从得知。拿
	 * `liveSessions` 当分母会把这种场次当成「0 小时」,平白稀释场均值。
	 */
	liveTimedSessions: number | null;
	/** 各场峰值观看的最大值 / 平均值;从未采到为 null。 */
	peakViewers: number | null;
	avgPeakViewers: number | null;
	/** 最近一次可见活动(发动态或开播)的时间;窗口内没有则 null。 */
	lastActivityAt: string | null;
	/** 当前是否在直播。 */
	live: boolean;
}

/** AI 锐评的结构化结果。所有 UP 引用都是 uid,前端据此 join 名称与头像。 */
export interface StatsRoastResult {
	pigeon: { uid: string; reason: string };
	diligent: { uid: string; reason: string };
	roast: Array<{ uid: string; comment: string }>;
	/** 综合勤奋度 0-100。 */
	scores: Array<{ uid: string; score: number }>;
	/** 可直接推送到群里的周报文本。 */
	pushText: string;
}

/** `POST /api/stats/roast` 响应。`ok:false` 时只有 `err` 有意义。 */
export interface StatsRoastResponse {
	ok: boolean;
	err?: string;
	result?: StatsRoastResult;
}

/**
 * 单 UP 锐评的结果 —— `POST /api/stats/roast/:uid`。
 *
 * 与榜单式的 {@link StatsRoastResult} 是**两种形状**,不要试图合并:榜单讲的是
 * 「谁比谁强」,单人讲的是「他自己这段时间干了什么」,前者离开对照组就不成立。
 */
export interface StatsSoloRoastResult {
	uid: string;
	/** 一句话总评。 */
	verdict: string;
	/** 综合勤奋度 0-100。 */
	score: number;
	/** 分维度点评(涨粉 / 投稿 / 直播…),标题由模型自拟。 */
	highlights: Array<{ label: string; comment: string }>;
	/** 可直接推送到群里的短评。 */
	pushText: string;
}

/** `POST /api/stats/roast/:uid` 响应。 */
export interface StatsSoloRoastResponse {
	ok: boolean;
	err?: string;
	result?: StatsSoloRoastResult;
}

/**
 * `POST /api/stats/roast/push` 请求 —— 把**页面上已经生成的那一份**锐评推出去。
 *
 * 结果由前端回传,服务端不重新调模型:主人是看过卡片内容才决定推送的,重新生成会
 * 推出一份谁都没审过的文本(还要再烧一次 token、再等一轮)。服务端只信 uid,名称 /
 * 头像 / 配色一律自己 join —— 那几项前端说了不算。
 */
export type StatsRoastPushRequest = {
	targetId: string;
	/** 统计窗口天数,标在卡片上。 */
	days: number;
} & ({ kind: "board"; result: StatsRoastResult } | { kind: "solo"; result: StatsSoloRoastResult });

/** `POST /api/stats/roast/push` 响应。 */
export interface StatsRoastPushResponse {
	ok: boolean;
	err?: string;
	/**
	 * 实际投递形态。图片渲染开着且渲染成功 = `"image"`,否则回退 `"text"` ——
	 * 前端据此告诉用户「推的是图还是文字」,渲染悄悄失败时不至于看起来一切正常。
	 */
	mode?: "image" | "text";
}

export interface StatsOverviewResponse {
	/** 实际使用的窗口天数(服务端会 clamp)。 */
	days: number;
	rows: UpStatsRow[];
}

// ---- /api/fans -------------------------------------------------------------

export interface FansResponse {
	entries: FansRefreshEntry[];
}

// ---- 测试推送类端点(/api/push /api/cards /api/ai) --------------------------

/** `POST /api/push/:targetId/test` 响应;cards/test-push 与它同形。 */
export interface TestResponse {
	ok: boolean;
	latencyMs: number;
	err?: string;
}

/** `POST /api/cards/test-push` 响应 —— 与 push 的 TestResponse 同形。 */
export interface TestPushResponse {
	ok: boolean;
	latencyMs: number;
	err?: string;
}

/** `POST /api/ai/test-push` 响应 —— TestPushResponse 多一个 `reply` 供页面回显。 */
export interface AiTestPushResponse {
	ok: boolean;
	latencyMs: number;
	reply?: string;
	err?: string;
}

/** `POST /api/cards/preview` 响应。 */
export interface PreviewResponse {
	ok: boolean;
	dataUrl?: string;
	err?: string;
}

/** 卡片渲染的浏览器来源(二选一;都在时 endpoint 生效)。 */
export interface ChromeSourceDTO {
	chromePath?: string;
	chromeEndpoint?: string;
}

/** `GET /api/cards/render-source` 响应 —— System 页「卡片渲染浏览器」区的数据源。 */
export interface RenderSourceResponse {
	/** 渲染器当前是否可用(有 adapter 在位)。 */
	enabled: boolean;
	/** 在用来源;未启用时 null。 */
	source: ChromeSourceDTO | null;
	/** false = 无可写 bootstrap 配置(legacy/desktop),切换生效但重启不保留。 */
	persistable: boolean;
}

/** `POST /api/cards/enable-rendering` 响应。 */
export interface EnableRenderingResponse {
	ok: boolean;
	alreadyEnabled?: boolean;
	chromePath?: string;
	chromeEndpoint?: string;
	err?: string;
}

// ---- /api/qq ----------------------------------------------------------------

/** `GET /api/qq/sessions/:adapterId` 单条 —— 网关入站事件捞到的群/C2C 会话。 */
export interface QQDiscoveredEntry {
	scope: "group" | "private";
	/** group_openid(群)或用户 openid(C2C)。 */
	openid: string;
	/** 触发者用户名等展示提示 —— 群事件不带群名,只能靠它给用户辨认。 */
	displayHint?: string;
	/** 最近见到时间戳(ms)。 */
	lastSeenMs: number;
}

// ---- /api/backup ------------------------------------------------------------

/** What an import did — or, under `dryRun`, what it *would* do. */
export interface ImportResult {
	subscriptions: { upserted: number; deleted: number };
	adapters: { upserted: number; deleted: number };
	targets: { upserted: number; deleted: number };
	globalsApplied: boolean;
	cookiesRestored: boolean;
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
