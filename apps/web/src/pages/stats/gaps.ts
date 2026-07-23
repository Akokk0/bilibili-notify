/**
 * 停机断档的补画规则 —— 服务没跑的那几天怎么在图上表达。
 *
 * 原来一律留白:折线断成几截、柱子整段消失。诚实,但读起来像「三块互不相干的
 * 数据」,而真实情况是粉丝一直在涨,只是我们没记。所以改成**画出来但换灰色**:
 * 形状给连续性,颜色说「这一段是推断的」。
 *
 * 平摊是有依据的,不是编数。服务端 net 的口径是「当日末值 − 前一个**有数据的**
 * 日末值」,所以断档后第一天的 net 本来就是整段合计 —— 它一直被画成一根孤零零的
 * 高柱,标签却写着一天。我们确实知道整段涨了多少,不知道的只是逐日分布;平摊把
 * 已知的总量如实摊开,再用灰色声明分布是猜的。
 *
 * 两条口径要一起记:`estimated` 只标**分布**存疑,不标总量存疑;而窗口两端的
 * 断档(左边没基线 / 右边还没采到)连总量都无从谈起,一律留 null。
 */

/** 一天的净增,以及它是不是断档平摊出来的。 */
export interface NetPoint {
	/** `null` = 算不出来(缺锚点),与「那天没涨粉」的 0 是两回事。 */
	value: number | null;
	/** true = 由整段涨幅平摊而来,画成灰色。 */
	estimated: boolean;
}

/**
 * 从每日末值序列算每日净增,断档段按天数平摊并标记为估算。
 *
 * 只吃 `cumulative`(每日末值)、不吃服务端的 `series`(每日净增):后者在断档
 * 处已经把整段合计压在末尾那一天,信息塌了,摊不回去。无断档时两者逐位相等。
 */
export function netFromCumulative(cumulative: ReadonlyArray<number | null>): NetPoint[] {
	const out: NetPoint[] = cumulative.map(() => ({ value: null, estimated: false }));
	// 上一个有末值的下标。窗口第一个有值的日没有它,净增算不出来 —— 那天的基线
	// 在窗口之外,不能拿 0 顶替(会画成一根从零起跳的巨柱)。
	let prev = -1;
	for (let i = 0; i < cumulative.length; i++) {
		const v = cumulative[i];
		if (v === null || v === undefined) continue;
		if (prev >= 0) {
			const base = cumulative[prev] as number;
			const span = i - prev; // 这段涨幅覆盖的天数,无断档时恒为 1
			const per = (v - base) / span;
			// 摊到 (prev, i] 这几天。span > 1 才是断档,那时整段都算推断 —— 包括
			// 末尾这天:它的值同样是摊出来的,留着涨跌配色会谎称那是当日真实记录。
			for (let j = prev + 1; j <= i; j++) {
				out[j] = { value: per, estimated: span > 1 };
			}
		}
		prev = i;
	}
	return out;
}

/**
 * 折线上要用灰色补连的断档:`[左锚点下标, 右锚点下标]`,两端都是有数据的日。
 *
 * 窗口两端的 null 不成桥 —— 一侧没有可锚的点,连出去就是凭空画线。
 */
export function bridgeSpans(data: ReadonlyArray<number | null>): Array<[number, number]> {
	const spans: Array<[number, number]> = [];
	let prev = -1;
	for (let i = 0; i < data.length; i++) {
		const v = data[i];
		if (v === null || v === undefined) continue;
		if (prev >= 0 && i - prev > 1) spans.push([prev, i]);
		prev = i;
	}
	return spans;
}

/**
 * 逐位相加各 UP 的每日净增,供汇总视图用。
 *
 * 顺序要紧:**先各摊各的、再相加**。反过来(先加出一条全站累计曲线再摊)是错的
 * —— 某位 UP 那天缺数据时,它的几十万粉丝会从合计里整个消失,曲线上多出一个假
 * 坑,摊出来的净增于是先暴跌再暴涨。每位 UP 自己的平摊各有各的依据,加总之后
 * 依据还在。
 *
 * `estimated` 取**或**:只要有一位是摊出来的,这根柱子就掺了推断成分,画灰。
 * 保守方向 —— 宁可多标一根灰,也不能把掺了推断的合计画成实测的绿。
 */
export function sumNetPoints(perUp: ReadonlyArray<ReadonlyArray<NetPoint>>): NetPoint[] {
	const len = perUp.reduce((m, s) => Math.max(m, s.length), 0);
	const out: NetPoint[] = [];
	for (let i = 0; i < len; i++) {
		let sum = 0;
		let seen = false;
		let estimated = false;
		for (const s of perUp) {
			const p = s[i];
			// 那位 UP 那天没数据就跳过,不能拿 0 顶替 —— 新订阅的 UP 前面本就没有它,
			// 让它把别人的真实数据一起拖成留白是另一种撒谎。
			if (!p || p.value === null) continue;
			sum += p.value;
			seen = true;
			if (p.estimated) estimated = true;
		}
		out.push(seen ? { value: sum, estimated } : { value: null, estimated: false });
	}
	return out;
}
