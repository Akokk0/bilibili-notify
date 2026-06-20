// @vitest-environment jsdom

/**
 * SectionNav 响应式导航的渲染层测试。
 *
 * 背景:Rules / Targets / Logs 三页的左侧 Tab 导航原本是无条件 `sticky` 的竖栏,
 * 在 xl(1280) 以下单列时被钉住、被下方内容从下往上覆盖(iPad 视口坍缩)。
 * SectionNav 以双形态收口:xl+ 渲染左侧竖栏(`aside`),xl 以下渲染顶部横向 chip 条,
 * 横向条带 sticky + 不透明背景 + z-index,让内容从其下穿过而非覆盖 —— 这是修复核心。
 *
 * 真实 sticky 视觉重叠 jsdom 测不了,这里用类结构 + 双形态并存把修复意图钉死。
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { SectionNav, type SectionNavItem } from "../section-nav";

const items: SectionNavItem[] = [
	{ id: "a", label: "运行日志", desc: "实时输出与归档检索", icon: <span>i1</span> },
	{ id: "b", label: "更新日志", desc: "独立端版本变更记录", icon: <span>i2</span> },
];

afterEach(() => cleanup());

describe("SectionNav", () => {
	it("renders every item label", () => {
		render(<SectionNav heading="日志" items={items} activeId="a" onPick={() => {}} />);
		// 双形态并存 → 每个 label 至少出现一次(竖栏 + 横向条)
		expect(screen.getAllByText("运行日志").length).toBeGreaterThanOrEqual(1);
		expect(screen.getAllByText("更新日志").length).toBeGreaterThanOrEqual(1);
	});

	it("calls onPick with the item id when clicked", () => {
		const onPick = vi.fn();
		render(<SectionNav heading="日志" items={items} activeId="a" onPick={onPick} />);
		fireEvent.click(screen.getAllByRole("button", { name: /更新日志/ })[0]);
		expect(onPick).toHaveBeenCalledWith("b");
	});

	it("marks the active item with aria-current", () => {
		render(<SectionNav heading="日志" items={items} activeId="b" onPick={() => {}} />);
		const current = screen.getAllByRole("button", { name: /更新日志/ });
		expect(current.every((el) => el.getAttribute("aria-current") === "true")).toBe(true);
		const inactive = screen.getAllByRole("button", { name: /运行日志/ });
		expect(inactive.every((el) => el.getAttribute("aria-current") === null)).toBe(true);
	});

	it("renders both a sticky vertical rail and a sticky horizontal bar", () => {
		const { container } = render(
			<SectionNav heading="日志" items={items} activeId="a" onPick={() => {}} />,
		);
		const rail = container.querySelector('aside[data-section-nav="rail"]');
		const bar = container.querySelector('[data-section-nav="bar"]');
		expect(rail).toBeTruthy();
		expect(bar).toBeTruthy();
		expect(rail?.classList.contains("sticky")).toBe(true);
		expect(rail?.classList.contains("hidden")).toBe(true); // 竖栏默认隐藏,xl 才显示
	});

	// 回归(修复核心):横向条必须 sticky + 不透明背景 + z-index,否则窄屏滚动时
	// 内容会从下往上覆盖被钉住的 Tab 条。
	it("gives the horizontal bar sticky + background + z-index so content scrolls under it", () => {
		const { container } = render(
			<SectionNav heading="日志" items={items} activeId="a" onPick={() => {}} />,
		);
		const bar = container.querySelector('[data-section-nav="bar"]');
		const cls = Array.from(bar?.classList ?? []);
		expect(cls).toContain("sticky");
		expect(cls.some((c) => c.startsWith("z-"))).toBe(true);
		expect(cls.some((c) => c.startsWith("bg-"))).toBe(true);
		expect(cls).toContain("xl:hidden"); // 横向条只在 xl 以下出现
	});

	// 用户诉求:横向 Tab 用左右按钮滚动,而不是露出(丑的)原生滚动条。
	it("hides the native scrollbar on the horizontal chip row", () => {
		const { container } = render(
			<SectionNav heading="日志" items={items} activeId="a" onPick={() => {}} />,
		);
		const bar = container.querySelector('[data-section-nav="bar"]');
		const scroller = bar?.querySelector(".bn-no-scrollbar");
		expect(scroller).toBeTruthy();
		expect(scroller?.classList.contains("overflow-x-auto")).toBe(true);
	});

	it("shows desc only in the vertical rail, not in horizontal chips", () => {
		render(<SectionNav heading="日志" items={items} activeId="a" onPick={() => {}} />);
		// desc 仅竖栏渲染 → 全文档只出现一次
		expect(screen.getAllByText("实时输出与归档检索").length).toBe(1);
	});

	it("renders an add affordance in both forms only when onAdd is given", () => {
		const onAdd = vi.fn();
		const { rerender } = render(
			<SectionNav
				heading="适配器"
				items={items}
				activeId="a"
				onPick={() => {}}
				onAdd={onAdd}
				addLabel="+ 新建"
			/>,
		);
		const addButtons = screen.getAllByRole("button", { name: /新建/ });
		expect(addButtons.length).toBeGreaterThanOrEqual(2); // 竖栏 heading 按钮 + 横向尾部 chip
		fireEvent.click(addButtons[0]);
		expect(onAdd).toHaveBeenCalledTimes(1);

		rerender(<SectionNav heading="适配器" items={items} activeId="a" onPick={() => {}} />);
		expect(screen.queryByRole("button", { name: /新建/ })).toBeNull();
	});

	it("renders emptyState in the rail when items is empty", () => {
		render(
			<SectionNav
				heading="适配器"
				items={[]}
				activeId={null}
				onPick={() => {}}
				emptyState={<div>尚未配置任何适配器</div>}
			/>,
		);
		expect(screen.getByText("尚未配置任何适配器")).toBeTruthy();
	});
});
