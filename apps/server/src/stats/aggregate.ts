import type { FansSample } from "../fans/store.js";
import type { LiveSessionEntry, PostEntry, RecordingEntry, RecordingKind } from "./store.js";

/**
 * stats 聚合层 —— 纯函数,不碰 IO。路由只负责把 store 读出来的原始序列喂进来。
 *
 * 单独成层的理由是**口径**:投稿 / 动态怎么分栏、日界怎么切、未闭合直播算不算时长,
 * 这些决定同时影响页面上好几个数字。散在路由里改一处漏一处,集中在这里才能
 * 用测试把口径钉死。
 *
 * **只认中立的东西**(ADR-0020 决策 5 / 7 的 🔗):作品带不带视频,峰值是数字(开播公告不记,直播只看场次)。
 * 平台的类型串怎么归类、「1.2万」怎么解析,由各来源在交进来之前做好(B 站那份在
 * `bili-format`),这里不认识任何平台 —— 以后再接一个平台,统计这一层一行不动。
 */

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

export interface PostCounts {
	/** 带视频的作品数(面板上的「投稿」)。 */
	videoPosts: number;
	/** 全部作品数,带视频的也算在内(面板上的「动态」是它减去 `videoPosts`,ADR-0019 决策 65)。 */
	posts: number;
}

export function countPosts(events: readonly PostEntry[]): PostCounts {
	let videoPosts = 0;
	for (const e of events) if (e.hasVideo) videoPosts++;
	return { videoPosts, posts: events.length };
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
 * 逐日活动次数 —— 热力图的数据源,**作品与直播分开数**:一条作品算一次,一场开播算一次(按开播那天)。
 * 热力图每天取哪几项相加,看那天哪几项在记(`recordingDays`),所以这里不先加起来。
 *
 * 单独一个函数而不是复用 `countPosts`,是因为热力图要的是**按天散开**的
 * 分布,而不是窗口总计;两者的口径必须一致,否则热力图和
 * 表格里的数字会对不上。一场直播只按下面的场次、在开播那天算一次。
 */
export function dailyActivityCounts(
	events: readonly PostEntry[],
	sessions: readonly LiveSessionEntry[],
	opts: DailySeriesOptions,
): { posts: number[]; live: number[] } {
	const tz = opts.tzOffsetMin ?? 0;
	const nowMs = (opts.now ?? new Date()).getTime();
	const localKey = (utcMs: number) => new Date(utcMs - tz * 60_000).toISOString().slice(0, 10);

	const bumpInto = (counts: Map<string, number>, iso: string) => {
		const ms = Date.parse(iso);
		if (Number.isNaN(ms)) return;
		const k = localKey(ms);
		counts.set(k, (counts.get(k) ?? 0) + 1);
	};
	const postCounts = new Map<string, number>();
	const liveCounts = new Map<string, number>();
	for (const e of events) bumpInto(postCounts, e.publishedAt);
	// 直播按**开播**那天记一次,不按跨天时长摊开 —— 通宵直播算一次活动。
	for (const s of sessions) bumpInto(liveCounts, s.startedAt);

	const posts: number[] = [];
	const live: number[] = [];
	for (let i = opts.days - 1; i >= 0; i--) {
		const k = localKey(nowMs - i * 86_400_000);
		posts.push(postCounts.get(k) ?? 0);
		live.push(liveCounts.get(k) ?? 0);
	}
	return { posts, live };
}

/**
 * 「在记」账 → 窗口里每个本地日这一项在不在记(长度与顺序同 `dailyFansSeries` / `dailyActivityCounts`,末位是今天)。
 *
 * 那一天(按请求的时区切)与这一项的**任何一段区间**有交集就算在记。区间任意长(记录器写的是一个整点小时,
 * 迁移写的是合好的长区间),重复与重叠都不影响结果。
 */
export function recordingDays(
	entries: readonly RecordingEntry[],
	kind: RecordingKind,
	opts: DailySeriesOptions,
): boolean[] {
	const tz = opts.tzOffsetMin ?? 0;
	const nowMs = (opts.now ?? new Date()).getTime();
	const ranges: Array<[number, number]> = [];
	for (const e of entries) {
		if (e.kind !== kind) continue;
		const from = Date.parse(e.startedAt);
		const to = Date.parse(e.endedAt);
		if (Number.isFinite(from) && Number.isFinite(to) && from < to) ranges.push([from, to]);
	}
	const out: boolean[] = [];
	for (let i = opts.days - 1; i >= 0; i--) {
		const key = new Date(nowMs - i * 86_400_000 - tz * 60_000).toISOString().slice(0, 10);
		const dayStart = Date.parse(`${key}T00:00:00.000Z`) + tz * 60_000;
		const dayEnd = dayStart + 86_400_000;
		out.push(ranges.some(([from, to]) => from < dayEnd && to > dayStart));
	}
	return out;
}

export interface LiveStatsView {
	/** 窗口内的场次(含仍在直播的那场)。 */
	sessions: number;
	/** 总时长(小时)。已闭合的场按实际时长,仍在播的按「开播到现在」。 */
	hours: number;
	/**
	 * 其中**时长已知**的场次数 —— 求场均时长时的分母。
	 *
	 * 硬杀进程会留下没有 end 帧的场次:它确实发生过(所以计进 `sessions`),但时长
	 * 无从得知(所以不进 `hours`)。若拿 `sessions` 当分母,「一场 4 小时 + 一场未知」
	 * 会算出场均 2 小时 —— 两场里没有任何一场是 2 小时。与 `avgViewers` 只除
	 * 「采到峰值的场次」同一个道理:未知不是零。
	 */
	timedSessions: number;
	/** 各场累计观看中的最大值(单场最高观看);无样本时 null。 */
	maxViewers: number | null;
	/** 各场累计观看的平均(场均观看)—— 不是「平均在线」,别在 UI 上标错。 */
	avgViewers: number | null;
}

export function summarizeLiveSessions(
	sessions: readonly LiveSessionEntry[],
	opts: { now?: Date; isLive?: boolean; sinceMs?: number } = {},
): LiveStatsView {
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
		// 没采到峰值的场不进最高与平均 —— 未知不是零。
		if (typeof s.peakTotalViewers === "number" && Number.isFinite(s.peakTotalViewers)) {
			peaks.push(s.peakTotalViewers);
		}
	}
	return {
		sessions: sessions.length,
		hours,
		timedSessions,
		maxViewers: peaks.length ? Math.max(...peaks) : null,
		avgViewers: peaks.length ? peaks.reduce((a, b) => a + b, 0) / peaks.length : null,
	};
}
