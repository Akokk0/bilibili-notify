// @vitest-environment jsdom

/**
 * ModalShell 的标题槽。
 *
 * 收编前全站 11 个弹窗各写各的标题行:字号 14 / 15 / 16px 三种、下边距
 * mb-1 / mb-1.5 / mb-2 / mb-3 四种,而它们本来是同一件东西。壳子既然拥有这张
 * 卡,标题就该由壳子出。间距**不给调用方留口子** —— 那正是当初漂开的原因。
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { ConfirmDialog, ModalShell } from "../dialog";

afterEach(cleanup);

const shell = (props: Partial<Parameters<typeof ModalShell>[0]> = {}) =>
	render(
		<ModalShell onCancel={() => {}} width={400} {...props}>
			<div data-testid="body">正文</div>
		</ModalShell>,
	);

/** 标题/说明所在的那层包裹 —— 下边距挂在它身上。 */
const header = () => screen.getByTestId("body").previousElementSibling;

describe("ModalShell 的标题槽", () => {
	it("只有标题:15px 粗体正文色,块下 mb-3", () => {
		shell({ title: "新建适配器" });
		const t = screen.getByText("新建适配器");
		const cls = t.className.split(/\s+/);
		for (const c of ["text-bn-md", "font-bold", "text-bn-text-primary"]) {
			expect([c, cls.includes(c)]).toEqual([c, true]);
		}
		expect(header()?.className).toContain("mb-3");
	});

	it("标题 + 说明:说明贴在标题下,整块下 mb-4", () => {
		shell({ title: "删除皮肤", description: "删除后不可恢复。" });
		const d = screen.getByText("删除后不可恢复。");
		const cls = d.className.split(/\s+/);
		for (const c of ["mt-1.5", "text-bn-base", "leading-relaxed", "text-bn-text-secondary"]) {
			expect([c, cls.includes(c)]).toEqual([c, true]);
		}
		expect(header()?.className).toContain("mb-4");
		expect(header()?.className).not.toContain("mb-3");
	});

	it("只有说明(ConfirmDialog 省标题那条路):不留标题的上边距", () => {
		shell({ description: "确定要移除吗?" });
		expect(screen.getByText("确定要移除吗?").className).not.toContain("mt-1.5");
		expect(header()?.className).toContain("mb-4");
	});

	it("两个都不给:整块不渲染,正文贴着卡片顶", () => {
		shell();
		expect(screen.getByTestId("body").previousElementSibling).toBeNull();
	});

	it("标题收 ReactNode,不只是字符串", () => {
		shell({ title: <span data-testid="rich">把浅色套到深色</span> });
		expect(screen.getByTestId("rich")).toBeTruthy();
	});
});

/**
 * ConfirmDialog 是这套标题槽的第 12 个调用点,而且是唯一会「只有说明没有标题」
 * 的那个。它自己也曾手写一份 14px 标题 + 说明 + `mt-4` 动作行。
 */
describe("ConfirmDialog 走同一套标题槽", () => {
	it("title/message 分别落到标题与说明上", () => {
		render(
			<ConfirmDialog
				title="丢弃修改"
				message="改动还没保存,确定要离开吗?"
				onConfirm={() => {}}
				onCancel={() => {}}
			/>,
		);
		expect(screen.getByText("丢弃修改").className).toContain("text-bn-md");
		const desc = screen.getByText("改动还没保存,确定要离开吗?");
		expect(desc.className).toContain("text-bn-base");
		expect(desc.className).toContain("text-bn-text-secondary");
	});

	it("省掉 title 时只剩说明,动作行不另加上边距", () => {
		render(<ConfirmDialog message="确定?" onConfirm={() => {}} onCancel={() => {}} />);
		const desc = screen.getByText("确定?");
		expect(desc.className).not.toContain("mt-1.5");
		// 说明所在的块自带 mb-4,动作行贴着它,不该再挂 mt-4(那会变成双倍间距)。
		const actions = screen.getByRole("button", { name: "确认" }).parentElement;
		expect(actions?.className).not.toContain("mt-4");
		expect(desc.parentElement?.className).toContain("mb-4");
	});
});
