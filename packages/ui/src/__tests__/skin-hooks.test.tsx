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
import { TabBarShell } from "../tab-bar";

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
});
