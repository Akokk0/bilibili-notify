// @vitest-environment jsdom

/**
 * 画布上**真的拖得动**(ADR-0014「仍未决」里主人要进账的那条)。
 *
 * 几何算法在 `canvas-drag.test.ts` 逐条钉过了;这份只钉那条线:指针按下 → 拖 → 松手,
 * 有没有一个 `onGrid` 带着对的 patch 交出去。零件各自绿证明不了它们接上了 —— 皮肤这一摊
 * 已经栽过两次同族的。
 *
 * jsdom 没有布局引擎,`getBoundingClientRect()` 一律回 0,所以列 / 行的位置得自己桩进去:
 * 画布把量尺寸的那几个元素标了 `data-canvas-track`,这里按它认出来喂假的矩形。
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { SkinCanvas } from "../SkinCanvas";

afterEach(cleanup);

const COL_W = 40;
const COL_X0 = 100;
const ROW_H = 56;
const ROW_PITCH = 64;

/** 第 n 列(1 起)的中点横坐标。 */
const colX = (n: number) => COL_X0 + (n - 1) * COL_W + COL_W / 2;
/** 第 n 行(1 起)的中点纵坐标。 */
const rowY = (n: number) => (n - 1) * ROW_PITCH + ROW_H / 2;

beforeEach(() => {
	// 按元素身上的 `data-canvas-track` 喂矩形,别的元素一律回零矩形(与 jsdom 默认一致)。
	vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
		const track = this.getAttribute("data-canvas-track");
		const i = Number(this.getAttribute("data-canvas-index") ?? "0");
		if (track === "column") {
			const x = COL_X0 + (i - 1) * COL_W;
			return {
				x,
				y: 0,
				left: x,
				right: x + COL_W,
				top: 0,
				bottom: 0,
				width: COL_W,
				height: 0,
			} as DOMRect;
		}
		if (track === "row") {
			const y = (i - 1) * ROW_PITCH;
			return {
				x: 0,
				y,
				left: 0,
				right: 0,
				top: y,
				bottom: y + ROW_H,
				width: 0,
				height: ROW_H,
			} as DOMRect;
		}
		return { x: 0, y: 0, left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 } as DOMRect;
	});
});

afterEach(() => vi.restoreAllMocks());

const card = {
	width: 600,
	blocks: [
		{ id: "cover", kind: "builtin", builtin: "cover", grid: { row: 1, column: 1, span: 4 } },
	],
};

function mount(over: Record<string, unknown> = {}) {
	const onGrid = vi.fn();
	const onSelect = vi.fn();
	render(
		<SkinCanvas
			kind="live"
			card={card as never}
			selection={null}
			onSelect={onSelect}
			onGrid={onGrid}
			{...over}
		/>,
	);
	return { onGrid, onSelect };
}

/** 画布上那个块。 */
const blockEl = () => screen.getByRole("button", { name: /封面/ });

function dragFrom(el: Element, from: { x: number; y: number }, to: { x: number; y: number }) {
	fireEvent.pointerDown(el, { pointerId: 1, clientX: from.x, clientY: from.y, button: 0 });
	fireEvent.pointerMove(el, { pointerId: 1, clientX: to.x, clientY: to.y });
	fireEvent.pointerUp(el, { pointerId: 1, clientX: to.x, clientY: to.y });
}

describe("拖块身 —— 改行列", () => {
	it("从第 1 列第 1 行拖到第 5 列第 2 行 → 交出一次 onGrid", () => {
		const { onGrid } = mount();
		dragFrom(blockEl(), { x: colX(1), y: rowY(1) }, { x: colX(5), y: rowY(2) });
		expect(onGrid).toHaveBeenCalledTimes(1);
		expect(onGrid).toHaveBeenCalledWith("cover", { row: 2, column: 5 });
	});

	it("按抓住的位置平移 —— 抓着块的第 3 格拖到第 8 列,左边落在 6", () => {
		const { onGrid } = mount();
		dragFrom(blockEl(), { x: colX(3), y: rowY(1) }, { x: colX(8), y: rowY(1) });
		expect(onGrid).toHaveBeenCalledWith("cover", { row: 1, column: 6 });
	});

	it("没挪动 = 点一下选中,不发 onGrid", () => {
		const { onGrid, onSelect } = mount();
		const el = blockEl();
		fireEvent.pointerDown(el, { pointerId: 1, clientX: colX(1), clientY: rowY(1), button: 0 });
		fireEvent.pointerUp(el, { pointerId: 1, clientX: colX(1), clientY: rowY(1) });
		fireEvent.click(el);
		expect(onGrid).not.toHaveBeenCalled();
		expect(onSelect).toHaveBeenCalledWith({ kind: "block", id: "cover" });
	});

	it("拖的过程中块跟着指针走 —— 松手前就看得见要落在哪儿", () => {
		mount();
		const el = blockEl();
		fireEvent.pointerDown(el, { pointerId: 1, clientX: colX(1), clientY: rowY(1), button: 0 });
		// 画布多一列行号,所以第 1 列画在 grid-column 2。
		expect(el.style.gridColumn).toBe("2 / span 4");
		fireEvent.pointerMove(el, { pointerId: 1, clientX: colX(5), clientY: rowY(2) });
		expect(el.style.gridColumn).toBe("6 / span 4");
		expect(el.style.gridRow).toBe("2 / span 1");
	});

	it("拖的过程中一次 onGrid 都不发 —— 每动一格发一次会把真预览按住重画", () => {
		const { onGrid } = mount();
		const el = blockEl();
		fireEvent.pointerDown(el, { pointerId: 1, clientX: colX(1), clientY: rowY(1), button: 0 });
		fireEvent.pointerMove(el, { pointerId: 1, clientX: colX(3), clientY: rowY(1) });
		fireEvent.pointerMove(el, { pointerId: 1, clientX: colX(5), clientY: rowY(2) });
		expect(onGrid).not.toHaveBeenCalled();
		fireEvent.pointerUp(el, { pointerId: 1, clientX: colX(5), clientY: rowY(2) });
		expect(onGrid).toHaveBeenCalledTimes(1);
	});

	it("拖完那一下不许再当成「选中」—— 松手后浏览器还会补一记 click", () => {
		const { onSelect } = mount();
		const el = blockEl();
		dragFrom(el, { x: colX(1), y: rowY(1) }, { x: colX(5), y: rowY(2) });
		fireEvent.click(el);
		expect(onSelect).not.toHaveBeenCalled();
	});
});

describe("拉边 —— 改跨列", () => {
	it("拉右边到第 9 列 → span 变 9,起点不动", () => {
		const { onGrid } = mount();
		const handle = screen.getByTestId("resize-right-cover");
		dragFrom(handle, { x: colX(4), y: rowY(1) }, { x: colX(9), y: rowY(1) });
		expect(onGrid).toHaveBeenCalledWith("cover", { column: 1, span: 9 });
	});

	it("拉左边 → 起点跟着走,右边钉住", () => {
		const { onGrid } = mount();
		const handle = screen.getByTestId("resize-left-cover");
		// 原来占 1–4;左边拉到第 3 列 → 占 3–4。
		dragFrom(handle, { x: colX(1), y: rowY(1) }, { x: colX(3), y: rowY(1) });
		expect(onGrid).toHaveBeenCalledWith("cover", { column: 3, span: 2 });
	});
});

describe("只读的皮肤", () => {
	it("不给 onGrid 就没有拖拽把手 —— 拖得动却存不下去比拖不动更气人", () => {
		render(<SkinCanvas kind="live" card={card as never} selection={null} onSelect={vi.fn()} />);
		expect(screen.queryByTestId("resize-right-cover")).toBeNull();
	});
});
