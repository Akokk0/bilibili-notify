// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import { Donut } from "../atoms";

/**
 * 环形占比图 —— 统计页的「总活动」环与概览页资源卡的两个仪表共用。
 *
 * 这里钉的是「比例真的画进了那圈弧」:占比靠 `stroke-dasharray` 的第一段与整周长的比
 * 表达,写死或算错都只有肉眼能发现。
 */

function arc(container: HTMLElement): SVGCircleElement {
	const circles = container.querySelectorAll("circle");
	const last = circles[circles.length - 1];
	if (!last) throw new Error("没有画出弧");
	return last as SVGCircleElement;
}

function dashRatio(el: SVGCircleElement): number {
	const [drawn, whole] = (el.getAttribute("stroke-dasharray") ?? "").split(" ").map(Number);
	if (!drawn && drawn !== 0) throw new Error("没有 stroke-dasharray");
	if (!whole) throw new Error("没有整周长");
	return drawn / whole;
}

describe("Donut", () => {
	it("画出来的弧长占整周长的比例就是 value", () => {
		const { container } = render(<Donut value={0.37} size={104} color="#f0a" />);
		expect(dashRatio(arc(container))).toBeCloseTo(0.37, 5);
	});

	it("越界的 value 夹在 0..1:算出来的百分比再离谱,环也不会绕回去", () => {
		// 堆上限读成 0 之类的意外会算出 Infinity,画成绕好几圈的弧比显示 100% 更难懂。
		const over = render(<Donut value={4.2} size={80} color="#f0a" />);
		expect(dashRatio(arc(over.container))).toBeCloseTo(1, 5);
	});

	it("负的 value 一段弧都不画,不往回画", () => {
		const { container } = render(<Donut value={-1} size={80} color="#f0a" />);
		// 只剩灰轨道那一个 circle。
		expect(container.querySelectorAll("circle")).toHaveLength(1);
	});

	it("label 渲染在环心", () => {
		render(<Donut value={0.5} size={80} color="#f0a" label={<span>37%</span>} />);
		expect(screen.getByText("37%")).toBeTruthy();
	});

	it("给读屏器一句能读的话 —— 不是所有 Donut 都在讲「占比」", () => {
		// 收编前 <title> 写死成「占比」,概览页两个仪表一个是 CPU 一个是堆,
		// 读屏器听到两声「占比」分不出谁是谁。
		render(<Donut value={0.5} size={80} color="#f0a" title="内存占用" />);
		expect(screen.getByTitle("内存占用")).toBeTruthy();
	});
});

describe("Donut 分段", () => {
	/** 每段弧的「画多长 / 从哪起画」—— 顺时针依次接上,前一段的终点是后一段的起点。 */
	function arcs(container: HTMLElement) {
		// 第一个 circle 是灰轨道,其余是段。
		return [...container.querySelectorAll("circle")].slice(1).map((el) => {
			const [drawn, whole] = (el.getAttribute("stroke-dasharray") ?? "").split(" ").map(Number);
			const offset = Number(el.getAttribute("stroke-dashoffset") ?? "0");
			if (!whole) throw new Error("没有整周长");
			return { len: (drawn ?? 0) / whole, start: -offset / whole };
		});
	}

	it("两段首尾相接:第二段从第一段的终点起画", () => {
		const { container } = render(
			<Donut
				size={104}
				segments={[
					{ value: 0.2, color: "#f0a" },
					{ value: 0.41, color: "#ccc" },
				]}
			/>,
		);
		const [bn, rest] = arcs(container);
		expect(bn?.len).toBeCloseTo(0.2, 5);
		expect(bn?.start).toBeCloseTo(0, 5);
		// 接不上的话「BN + 其他 = 总占用」就是句空话 —— 两段会重叠或中间露一段轨道。
		expect(rest?.start).toBeCloseTo(0.2, 5);
		expect(rest?.len).toBeCloseTo(0.41, 5);
	});

	it("总长超过一圈时按比例压回一圈,不绕第二圈", () => {
		const { container } = render(
			<Donut
				size={104}
				segments={[
					{ value: 0.8, color: "#f0a" },
					{ value: 0.6, color: "#ccc" },
				]}
			/>,
		);
		const [a, b] = arcs(container);
		// 读数抖动能让两段之和越过 1;绕回去画的环没人看得懂。
		expect((a?.len ?? 0) + (b?.len ?? 0)).toBeCloseTo(1, 5);
		expect(a?.len).toBeCloseTo(0.8 / 1.4, 5);
	});

	it("值为 0 的段不画 —— 圆头线帽会让 0 长的弧变成一个点", () => {
		const { container } = render(
			<Donut
				size={104}
				segments={[
					{ value: 0.3, color: "#f0a" },
					{ value: 0, color: "#ccc" },
				]}
			/>,
		);
		expect(arcs(container)).toHaveLength(1);
	});

	it("负值当 0,不往回画", () => {
		const { container } = render(<Donut size={104} segments={[{ value: -0.2, color: "#f0a" }]} />);
		expect(arcs(container)).toHaveLength(0);
	});
});
