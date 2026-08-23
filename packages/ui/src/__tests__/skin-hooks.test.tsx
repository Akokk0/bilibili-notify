// @vitest-environment jsdom

/**
 * 皮肤 CSS hook 挂点:SKIN_CSS_HOOK_MAP 里映射到 `[data-bn~=…]` 的 hook,
 * 相应组件必须真的挂着 data-bn 属性 —— 名单是公开 API,挂点掉了皮肤就静默失效。
 * (page/glass/glass-strong 映射到 body/类名,无需挂点。)
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { Avatar, Btn, Input } from "../atoms";
import { ModalShell } from "../dialog";
import { SectionNav } from "../section-nav";
import { TabBarShell, TabButton } from "../tab-bar";

afterEach(cleanup);

function hooksOf(el: Element | null): string[] {
	return (el?.getAttribute("data-bn") ?? "").split(/\s+/).filter(Boolean);
}

describe("skin css hooks", () => {
	it("Btn 挂 btn;primary 变体额外挂 btn-primary", () => {
		render(
			<>
				<Btn>主</Btn>
				<Btn variant="outline">次</Btn>
			</>,
		);
		expect(hooksOf(screen.getByText("主"))).toEqual(["btn", "btn-primary"]);
		expect(hooksOf(screen.getByText("次"))).toEqual(["btn"]);
	});

	/**
	 * tab 上那排按钮此前一个挂点都没有,而选中态的粉色渐变还是写在 **inline style**
	 * 上的 —— inline 优先级压过一切 author 样式,皮肤连覆盖的机会都没有。于是整站
	 * 换皮之后,tab 条上的选中块仍是原来那个粉(2026-08-20 主人真机指出同一处)。
	 * 2026-08-23 起挂点从 btn/btn-primary 换成 tab/tab-active:皮肤的按钮实底曾把
	 * 整排 tab 画成一排按钮,tab 有自己的词。
	 */
	it("TabButton 挂 tab(不再挂 btn);选中态额外挂 tab-active", () => {
		render(
			<TabBarShell>
				<TabButton active onClick={() => {}}>
					选中
				</TabButton>
				<TabButton active={false} onClick={() => {}}>
					未选
				</TabButton>
			</TabBarShell>,
		);
		expect(hooksOf(screen.getByText("选中").closest("button"))).toEqual(["tab", "tab-active"]);
		expect(hooksOf(screen.getByText("未选").closest("button"))).toEqual(["tab"]);
	});

	it("Input 外框挂 input(视觉盒是包壳 div)", () => {
		const { container } = render(<Input value="" onChange={() => {}} />);
		expect(container.querySelector('[data-bn~="input"]')).toBeTruthy();
	});

	it("Avatar 的挂点在圆形元素上(挂方形定位容器会让皮肤 border 画成方框)", () => {
		const { container } = render(<Avatar name="兔" color="#fb7299" />);
		const el = container.querySelector('[data-bn~="avatar"]');
		expect(el).toBeTruthy();
		expect(el?.className).toContain("rounded-full");
	});

	it("ModalShell 弹窗卡挂 modal", () => {
		render(
			<ModalShell onCancel={() => {}} width={300}>
				<div>内容</div>
			</ModalShell>,
		);
		expect(hooksOf(screen.getByRole("dialog"))).toContain("modal");
	});

	it("TabBarShell 根挂 nav,且带圆角(皮肤描边不许画出直角框)", () => {
		const { container } = render(<TabBarShell>x</TabBarShell>);
		const el = container.querySelector('[data-bn~="nav"]');
		expect(el).toBeTruthy();
		expect(el?.className).toMatch(/rounded/);
	});

	// 主人在真机上撞到的:皮肤给 nav 画了底色,连「卡片样式」这行小标题一起被罩进去,
	// 看着像标题掉进了 tab 卡里。挂点要只裹 tab 列表本身,标题留在外面。
	it("竖栏挂点只裹 tab 列表,heading 不在里面", () => {
		const { container } = render(
			<SectionNav
				heading="卡片样式"
				items={[{ id: "a", label: "全局" }]}
				activeId="a"
				onPick={() => {}}
			/>,
		);
		const host = container.querySelector('[data-section-nav="rail"] [data-bn~="nav"]');
		expect(host).toBeTruthy();
		expect(host?.textContent).toContain("全局");
		expect(host?.textContent).not.toContain("卡片样式");
	});

	it("SectionNav 竖栏与横条都挂 nav,挂点元素都带圆角", () => {
		const { container } = render(
			<SectionNav heading="H" items={[{ id: "a", label: "A" }]} activeId="a" onPick={() => {}} />,
		);
		const hosts = [...container.querySelectorAll('[data-bn~="nav"]')];
		expect(hosts).toHaveLength(2);
		for (const el of hosts) expect(el.className).toMatch(/rounded/);
	});

	/**
	 * 导航行不是按钮:挂 btn 的年代,皮肤的按钮实底把竖栏每一行都画成一颗按钮
	 * (2026-08-23 主人真机指出)。选中态走多挂点(同 TabButton 的 btn-primary)——
	 * 清洗层不放行属性选择器,皮肤够不到 aria-current。
	 */
	it("SectionNav 项挂 nav-item(不再挂 btn),选中项额外挂 nav-item-active", () => {
		const { container } = render(
			<SectionNav
				heading="H"
				items={[
					{ id: "a", label: "A" },
					{ id: "b", label: "B" },
				]}
				activeId="a"
				onPick={() => {}}
			/>,
		);
		// 竖栏 + 横条各渲染一份,每份 2 项。
		const items = [...container.querySelectorAll('[data-bn~="nav-item"]')];
		expect(items).toHaveLength(4);
		for (const el of items) expect(hooksOf(el)).not.toContain("btn");
		const actives = [...container.querySelectorAll('[data-bn~="nav-item-active"]')];
		expect(actives).toHaveLength(2);
		for (const el of actives) expect(el.getAttribute("aria-current")).toBe("true");
	});
});
