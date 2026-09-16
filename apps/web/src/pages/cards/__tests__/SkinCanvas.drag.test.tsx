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
 *
 * **钉得住的三条**(各自破坏验红过):1:1 跟手、落点指示、动量投射。
 *
 * ⚠️ **钉不住的那一条:把松手速度递给弹簧。** 弹簧在 jsdom 里根本跑不起来(没有布局,
 * 也没人等它跑完),所以把 `velocity: job.v.x` 整句删掉,这一整份照样全绿 —— 实测过。
 * 它只能在真浏览器里看:**甩一下松手,块该顺着那股劲滑过去再收住;要是松手瞬间先顿一下
 * 再重新起步,就是这一句掉了。**
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

/**
 * 自己造事件,**因为 `timeStamp` 是只读的** —— `fireEvent` 的 init 里传不进去,而它决定
 * 松手速度。不控制它的话,jsdom 里两次事件相隔一毫秒,速度会顶到封顶值,每一次拖都成了
 * 「用力甩」,落点全被动量投射带跑。
 */
function pointer(el: Element, type: string, at: { x: number; y: number }, t: number) {
	const e = new Event(type, { bubbles: true });
	Object.assign(e, { pointerId: 1, clientX: at.x, clientY: at.y, button: 0 });
	Object.defineProperty(e, "timeStamp", { value: t });
	// 走 `fireEvent` 的底层形式而不是 `el.dispatchEvent`:前者替我们包了 `act`,
	// 直接 dispatch 的话 React 的更新不一定当场刷出来,断言会扑空。
	fireEvent(el, e);
}

/** 等 motion 把 MotionValue 写进 style —— 它排在下一帧,不是同步的。 */
const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

/**
 * ⚠️ **起始时间戳不能用 0**:React 造合成事件时写的是 `nativeEvent.timeStamp || Date.now()`,
 * 而 0 是 falsy —— 它会被换成真实时钟,于是首尾两点的时间差成了负数,速度一律算作零,
 * 「甩」和「慢慢放」就再也分不出来了。所以下面一律从 1000 起。
 */
const T0 = 1000;

/**
 * **放下**:拖过去,然后在落点上停一下再松手 —— 真人就是这么放东西的,手指几乎总会在
 * 终点停顿。停顿之后速度窗口里只剩不动的点,动量为零,落点就是松手那一格。
 *
 * (只拖不停的话仍有速度 —— 500ms 走 160px 也有 320px/s,足够多投出一格。那是**对的**
 * 行为,不是误差:手指还在动,东西就还在走。)
 */
function dragFrom(el: Element, from: { x: number; y: number }, to: { x: number; y: number }) {
	pointer(el, "pointerdown", from, T0);
	pointer(el, "pointermove", to, T0 + 500);
	pointer(el, "pointermove", to, T0 + 800);
	pointer(el, "pointerup", to, T0 + 800);
}

/** 甩一下:同样的两点,但只用了 20ms —— 动量该把落点带得更远。 */
function flingFrom(el: Element, from: { x: number; y: number }, to: { x: number; y: number }) {
	pointer(el, "pointerdown", from, T0);
	pointer(el, "pointermove", to, T0 + 20);
	pointer(el, "pointerup", to, T0 + 20);
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

	it("拖的过程中块**1:1 贴着手走**,格子不动 —— 一格一格跳正是上一版生硬的根子", async () => {
		mount();
		const el = blockEl();
		pointer(el, "pointerdown", { x: colX(1), y: rowY(1) }, T0);
		// 画布多一列行号,所以第 1 列画在 grid-column 2。
		expect(el.style.gridColumn).toBe("2 / span 4");
		pointer(el, "pointermove", { x: colX(1) + 137, y: rowY(1) + 41 }, T0 + 500);
		await nextFrame();
		// 格子**没动**:块是靠 transform 贴在手上的。
		expect(el.style.gridColumn).toBe("2 / span 4");
		expect(el.style.transform).toContain("137");
		expect(el.style.transform).toContain("41");
	});

	it("会落到哪一格由**落点指示**说 —— 1:1 跟手要是没人报落点,就成了不知道会落在哪的乱飘", () => {
		mount();
		const el = blockEl();
		expect(screen.queryByTestId("drop-hint")).toBeNull();
		pointer(el, "pointerdown", { x: colX(1), y: rowY(1) }, T0);
		pointer(el, "pointermove", { x: colX(5), y: rowY(2) }, T0 + 500);
		const hint = screen.getByTestId("drop-hint");
		expect(hint.style.gridColumn).toBe("6 / span 4");
		expect(hint.style.gridRow).toBe("2 / span 1");
	});

	it("松手之后落点指示就撤掉", () => {
		mount();
		dragFrom(blockEl(), { x: colX(1), y: rowY(1) }, { x: colX(5), y: rowY(2) });
		expect(screen.queryByTestId("drop-hint")).toBeNull();
	});

	it("慢慢拖 → 落在松手那一格,不掺动量", () => {
		const { onGrid } = mount();
		dragFrom(blockEl(), { x: colX(1), y: rowY(1) }, { x: colX(3), y: rowY(1) });
		expect(onGrid).toHaveBeenCalledWith("cover", { row: 1, column: 3 });
	});

	it("**甩一下会多走几格** —— 落点按投射出去会停到哪算,不是松手时块在哪", () => {
		const { onGrid } = mount();
		flingFrom(blockEl(), { x: colX(1), y: rowY(1) }, { x: colX(3), y: rowY(1) });
		// 同样只挪到第 3 列,但是甩过去的 —— 动量把落点带到了第 9 列(再往右会顶到
		// 「跨 4 列的块最多起在第 9 列」那道边)。
		expect(onGrid).toHaveBeenCalledWith("cover", { row: 1, column: 9 });
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

/**
 * **1:1 的前提:transform 不许被 CSS 过渡。**
 *
 * 真机上「很不跟手」就栽在这儿:块的 `className` 里挂着一个裸的 `transition`,而 Tailwind
 * 那个类**包含 `transform`**(默认 150ms)。于是 motion 每帧写进去的 translate 又被 CSS
 * 平滑一次 —— 块永远在追一个 150ms 之前的位置。1:1 那段代码一个字没错,被一个类整个抵消。
 *
 * jsdom 不带真 CSS,`getComputedStyle` 问不出过渡属性,所以这里查的是**类名**。它钉的是
 * 机制不是取值:Tailwind 里会把 transform 收进过渡的就这三个写法。
 */
describe("跟手的前提", () => {
	it("块上不许有会过渡 transform 的类 —— 有一个,1:1 就白写了", () => {
		mount();
		const cls = blockEl().className.split(/\s+/);
		for (const bad of ["transition", "transition-all", "transition-transform"]) {
			expect(cls, `\`${bad}\` 会把 transform 也过渡掉`).not.toContain(bad);
		}
	});
});

/**
 * **三重闸**(2026-09-16 主人:「三重都还好,四重就乱掉了,限制最多三重」)。
 *
 * 几何那半在 `canvas-drag.test.ts` 钉过;这份钉的是**闸真的接在拖拽这条线上** ——
 * 算得对但没人调,和没写一样(皮肤这一摊栽过的那族)。
 *
 * 只拦这一口:检查器的数字框与皮肤包 schema 都照旧放行(主人拍板)。
 */
describe("拖块身 —— 三重闸", () => {
	const filled = (id: string, showIf?: string) => ({
		id,
		kind: "builtin" as const,
		builtin: id,
		grid: { row: 2, column: 1, span: 12 },
		...(showIf ? { showIf } : {}),
	});

	const withRow2 = (...blocks: Array<Record<string, unknown>>) => ({
		width: 600,
		blocks: [
			{ id: "cover", kind: "builtin", builtin: "cover", grid: { row: 1, column: 1, span: 4 } },
			...blocks,
		],
	});

	it("那一格已经三重 → 停住,不让它叠成第四层", () => {
		const { onGrid } = mount({
			card: withRow2(filled("name"), filled("title"), filled("desc")) as never,
		});
		dragFrom(blockEl(), { x: colX(1), y: rowY(1) }, { x: colX(1), y: rowY(2) });
		// 顶到边就停住,同一条形状 —— 交出去的仍是它出发的那一格。
		expect(onGrid).toHaveBeenCalledWith("cover", { row: 1, column: 1 });
	});

	it("只有两重 → 照旧落得下去(闸别拦过头)", () => {
		const { onGrid } = mount({ card: withRow2(filled("name"), filled("title")) as never });
		dragFrom(blockEl(), { x: colX(1), y: rowY(1) }, { x: colX(1), y: rowY(2) });
		expect(onGrid).toHaveBeenCalledWith("cover", { row: 2, column: 1 });
	});

	it("底下那三个都写了 showIf → 一个都不数,照旧落得下去", () => {
		const { onGrid } = mount({
			card: withRow2(
				filled("name", "up.name"),
				filled("title", "up.name"),
				filled("desc", "up.name"),
			) as never,
		});
		dragFrom(blockEl(), { x: colX(1), y: rowY(1) }, { x: colX(1), y: rowY(2) });
		expect(onGrid).toHaveBeenCalledWith("cover", { row: 2, column: 1 });
	});
});
