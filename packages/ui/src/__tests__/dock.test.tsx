// @vitest-environment jsdom
/**
 * DockPill / DockPanel —— 底边 dock 的两件:左下角药丸(入口 + 快捷位 + 「有假状态」呼吸点)
 * 与底边升起的整宽面板(拖顶边改高、ESC 收、左栏分组)。
 *
 * 两件都是纯展示:开没开、多高、选了哪组全由调用方握着,这里只守「交互事件真的发出去」
 * 与「皮肤挂点没掉」。
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { DockPanel, DockPill } from "../dock";

afterEach(cleanup);

describe("DockPill", () => {
	it("主钮:名字、aria-expanded 跟着 open、点了 onToggle;挂 chip(开合钮,同 DisclosurePill)", () => {
		const onToggle = vi.fn();
		render(<DockPill label="devtools" icon={<i />} open={false} onToggle={onToggle} />);
		const main = screen.getByRole("button", { name: "devtools" });
		expect(main.getAttribute("aria-expanded")).toBe("false");
		expect(main.getAttribute("data-bn")).toBe("chip");
		fireEvent.click(main);
		expect(onToggle).toHaveBeenCalledOnce();
	});

	it("active 时挂呼吸点并把 activeTitle 念给读屏器;不 active 没有点", () => {
		const { rerender } = render(
			<DockPill label="devtools" icon={<i />} open={false} onToggle={() => {}} />,
		);
		expect(screen.queryByRole("img", { name: /生效/ })).toBeNull();
		rerender(
			<DockPill
				label="devtools"
				icon={<i />}
				open={false}
				onToggle={() => {}}
				active
				activeTitle="2 项生效"
			/>,
		);
		expect(screen.getByRole("img", { name: "2 项生效" })).toBeTruthy();
	});

	it("快捷位:每个 action 一个钮,点了 onRun;busy 的禁用", () => {
		const onRun = vi.fn();
		render(
			<DockPill
				label="devtools"
				icon={<i />}
				open={false}
				onToggle={() => {}}
				actions={[
					{ id: "a", label: "造一条开播", onRun },
					{ id: "b", label: "造更新", onRun: () => {}, busy: true },
				]}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "造一条开播" }));
		expect(onRun).toHaveBeenCalledOnce();
		expect((screen.getByRole("button", { name: "造更新" }) as HTMLButtonElement).disabled).toBe(
			true,
		);
	});

	it("offsetBottom 是运行时几何量,落在 style 上 —— 面板升起时药丸骑在它顶边上", () => {
		render(<DockPill label="devtools" icon={<i />} open onToggle={() => {}} offsetBottom={420} />);
		const root = screen.getByRole("button", { name: "devtools" }).closest("[data-dock-pill]");
		expect((root as HTMLElement).style.bottom).toBe("420px");
	});
});

function renderPanel(overrides: Partial<Parameters<typeof DockPanel>[0]> = {}) {
	const props = {
		title: "devtools",
		height: 300,
		onHeightChange: vi.fn(),
		onClose: vi.fn(),
		rail: [
			{ id: "event", label: "事件", icon: <i /> },
			{ id: "state", label: "状态", icon: <i />, count: 2 },
		],
		activeId: "state",
		onPick: vi.fn(),
		children: <p>正文</p>,
		...overrides,
	};
	render(<DockPanel {...props} />);
	return props;
}

describe("DockPanel", () => {
	it("是个 dialog,高度落在 style 上,正文渲染出来", () => {
		renderPanel();
		const dialog = screen.getByRole("dialog", { name: "devtools" });
		expect(dialog.style.height).toBe("300px");
		expect(screen.getByText("正文")).toBeTruthy();
	});

	it("ESC 收", () => {
		const { onClose } = renderPanel();
		fireEvent.keyDown(window, { key: "Escape" });
		expect(onClose).toHaveBeenCalledOnce();
	});

	it("左栏:挂 nav / nav-item,选中那项额外挂 nav-item-active 并带 aria-current;点了 onPick", () => {
		const { onPick } = renderPanel();
		const rail = screen.getByRole("navigation", { name: "devtools 分组" });
		expect(rail.getAttribute("data-bn")).toBe("nav");
		const state = screen.getByRole("button", { name: /状态/ });
		const event = screen.getByRole("button", { name: /事件/ });
		expect(state.getAttribute("data-bn")).toBe("nav-item nav-item-active");
		expect(state.getAttribute("aria-current")).toBe("true");
		expect(event.getAttribute("data-bn")).toBe("nav-item");
		fireEvent.click(event);
		expect(onPick).toHaveBeenCalledWith("event");
	});

	it("计数徽章跟在分组名后面", () => {
		renderPanel();
		expect(screen.getByRole("button", { name: /状态/ }).textContent).toContain("2");
	});

	it("拖顶边:往上拖多少就长多少,夹在 min 与视口九成之间", () => {
		const { onHeightChange } = renderPanel({ height: 300, minHeight: 160 });
		Object.defineProperty(window, "innerHeight", { value: 1000, configurable: true });
		const handle = screen.getByRole("separator", { name: "拖动改高" });

		fireEvent.pointerDown(handle, { clientY: 700, pointerId: 1 });
		fireEvent.pointerMove(handle, { clientY: 600, pointerId: 1 });
		expect(onHeightChange).toHaveBeenLastCalledWith(400);

		fireEvent.pointerMove(handle, { clientY: 950, pointerId: 1 });
		expect(onHeightChange).toHaveBeenLastCalledWith(160);

		fireEvent.pointerMove(handle, { clientY: -500, pointerId: 1 });
		expect(onHeightChange).toHaveBeenLastCalledWith(900);

		fireEvent.pointerUp(handle, { pointerId: 1 });
		fireEvent.pointerMove(handle, { clientY: 100, pointerId: 1 });
		// 松手之后再动就不算了。
		expect(onHeightChange).toHaveBeenCalledTimes(3);
	});

	it("顶部的「当前生效」条是个插槽", () => {
		renderPanel({ header: <div>3 项生效</div> });
		expect(screen.getByText("3 项生效")).toBeTruthy();
	});
});
