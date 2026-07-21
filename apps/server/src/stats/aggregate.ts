import type { FansSample } from "../fans/store.js";
import type { LiveSessionRecord, UpDynamicEvent } from "./store.js";

/**
 * stats 聚合层 —— 纯函数,不碰 IO。路由只负责把 store 读出来的原始序列喂进来。
 *
 * 单独成层的理由是**口径**:动态类型归类、日界怎么切、未闭合直播算不算时长,
 * 这些决定同时影响页面上好几个数字。散在路由里改一处漏一处,集中在这里才能
 * 用测试把口径钉死。
 */

/** 动态在统计口径下的归类。 */
export type DynamicKind = "archive" | "dynamic" | "ignored";

/** 视频投稿 —— 设计稿「投稿」一栏的唯一来源。 */
const ARCHIVE_TYPES = new Set(["DYNAMIC_TYPE_AV"]);
/**
 * 开播伪动态。B 站会把「某某开播了」塞进动态流,但直播场次我们已经从
 * `live-state-changed` 单独记了,两边都计就会把一场直播算两次。
 */
const IGNORED_TYPES = new Set(["DYNAMIC_TYPE_LIVE_RCMD", "DYNAMIC_TYPE_LIVE"]);

/**
 * 全仓唯一给动态类型定语义的地方。未知类型一律归为普通动态而不是丢弃 ——
 * B 站随时会加新类型,漏计比错计更难被发现。
 */
export function classifyDynamic(type: string): DynamicKind {
	if (ARCHIVE_TYPES.has(type)) return "archive";
	if (IGNORED_TYPES.has(type)) return "ignored";
	return "dynamic";
}

/**
 * ISO 时刻 → 本地日 `YYYY-MM-DD`(`getTimezoneOffset()` 口径,UTC+8 → -480)。
 * 解析不出时返回 `null`,调用方据此跳过按日的比较而不是拿一个坏日期去比。
 */
export function localDayKey(iso: string, tzOffsetMin = 0): string | null {
	const ms = Date.parse(iso);
	if (Number.isNaN(ms)) return null;
	return new Date(ms - tzOffsetMin * 60_000).toISOString().slice(0, 10);
}

/**
 * 窗口起点 —— **窗口首日的本地 00:00**,不是「此刻往前推 N×24 小时」。
 *
 * 页面上每条序列都按本地日分桶(`dailyFansSeries` / `dailyActivityCounts`),而窗口
 * 合计数(投稿 / 动态 / 场次 / 时长)是拿这个起点直接去筛原始记录的。两把尺子不一致
 * 的话,合计数会多吃进热力图与净增柱状图从未展示过的那小半天:UTC+8 的客户端在本地
 * 10:00 打开近 30 日,滚动起点落在 06-21 15:00,而日轴从 06-22 起 —— 06-21 傍晚投的
 * 那个视频让 KPI 写着「投稿 8 个」,同一块面板的热力图只算得出 7。时区偏移越大漏得
 * 越多,极端情况整整多进一天。
 *
 * 与前端 `dayAxis(days)` 的首日严格同一天,那正是「同一把尺子」的定义。
 */
export function windowSinceIso(days: number, tzOffsetMin: number, now = new Date()): string {
	const firstDayMs = now.getTime() - (days - 1) * 86_400_000;
	const firstDay = localDayKey(new Date(firstDayMs).toISOString(), tzOffsetMin);
	// localDayKey 只在时间戳不可解析时返回 null,这里的输入恒合法;真出岔子就退回
	// 旧的滚动口径,总比抛出去让整个 overview 挂掉强。
	if (!firstDay) return new Date(now.getTime() - days * 86_400_000).toISOString();
	return new Date(Date.parse(`${firstDay}T00:00:00.000Z`) + tzOffsetMin * 60_000).toISOString();
}

export interface DynamicCounts {
	archives: number;
	dynamics: number;
}

export function countDynamics(events: readonly UpDynamicEvent[]): DynamicCounts {
	let archives = 0;
	let dynamics = 0;
	for (const e of events) {
		const kind = classifyDynamic(e.type);
		if (kind === "archive") archives++;
		else if (kind === "dynamic") dynamics++;
	}
	return { archives, dynamics };
}

/** 某个本地日的粉丝数据点。`null` = 该日无样本,与「零净增」严格区分。 */
export interface DailyFansPoint {
	/** 本地日 YYYY-MM-DD。 */
	d: string;
	/** 相对前一个有数据的日的净增。 */
	net: number | null;
	/** 当日最后一个采样值(累计粉丝数)。 */
	value: number | null;
}

export interface DailySeriesOptions {
	/** 窗口天数(含今天)。 */
	days: number;
	/** 客户端时区偏移,`Date.prototype.getTimezoneOffset()` 口径(UTC+8 → -480)。 */
	tzOffsetMin?: number;
	/** 注入时钟,测试用。 */
	now?: Date;
}

/**
 * 把 fans 原始采样按**本地日**归并成每日净增序列。
 *
 * 净增取「当日末值 − 前一个有数据的日的末值」。刻意不是「当日首末差」——
 * 采样是 2min 一次,跨零点那一小段的涨粉要归到新的一天,用日末值链式相减
 * 才不会把它漏掉。
 *
 * 某日无样本(服务停了 / 刚订阅)时 `net` 和 `value` 都是 `null`,而不是 0:
 * 「那天没涨粉」和「那天没记录」在图上必须能区分开,否则停机一周会显示成
 * 平稳的零增长直线。
 */
export function dailyFansSeries(
	samples: readonly FansSample[],
	opts: DailySeriesOptions,
): DailyFansPoint[] {
	const tz = opts.tzOffsetMin ?? 0;
	const nowMs = (opts.now ?? new Date()).getTime();
	const localKey = (utcMs: number) => new Date(utcMs - tz * 60_000).toISOString().slice(0, 10);

	// 每个本地日的末值。samples 是时间升序的,后写覆盖前写即得末值。
	const lastByDay = new Map<string, number>();
	for (const s of samples) {
		const ms = Date.parse(s.ts);
		if (Number.isNaN(ms)) continue;
		lastByDay.set(localKey(ms), s.value);
	}

	const wantedDays: string[] = [];
	for (let i = opts.days - 1; i >= 0; i--) wantedDays.push(localKey(nowMs - i * 86_400_000));

	// 基线要能回溯到窗口之前:窗口第一天的净增依赖窗口外的前一日末值。
	const sortedDays = [...lastByDay.keys()].sort();
	const priorValue = (day: string): number | undefined => {
		let found: number | undefined;
		for (const d of sortedDays) {
			if (d >= day) break;
			found = lastByDay.get(d);
		}
		return found;
	};

	return wantedDays.map((d) => {
		const value = lastByDay.get(d);
		if (value === undefined) return { d, net: null, value: null };
		const base = priorValue(d);
		return { d, net: base === undefined ? null : value - base, value };
	});
}

/**
 * 逐日活动次数 —— 热力图的数据源。一条动态、一次投稿、一场开播各算一次。
 *
 * 单独一个函数而不是复用 `countDynamics`,是因为热力图要的是**按天散开**的
 * 分布,而不是窗口总计;两者的口径必须共用同一套归类(开播伪动态照样剔除),
 * 否则热力图和表格里的数字会对不上。
 */
export function dailyActivityCounts(
	events: readonly UpDynamicEvent[],
	sessions: readonly LiveSessionRecord[],
	opts: DailySeriesOptions,
): number[] {
	const tz = opts.tzOffsetMin ?? 0;
	const nowMs = (opts.now ?? new Date()).getTime();
	const localKey = (utcMs: number) => new Date(utcMs - tz * 60_000).toISOString().slice(0, 10);

	const counts = new Map<string, number>();
	const bump = (iso: string) => {
		const ms = Date.parse(iso);
		if (Number.isNaN(ms)) return;
		const k = localKey(ms);
		counts.set(k, (counts.get(k) ?? 0) + 1);
	};

	for (const e of events) {
		if (classifyDynamic(e.type) === "ignored") continue;
		bump(e.ts);
	}
	// 直播按**开播**那天记一次,不按跨天时长摊开 —— 通宵直播算一次活动。
	for (const s of sessions) bump(s.startedAt);

	const out: number[] = [];
	for (let i = opts.days - 1; i >= 0; i--) {
		out.push(counts.get(localKey(nowMs - i * 86_400_000)) ?? 0);
	}
	return out;
}

export interface LiveSummary {
	/** 窗口内的场次(含仍在直播的那场)。 */
	sessions: number;
	/** 总时长(小时)。已闭合的场按实际时长,仍在播的按「开播到现在」。 */
	hours: number;
	/**
	 * 其中**时长已知**的场次数 —— 求场均时长时的分母。
	 *
	 * 硬杀进程会留下没有 end 帧的场次:它确实发生过(所以计进 `sessions`),但时长
	 * 无从得知(所以不进 `hours`)。若拿 `sessions` 当分母,「一场 4 小时 + 一场未知」
	 * 会算出场均 2 小时 —— 两场里没有任何一场是 2 小时。与 `avgPeakViewers` 只除
	 * 「采到峰值的场次」同一个道理:未知不是零。
	 */
	timedSessions: number;
	/** 各场峰值中的最大值;无样本时 null。 */
	peakViewers: number | null;
	/** 各场峰值的平均 —— 是「场均峰值」,不是「平均在线」,别在 UI 上标错。 */
	avgPeakViewers: number | null;
}

/**
 * 把 B 站的压缩观看数字符串解析成数字。与 recorder 里的同名逻辑同源 ——
 * 那边为了比大小,这边为了求和求平均。
 */
function parseViewers(raw: string): number {
	const m = raw.trim().match(/^([\d.]+)\s*(万|亿)?$/);
	if (!m) return Number.NaN;
	const n = Number(m[1]);
	if (!Number.isFinite(n)) return Number.NaN;
	if (m[2] === "万") return n * 10_000;
	if (m[2] === "亿") return n * 100_000_000;
	return n;
}

export function summarizeLiveSessions(
	sessions: readonly LiveSessionRecord[],
	opts: { now?: Date; isLive?: boolean; sinceMs?: number } = {},
): LiveSummary {
	const nowMs = (opts.now ?? new Date()).getTime();
	let hours = 0;
	let timedSessions = 0;
	const peaks: number[] = [];
	for (const s of sessions) {
		// 未闭合的场按「开播到现在」计时长,但**仅限最后一场、且此刻确实在播**。
		//
		// 曾经这里只计场次不计时长,理由是「拿现在补一个下播时间会让这一场的时长
		// 随刷新增长,历史统计就不幂等了」。那个理由是错的:**在播时长按定义就是
		// 时点相关的**,而略过它带来的是实打实的错数 —— 服务器在 UP 开播中途启动
		// 时,那一场直到下播为止都算 0 小时,「直播时长 Top」直接空着。
		//
		// 但「未闭合」有两种,不能一视同仁:
		//   · store 标了 `current`(帧流读完仍敞着)+ UP 此刻在播 → 真·进行中;
		//   · 其余未闭合 → 进程当时被杀、end 帧永远没写。按到现在算的话,这条
		//     悬空记录会一直涨到滑出时间窗为止(最长 90 天 ≈ 2160 小时)。
		// 「哪一场敞着」由 store 在配对时标出,不能靠数组位置猜 —— 场次按
		// startedAt 认之后,被重新打开的早场次未必排在末尾。
		// 是否**真的在播**只有引擎知道,所以 isLive 由调用方注入;缺省 false ——
		// 拿不到权威状态时宁可少算,也不放任一条坏记录无限增长。
		// 已闭合的场不读 now,历史数据照旧幂等。
		// 不看 `!s.endedAt`:直播中重启会在盘上留下一帧关服截断的 end,随后的 start
		// 说明那时它还在播。`current` 是「最后一次观测时敞着」,isLive 是「此刻真在播」,
		// 两者同时为真就按进行中算 —— 否则那一场的时长会永久冻结在关服时刻。
		const inProgress = s.current === true && opts.isLive === true;
		// 悬空记录只是不计时长,场次与峰值照常参与 —— 那场直播确实发生过。
		if (s.endedAt || inProgress) {
			// 进行中优先于盘上那帧 end:它是被截断的,不是真的下播时刻。
			const endMs = inProgress ? nowMs : Date.parse(s.endedAt as string);
			// 起点夹到窗口内。`listLiveSessions` 会放行**跨窗口起始且仍在播**的那一场
			// (否则 30 小时的挂机直播在「近 1 日」里整场消失,而同一行还亮着直播中
			// 徽章),但它窗口之前的那段小时数不该记到这个窗口头上。其余场次的
			// startedAt 本就 ≥ 窗口起点,这里是 no-op。
			const startMs = Math.max(Date.parse(s.startedAt), opts.sinceMs ?? Number.NEGATIVE_INFINITY);
			const ms = endMs - startMs;
			// 只有真的算出一个可用时长,这一场才既进 `hours` 也进分母。
			//
			// 二者必须同进同退:曾经 `timedSessions++` 提在这个判断之外,于是
			// end 早于 start(时钟回拨 / 坏数据)的那一场**不计时长却占着分母**,
			// 「一场 4 小时 + 一场坏数据」照样算出场均 2 小时 —— 正是本文件
			// 反复要杜绝的那个数。算不出时长就是时长未知,与悬空场次同类,
			// 不是时长为零。
			if (Number.isFinite(ms) && ms > 0) {
				timedSessions++;
				hours += ms / 3_600_000;
			}
		}
		if (s.peakViewers !== undefined) {
			const v = parseViewers(s.peakViewers);
			if (Number.isFinite(v)) peaks.push(v);
		}
	}
	return {
		sessions: sessions.length,
		hours,
		timedSessions,
		peakViewers: peaks.length ? Math.max(...peaks) : null,
		avgPeakViewers: peaks.length ? peaks.reduce((a, b) => a + b, 0) / peaks.length : null,
	};
}
