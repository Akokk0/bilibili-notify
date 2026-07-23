// @vitest-environment jsdom
/**
 * 断档补画的**颜色**这一半 —— `gaps.test.ts` 只钉得住摊出来的数值。
 *
 * 这个功能是「形状给连续性,颜色说这段是推断的」两件事合起来才成立:数值全对
 * 但柱子照样是绿的,图就在拿推断值冒充实测值,而纯函数测试会全绿。
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { NetBars, TrendChart } from "./charts";
import { netFromCumulative } from "./gaps";

/** 与 charts.tsx 的 ESTIMATED 同值。写死在这里,改动必须两边同时想清楚。 */
const GREY = "var(--color-bn-text-secondary)";

const strokesOf = (root: HTMLElement) =>
	[...root.querySelectorAll("line")].map((l) => l.getAttribute("stroke"));

afterEach(cleanup);

describe("NetBars — 断档摊出来的柱子走灰色", () => {
	it("摊出来的用灰,实测的用涨跌色", () => {
		// [null, 100(摊), 100(摊), 50(实测)]
		const data = netFromCumulative([1000, null, 1200, 1250]);
		const { container } = render(
			<NetBars data={data} days={["d1", "d2", "d3", "d4"]} width={320} />,
		);
		const fills = [...container.querySelectorAll("rect")].map((r) => r.getAttribute("fill"));
		// 第一天没有基线,不画柱子 —— 留白仍然是留白。
		expect(fills).toHaveLength(3);
		expect(fills[0]).toBe(GREY);
		expect(fills[1]).toBe(GREY);
		expect(fills[2]).not.toBe(GREY);
	});

	it("灰柱的 tooltip 说明它是摊出来的,不让人当成当日实测", () => {
		const data = netFromCumulative([1000, null, 1200]);
		const { container } = render(<NetBars data={data} days={["d1", "d2", "d3"]} width={320} />);
		const titles = [...container.querySelectorAll("title")].map((t) => t.textContent);
		expect(titles.some((t) => t?.includes("平摊"))).toBe(true);
	});

	it("没有断档时一根灰柱都不出现", () => {
		const data = netFromCumulative([1000, 1100, 1150]);
		const { container } = render(<NetBars data={data} days={["d1", "d2", "d3"]} width={320} />);
		const fills = [...container.querySelectorAll("rect")].map((r) => r.getAttribute("fill"));
		expect(fills).not.toContain(GREY);
	});
});

describe("TrendChart — 断档处的灰色桥", () => {
	const series = [{ name: "up", color: "var(--color-bn-pink)", data: [1000, null, 1200] }];

	it("bridge 开启 → 断档两端补一条灰线连起来", () => {
		const { container } = render(<TrendChart series={series} width={320} bridge absolute />);
		expect(strokesOf(container).filter((s) => s === GREY)).toHaveLength(1);
	});

	it("缺省不桥接 —— 净增那类离散量连起来就是无中生有", () => {
		// 累计量在停机期间照样在变,两端连线是保守表达;每日净增不是,连过去等于
		// 声称「那几天每天涨这么多」。所以 bridge 必须显式开,不能是默认行为。
		const { container } = render(<TrendChart series={series} width={320} absolute />);
		expect(strokesOf(container).filter((s) => s === GREY)).toHaveLength(0);
	});

	it("没有断档就不画桥", () => {
		const { container } = render(
			<TrendChart
				series={[{ name: "up", color: "var(--color-bn-pink)", data: [1000, 1100, 1200] }]}
				width={320}
				bridge
				absolute
			/>,
		);
		expect(strokesOf(container).filter((s) => s === GREY)).toHaveLength(0);
	});
});
