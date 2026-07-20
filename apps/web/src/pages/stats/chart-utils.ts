/**
 * 数据统计图表的纯函数工具。SVG 组件只负责摆坐标,数值语义全在这里。
 */

/**
 * 压缩成中文计数("1.5万")。B 站自己就是这个口径,粉丝数动辄七位数,
 * 不压缩的话表格里全是数不清的零。
 */
export function formatWan(n: number): string {
	const abs = Math.abs(n);
	if (abs < 10_000) return String(Math.round(n));
	// 百万以上再留小数就有五位有效数字了,直接取整。
	const fixed = (n / 10_000).toFixed(abs >= 1_000_000 ? 0 : 1);
	return `${fixed.replace(/\.0$/, "")}万`;
}

/**
 * 带符号的净增值。负号用真减号 U+2212 而不是 ASCII 连字符 —— 等宽字体里
 * 连字符又短又靠上,一列数字排下来正负对不齐。
 */
export function formatSignedWan(n: number): string {
	return (n >= 0 ? "+" : "−") + formatWan(Math.abs(n));
}

/**
 * 把带 `null` 的序列切成连续段,返回每段的**下标**数组。
 *
 * 服务端用 `null` 表示「那天没有记录」(停机 / 刚订阅),折线必须在那里断开。
 * 若把 null 当 0 连过去,停机一周会画成一条平稳的零增长直线 —— 看上去像
 * 「这周没涨粉」,而不是「这周没数据」。
 */
export function splitSegments(data: ReadonlyArray<number | null>): number[][] {
	const out: number[][] = [];
	let cur: number[] = [];
	for (let i = 0; i < data.length; i++) {
		if (data[i] === null || data[i] === undefined) {
			if (cur.length) out.push(cur);
			cur = [];
			continue;
		}
		cur.push(i);
	}
	if (cur.length) out.push(cur);
	return out;
}

/**
 * 把数据范围换算成**人类可读**的坐标刻度。
 *
 * 之前的做法是把 `[min, max]` 直接五等分,于是真实数据会画出
 * `−855 / +3134 / +7124 / +1.1万 / +1.5万` 这种毛刺刻度 —— 读图的人得先做除法
 * 才知道一格代表多少。这里改成先把步长吸附到 1 / 2 / 5 × 10ⁿ,再把上下界对齐
 * 到步长的整数倍。
 *
 * 顺带解决零基线:步长的整数倍必然包含 0,所以只要范围跨过 0,零线就正好压在
 * 某条刻度线上,而不是浮在两条刻度之间。
 */
export function niceTicks(
	rawMin: number,
	rawMax: number,
	opts: {
		count?: number;
		/**
		 * 是否强制把 0 纳入范围。净增类图表必须要(没有零线就分不清涨跌);
		 * 累计值类**必须关掉** —— 227 万的粉丝曲线若从 0 起画,整条线会被压成
		 * 贴着图顶的一根直线,当期的起伏全被抹平。
		 */
		includeZero?: boolean;
		/**
		 * 量纲是整数(人数、条数)时置 true —— 步长不再小于 1。
		 *
		 * 渲染层用 `Math.round(tick)` 打标签,小数步长会让相邻刻度取整后**撞成同一个数**:
		 * 全 0 的净增序列区间被撑成 [-1,1]、step 吸附到 0.5,五条网格线标出
		 * −1 / −0 / +0 / +1 / +1,一根高度 1 的柱子看起来落在两条「+1」之间。
		 */
		integer?: boolean;
	} = {},
): { min: number; max: number; ticks: number[] } {
	const targetCount = opts.count ?? 4;
	const includeZero = opts.includeZero ?? true;
	let lo = includeZero ? Math.min(rawMin, 0) : rawMin;
	let hi = includeZero ? Math.max(rawMax, 0) : rawMax;
	// 数据全等(含全 0)时范围为 0,除下去会得到 Infinity,先撑开一个对称区间。
	if (lo === hi) {
		const pad = Math.abs(lo) || 1;
		lo -= pad;
		hi += pad;
	}

	const rawStep = (hi - lo) / targetCount;
	const magnitude = 10 ** Math.floor(Math.log10(rawStep));
	const normalized = rawStep / magnitude;
	// 吸附到 1 / 2 / 5 / 10 —— 人对这几个步长的心算最快。
	const snapped =
		magnitude * (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10);
	// 只抬下限,不改吸附形态:step 仍是 1/2/5×10ⁿ,只是整数量纲下不低于 1。
	const step = opts.integer ? Math.max(1, snapped) : snapped;

	const min = Math.floor(lo / step) * step;
	const max = Math.ceil(hi / step) * step;

	const ticks: number[] = [];
	// 步长可能是 0.1 这类无法精确表示的小数,按序号乘算并归整,避免累加漂移
	// 攒出 0.30000000000000004 这种刻度标签。
	const count = Math.round((max - min) / step);
	for (let i = 0; i <= count; i++) {
		ticks.push(Number((min + i * step).toPrecision(12)));
	}
	return { min, max, ticks };
}

/**
 * 去掉空洞,只留有数据的点 —— **仅供迷你图**(表格里的 sparkline、KPI 卡角标)。
 *
 * 大图必须用 {@link splitSegments} 如实断开:那里有坐标轴,断档看得懂。但 72px
 * 宽的迷你图表达不了「这里断了 3 天」,碎成几截浮在格子里只会被读成噪声。所以
 * 迷你图退一步,只画「有记录的那些点连起来的走势」,把断档的呈现交给大图。
 */
export function compactSeries(data: ReadonlyArray<number | null>): number[] {
	return data.filter((v): v is number => v !== null && v !== undefined);
}

/** 忽略 `null` 的取值范围。全空返回 `null`,调用方据此整块不渲染。 */
export function extent(data: ReadonlyArray<number | null>): { min: number; max: number } | null {
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;
	let seen = false;
	for (const v of data) {
		if (v === null || v === undefined) continue;
		seen = true;
		if (v < min) min = v;
		if (v > max) max = v;
	}
	return seen ? { min, max } : null;
}

/** 热力图单格的底色 / 描边。`null` = 无记录,`0` = 当天没活动,两者必须一眼可分。 */
export interface HeatCellStyle {
	background: string;
	boxShadow?: string;
	opacity?: number;
}

/**
 * 热力图单格样式 —— 抽成纯函数是为了能把「无记录 ≠ 零活动」用测试钉死。
 *
 * 曾经两者都是实心格,只差一点亮度(实测对比度 1.09:1,低于任何可感知阈值),
 * 于是「我们还没开始采集的那三个月」在页面上读作「这位 UP 三个月什么都没发」——
 * 正是整套 null 纪律要防的那件事。悬停有 tooltip,但没人会逐格悬停 90 个格子。
 *
 * 现在的区分靠**结构**而不是亮度:无记录是空心描边格,有记录一律实心。空心与实心
 * 在任何主题、任何格子尺寸下都不会看混,而亮度差会随主题和显示器一起漂。
 */
export function heatCellStyle(v: number | null, accent: string): HeatCellStyle {
	const ALPHA = ["", "44", "77", "aa", "dd"] as const;
	if (v === null) {
		return {
			background: "transparent",
			boxShadow: "inset 0 0 0 1px var(--color-bn-border-subtle)",
			opacity: 0.7,
		};
	}
	if (v === 0) return { background: "var(--color-bn-code-bg)" };
	return { background: `${accent}${ALPHA[Math.min(4, v)]}` };
}

/**
 * 热力图底部的 4 个时间刻度,与 `justify-between` 的落点(0 / ⅓ / ⅔ / 1)对齐。
 *
 * 基数是 `dayCount − 1` 而不是 `dayCount`:最右那格是**今天**(0 天前),所以最左
 * 那格是 `dayCount − 1` 天前。曾经直接写 `{days.length}天前`,整条轴早了一天 ——
 * 而同屏净增柱状图的横轴用的是 `days.length − 1 − i`,两条轴对不上。
 */
export function heatAxisLabels(dayCount: number): string[] {
	const last = Math.max(0, dayCount - 1);
	return [
		`${last}天前`,
		`${Math.round((last * 2) / 3)}天前`,
		`${Math.round(last / 3)}天前`,
		"今天",
	];
}

/**
 * 「无记录」的统一写法:`null` / `undefined` → 「—」,`0` → 「0」。
 *
 * 全站只此一处定义。曾经各调用点自己写 `?? 0`,于是「我们那阵子没在记」被渲染成
 * 一个确凿的 0 —— 而同一屏的热力图正把那段时间诚实地画成空格,两个说法互相打脸。
 */
export function dash(v: number | null | undefined, format: (n: number) => string = String): string {
	return v === null || v === undefined ? "—" : format(v);
}

/** 带符号数值的三档语气。`unknown` 是**独立一档**,不是「非负」的附属。 */
export type SignTone = "positive" | "negative" | "unknown";

/**
 * 判断一个带符号指标该用什么语气上色。
 *
 * 存在的理由是 `null` 必须有自己的一档。写成 `(v ?? 0) >= 0` 会把「没有记录」
 * 归零后判成非负,于是全新安装、粉丝还没采到样本时,徽章显示成**绿色**的「涨粉」——
 * 把「不知道」说成了「情况良好」。数值那一侧一直渲染成 `—`,唯独颜色在撒谎。
 */
export function signTone(v: number | null | undefined): SignTone {
	if (v === null || v === undefined) return "unknown";
	return v >= 0 ? "positive" : "negative";
}
