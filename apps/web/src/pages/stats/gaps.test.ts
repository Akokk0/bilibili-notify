/**
 * 停机断档的补画规则 —— 服务没跑的那几天怎么在图上表达。
 *
 * 原来一律留白:折线断成几截、柱子整段消失。诚实,但读起来是「三块互不相干的
 * 数据」,而真实情况是粉丝一直在涨,只是我们没记。所以改成**画出来但换灰色**:
 * 形状给连续性,颜色说「这段是推断的」。
 *
 * 平摊是有依据的,不是编数:服务端 net 的口径是「当日末值 − 前一个有数据的日
 * 末值」,断档后第一天的 net 本来就是整段合计。我们知道整段涨了多少,只是不知道
 * 逐日怎么分布 —— 平摊把已知的总量如实摊开,并用灰色声明分布是猜的。
 */

import { describe, expect, it } from "vite-plus/test";
import { bridgeSpans, netFromCumulative, sumNetPoints } from "./gaps";

describe("netFromCumulative — 每日净增,断档段平摊", () => {
	it("没有断档时逐日相减,一天都不标估算", () => {
		expect(netFromCumulative([1000, 1100, 1150])).toEqual([
			{ value: null, estimated: false },
			{ value: 100, estimated: false },
			{ value: 50, estimated: false },
		]);
	});

	it("窗口第一天没有基线 → null,不是 0", () => {
		// 它前面那天在窗口之外,减不出来。画成 0 会被读成「那天没涨粉」。
		expect(netFromCumulative([1000, 1100])[0]).toEqual({ value: null, estimated: false });
	});

	it("中间隔一天 → 两天平分,两根都是灰的", () => {
		// 服务端会把 200 全算在末尾那天头上(它的 net = 1200 − 1000)。那根柱子
		// 因此是「两天的合计」,标签却写着一天 —— 摊开才对得上。
		expect(netFromCumulative([1000, null, 1200])).toEqual([
			{ value: null, estimated: false },
			{ value: 100, estimated: true },
			{ value: 100, estimated: true },
		]);
	});

	it("连续断几天 → 整段按天数取平均", () => {
		const got = netFromCumulative([1000, null, null, null, 1400]);
		expect(got.map((p) => p.value)).toEqual([null, 100, 100, 100, 100]);
		expect(got.map((p) => p.estimated)).toEqual([false, true, true, true, true]);
	});

	it("平摊后加总仍等于整段真实涨幅 —— 摊开的是已知总量,不是编出来的数", () => {
		const got = netFromCumulative([1000, null, null, 1100]);
		const sum = got.reduce((a, p) => a + (p.value ?? 0), 0);
		expect(sum).toBeCloseTo(100, 10);
	});

	it("掉粉的断档一样平摊,符号跟着走", () => {
		expect(netFromCumulative([1000, null, 900]).map((p) => p.value)).toEqual([null, -50, -50]);
	});

	it("开头的断档没有左锚点 → 保持 null,不硬凑", () => {
		expect(netFromCumulative([null, null, 1000, 1050])).toEqual([
			{ value: null, estimated: false },
			{ value: null, estimated: false },
			{ value: null, estimated: false },
			{ value: 50, estimated: false },
		]);
	});

	it("末尾的断档没有右锚点 → 保持 null", () => {
		// 今天还没采到样本(轮询在风控退避 / 刚过本地零点):涨了多少还不知道,
		// 摊不出来。等它采到了自然会补上。
		expect(netFromCumulative([1000, 1100, null]).map((p) => p.value)).toEqual([null, 100, null]);
	});

	it("全是 null → 全是 null", () => {
		expect(netFromCumulative([null, null]).map((p) => p.value)).toEqual([null, null]);
	});

	it("空序列 → 空结果", () => {
		expect(netFromCumulative([])).toEqual([]);
	});
});

describe("bridgeSpans — 折线上要用灰色补连的断档", () => {
	it("隔一天 → 一段桥,两端是有数据的那两天", () => {
		expect(bridgeSpans([1, null, 3])).toEqual([[0, 2]]);
	});

	it("连续断几天 → 仍是一段桥,直接跨过去", () => {
		expect(bridgeSpans([1, null, null, 4])).toEqual([[0, 3]]);
	});

	it("多处断档 → 各自成桥", () => {
		expect(bridgeSpans([1, null, 3, null, 5])).toEqual([
			[0, 2],
			[2, 4],
		]);
	});

	it("没有断档 → 没有桥", () => {
		expect(bridgeSpans([1, 2, 3])).toEqual([]);
	});

	it("开头的 null 不成桥 —— 左边没有可锚的点", () => {
		expect(bridgeSpans([null, 1, 2])).toEqual([]);
	});

	it("末尾的 null 不成桥 —— 右边没有可锚的点", () => {
		expect(bridgeSpans([1, 2, null])).toEqual([]);
	});

	it("两端都没有数据 → 没有桥", () => {
		expect(bridgeSpans([null, null])).toEqual([]);
	});
});

describe("sumNetPoints — 汇总视图逐位相加", () => {
	/**
	 * 汇总的正确做法是**先各摊各的、再相加**,不是先加出一条全站累计再摊。
	 *
	 * 全站累计那条路走不通:某位 UP 那天缺数据时,它的粉丝数会从合计里整个消失,
	 * 曲线上出现一个几十万的假坑,摊出来的每日净增于是先暴跌再暴涨。而每位 UP
	 * 自己的平摊各有各的依据,加总之后依据还在。
	 */
	it("逐位相加,全是实测就不标估算", () => {
		const a = netFromCumulative([1000, 1100, 1150]); // [null, 100, 50]
		const b = netFromCumulative([500, 520, 560]); // [null, 20, 40]
		expect(sumNetPoints([a, b])).toEqual([
			{ value: null, estimated: false },
			{ value: 120, estimated: false },
			{ value: 90, estimated: false },
		]);
	});

	it("只要有一位是摊出来的,这根柱子就算含推断成分 → 标灰", () => {
		// 保守方向:宁可多标一根灰,也不能把掺了推断的合计画成实测的绿。
		const a = netFromCumulative([1000, null, 1200]); // [null, 100(摊), 100(摊)]
		const b = netFromCumulative([500, 520, 560]); // [null, 20, 40]
		expect(sumNetPoints([a, b])).toEqual([
			{ value: null, estimated: false },
			{ value: 120, estimated: true },
			{ value: 140, estimated: true },
		]);
	});

	it("某位 UP 没有数据的那天只加有数据的,不因此留白", () => {
		// 新订阅的 UP 前面那些天本就没有它 —— 不能让它把别人的真实数据也拖成留白。
		const a: Array<{ value: number | null; estimated: boolean }> = [
			{ value: null, estimated: false },
			{ value: 30, estimated: false },
		];
		const b = [
			{ value: 10, estimated: false },
			{ value: 20, estimated: false },
		];
		expect(sumNetPoints([a, b])).toEqual([
			{ value: 10, estimated: false },
			{ value: 50, estimated: false },
		]);
	});

	it("所有 UP 那天都没数据 → 留白,不是 0", () => {
		const a = netFromCumulative([null, 1100]);
		const b = netFromCumulative([null, 520]);
		expect(sumNetPoints([a, b])[0]).toEqual({ value: null, estimated: false });
	});

	it("只有一位 UP 时等价于它自己", () => {
		const a = netFromCumulative([1000, null, 1200]);
		expect(sumNetPoints([a])).toEqual(a);
	});

	it("没有任何 UP → 空结果", () => {
		expect(sumNetPoints([])).toEqual([]);
	});
});
