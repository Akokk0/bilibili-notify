/**
 * 数据统计页的 wire 类型 re-export + 纯派生逻辑。
 *
 * 页面上的每个数字都从 `/api/stats/overview` 的一次响应派生 —— 这里放的是
 * 「怎么派生」,好让它能被单测钉住;组件只负责摆版式。
 */

import type { StatsOverviewResponse, UpStatsRow } from "@bilibili-notify/contract";

export type { StatsOverviewResponse, UpStatsRow } from "@bilibili-notify/contract";

export const statsQueryKey = (days: number) => ["stats", { days }] as const;

/** 本地时区偏移,与服务端 `tz` 参数口径一致(`getTimezoneOffset()`)。 */
export const localTzOffset = (): number => new Date().getTimezoneOffset();

/**
 * 生成与 series 对齐的本地日轴(YYYY-MM-DD),末位是今天。
 * 服务端只回数值序列,日期轴在前端按同一套本地日规则还原。
 */
export function dayAxis(days: number, now = new Date()): string[] {
	const tz = now.getTimezoneOffset();
	const out: string[] = [];
	for (let i = days - 1; i >= 0; i--) {
		const ms = now.getTime() - i * 86_400_000;
		out.push(new Date(ms - tz * 60_000).toISOString().slice(0, 10));
	}
	return out;
}

/**
 * 稀疏的 X 轴标签 —— 30 个日期全画上去会糊成一团,只在等距位置留几个。
 * 末位固定标「今天」,这是读图时唯一需要的锚点。
 */
export function sparseLabels(days: string[], every = 6): string[] {
	return days.map((_, i) => {
		if (i === days.length - 1) return "今天";
		if ((days.length - 1 - i) % every !== 0) return "";
		return `${days.length - 1 - i}日前`;
	});
}

/** 汇总所有 UP 的一行「全站」数据,供全局视图的 KPI 使用。 */
export interface StatsTotals {
	fans: number | null;
	net1d: number | null;
	net7d: number | null;
	/** 整个窗口的净增合计;口径见 contract 的 UpStatsRow.netWindow。 */
	netWindow: number | null;
	series: Array<number | null>;
	/**
	 * 整站逐日活动数。某位为 `null` = 那天**所有** UP 都没记录,也就是我们没在跑 ——
	 * 「日均」类指标的分母只能数非 null 的那些位(见 `coveredDayCount`)。
	 */
	activity: Array<number | null>;
	/**
	 * 这几项与 `UpStatsRow` 同口径:`null` = 所有 UP 在窗口内都没有采集覆盖。
	 * 用 `sumNullable` 而不是 `reduce(+)` —— 后者会把「没记录」加成 0,整站合计
	 * 于是永远给得出一个数,「无记录」这个事实在汇总这一层就被抹掉了。
	 */
	archives: number | null;
	dynamics: number | null;
	liveSessions: number | null;
	liveHours: number | null;
	liveTimedSessions: number | null;
	liveNow: number;
}

/** 逐位相加,全 null 的位置保持 null(整站那天都没记录)。 */
function sumSeries(
	rows: readonly UpStatsRow[],
	len: number,
	pick: (r: UpStatsRow) => ReadonlyArray<number | null> = (r) => r.series,
): Array<number | null> {
	return Array.from({ length: len }, (_, i) => {
		let sum = 0;
		let seen = false;
		for (const r of rows) {
			const v = pick(r)[i];
			if (v === null || v === undefined) continue;
			sum += v;
			seen = true;
		}
		return seen ? sum : null;
	});
}

function sumNullable(rows: readonly UpStatsRow[], pick: (r: UpStatsRow) => number | null) {
	let sum = 0;
	let seen = false;
	for (const r of rows) {
		const v = pick(r);
		if (v === null) continue;
		sum += v;
		seen = true;
	}
	return seen ? sum : null;
}

export function computeTotals(res: StatsOverviewResponse): StatsTotals {
	const rows = res.rows;
	return {
		fans: sumNullable(rows, (r) => r.fans),
		net1d: sumNullable(rows, (r) => r.net1d),
		net7d: sumNullable(rows, (r) => r.net7d),
		netWindow: sumNullable(rows, (r) => r.netWindow),
		series: sumSeries(rows, res.days),
		activity: sumSeries(rows, res.days, (r) => r.activity),
		archives: sumNullable(rows, (r) => r.archives),
		dynamics: sumNullable(rows, (r) => r.dynamics),
		liveSessions: sumNullable(rows, (r) => r.liveSessions),
		liveHours: sumNullable(rows, (r) => r.liveHours),
		liveTimedSessions: sumNullable(rows, (r) => r.liveTimedSessions),
		liveNow: rows.filter((r) => r.live).length,
	};
}

/**
 * 累计粉丝曲线 —— 直接用服务端给的每日末值,只把末位换成更新的快照。
 *
 * 曾经这里由「当前粉丝数 + 每日净增」**反推**,理由写着「反推是无损的,再传一份
 * 只是把同样的信息在网线上抄两遍」。那个前提是错的:
 *
 *   · 服务端的 net 口径是「当日末值 − **前一个有数据的日**的末值」,而窗口内第一个
 *     有数据的日没有基线,net 恒为 null。反推靠 net 判断「哪天有数据」,于是恰好把
 *     它当成没数据跳过 —— 明明由后一天减得出来,曲线却白白晚起一天;
 *   · 今天还没采到样本时(轮询在风控退避中,或页面刚过本地零点打开),末位 net 为
 *     null,回溯第一轮就断,整条 30 天曲线塌成孤零零一个圆点。
 *
 * 两处都不是能靠调回溯启发式补上的 —— 索引信息在只传 net 的那一刻就丢了。
 * 服务端现在照常把 `cumulative` 一并给出。
 *
 * **收整行而不是收两个位置参数**,是因为 `series`(每日净增)与 `cumulative`
 * (每日末值)类型一模一样,位置参数根本挡不住传错。上面那次改动加了 `cumulative`
 * 字段,调用点却仍传着 `series`:走势图于是画的是净增 —— 一串 0 附近的小数,末位
 * 被换成几十万的当前粉丝数,成了一条贴着 0 走、末端垂直拉起的折线。typecheck 全绿。
 * 现在传错字段直接编译不过。
 */
export function cumulativeFans(row: Pick<UpStatsRow, "fans" | "cumulative">): Array<number | null> {
	const out = [...row.cumulative];
	// 末位优先用 poller 的最新快照:它比当日最后一条采样更新,而这条线的右端点
	// 正是 KPI 上那个「当前粉丝数」,两者对不上会很显眼。
	if (row.fans !== null && out.length > 0) out[out.length - 1] = row.fans;
	return out;
}

/**
 * 有粉丝记录的 UP 数。
 *
 * 「总粉丝量」是 `sumNullable` 的结果 —— 只把有记录的那些加起来。若有 UP 还没
 * 采到样本(刚订阅 / 采集期没覆盖),那个数就不是全站合计,而标签写着「总」。
 * 调用方拿它与 `rows.length` 一比,就知道该不该在标签上说明白。
 */
export function fansKnownCount(rows: readonly UpStatsRow[]): number {
	let n = 0;
	for (const r of rows) if (r.fans !== null) n++;
	return n;
}

/**
 * 窗口内**有采集覆盖**的天数 —— 「日均」类指标的正确分母。
 *
 * `activity` 里的 `null` 表示那天我们根本没在记(服务没跑 / 刚订阅),与「那天零
 * 活动」的 `0` 严格两回事。拿窗口天数当分母的话,采集才跑 2 天却选近 30 日时,
 * 12 次活动会被算成 0.4 次/天 —— 而同一屏的热力图正把那 28 天画成空心「无记录」。
 */
export function coveredDayCount(activity: ReadonlyArray<number | null> | undefined): number {
	if (!activity) return 0;
	let n = 0;
	for (const v of activity) if (v !== null) n++;
	return n;
}

/**
 * 有采集覆盖的那些天的活动总数 —— 「日均活动」的**分子**,与 {@link coveredDayCount}
 * 这个分母同一把尺子。
 *
 * 拿窗口合计数当分子是不对的:那个数没有被覆盖遮罩过。单订阅的 UP 被禁用再启用会让
 * fans jsonl 被 `dropUid` 物理删掉,覆盖天数塌成 1 天,而统计 jsonl 里三个月的 60 次
 * 活动原封不动 —— 卡片于是写着「60.0 次 / 天 · 已记录1日」,紧挨着一张 90 格空了
 * 89 格的热力图。
 */
export function coveredActivityTotal(activity: ReadonlyArray<number | null> | undefined): number {
	if (!activity) return 0;
	let sum = 0;
	for (const v of activity) if (v !== null) sum += v;
	return sum;
}

/**
 * 把每日活动次数换算成热力图强度 0..4。
 *
 * 分档 0 / 1 / 2 / 3-4 / 5+ —— B 站 UP 一天发个位数条内容是常态,再往上分档
 * 只会让绝大多数格子挤在最浅的一档、图变得没有信息量。
 */
export function activityLevel(count: number | null): number | null {
	if (count === null) return null;
	if (count <= 0) return 0;
	if (count === 1) return 1;
	if (count === 2) return 2;
	if (count <= 4) return 3;
	return 4;
}
