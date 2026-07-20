/**
 * 能力画像的口径层。
 *
 * 雷达图表达的是**在主人已订阅的这批 UP 里的相对位置**,不是绝对能力值 ——
 * 每个维度的领跑者恒定满格。口径全部集中在这里,`RadarChart` 只管摆坐标。
 */

import type { UpStatsRow } from "../../services/stats.js";
import { formatSignedWan, formatWan } from "./chart-utils.js";

/** 归一化后的一根轴。 */
export interface RadarAxis {
	label: string;
	/** 0..1 的相对半径;`null` = 该维度无记录,不能画,也不能拿 0 顶替。 */
	value: number | null;
	/** 轴上并排标注的原始值。半径只说明相对位置,真值必须自己出面。 */
	display: string;
}

/**
 * 把一个值放到组内的相对位置上。
 *
 * 下界取 `min(0, 组内最小)`、上界取 `max(0, 组内最大)` —— 两头都把 0 夹进来,
 * 这一条同时管住了两种翻车:
 *
 * - 计数类(投稿 / 动态 / 场次)恒非负,于是下界恒为 0,圆心就是「一次都没有」。
 *   若改用组内最小值当下界,只订阅 5 篇和 10 篇两位时,5 篇那位会掉到圆心,
 *   读起来像「他没投过稿」。
 * - 净增可以为负。上界夹住 0 之后,**全组都在掉粉时谁也拿不到满格** —— 满格
 *   留给「0 净增」这个组内最好的成绩。旧实现用 `Math.max(0, net)` 把负数一律
 *   压成 0,掉 10 万和掉 100 长得一模一样。
 */
export function normalizeAxis(
	value: number | null,
	values: ReadonlyArray<number | null>,
	scale: "linear" | "log" = "linear",
): number | null {
	if (value === null) return null;
	const seen = values.filter((v): v is number => v !== null && v !== undefined);
	if (!seen.length) return null;

	const lo = Math.min(0, ...seen);
	const hi = Math.max(0, ...seen);
	// 全组都压在 0 上:没有高下可分,一律回圆心。给满格会让「大家都没投稿」
	// 画成一个饱满的六边形。
	if (hi === lo) return 0;

	// 对数只在非负半轴有定义;组内出现负值就退回线性。
	if (scale === "log" && lo >= 0) {
		return Math.log1p(value - lo) / Math.log1p(hi - lo);
	}
	return (value - lo) / (hi - lo);
}

interface Metric {
	label: string;
	pick: (r: UpStatsRow) => number | null;
	format: (v: number) => string;
	scale?: "linear" | "log";
}

const METRICS: Metric[] = [
	{
		// 唯一不随时间窗变的一根 —— 粉丝数是「此刻共有多少」,不存在「近30日的粉丝规模」。
		// 切换时间范围时它纹丝不动是对的,不是 bug;每根轴都并排标着原始值,读者
		// 一眼能看出哪根变了哪根没变。
		label: "粉丝规模(当前)",
		pick: (r) => r.fans,
		format: formatWan,
		// 粉丝数是重尾分布:200 万的 UP 会把 5 万的压成一根针,那根轴就读不出
		// 任何东西。取对数之后小 UP 之间的差距才展得开。
		scale: "log",
	},
	// `netWindow` 而不是 `net7d` —— 其余五轴都是窗口内的计数,涨粉势头必须同步,
	// 否则切到近90日时同一张图里会有两把尺子。
	{ label: "涨粉势头", pick: (r) => r.netWindow, format: formatSignedWan },
	{ label: "投稿量", pick: (r) => r.archives, format: (v) => `${v} 个` },
	{ label: "动态量", pick: (r) => r.dynamics, format: (v) => `${v} 条` },
	{ label: "开播场次", pick: (r) => r.liveSessions, format: (v) => `${v} 场` },
	{
		label: "直播时长",
		pick: (r) => r.liveHours,
		format: (v) => `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10}h`,
	},
];

/**
 * 至少要有 2 位 UP 才画得出相对画像。
 *
 * 只订阅 1 位时组内最大值就是他自己,六根轴全会归一到 1.0,画出一个撑满的
 * 正六边形 —— 看着很唬人,信息量为零。
 */
const MIN_PEERS = 2;

/** 返回六根轴;同组 UP 不足 2 位时返回 `null`,由调用方渲染空状态。 */
export function buildRadarAxes(
	focused: UpStatsRow,
	rows: readonly UpStatsRow[],
): RadarAxis[] | null {
	if (rows.length < MIN_PEERS) return null;
	return METRICS.map((m) => {
		const raw = m.pick(focused);
		return {
			label: m.label,
			value: normalizeAxis(
				raw,
				rows.map((r) => m.pick(r)),
				m.scale,
			),
			display: raw === null ? "无记录" : m.format(raw),
		};
	});
}
