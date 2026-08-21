// @vitest-environment jsdom

/**
 * MenuItem —— 弹层(下拉、右键菜单、附件菜单)里的一整行。
 *
 * 收编前站内七行手写,padding 四种、gap 两种、圆角三种、hover 三种、字号三种,
 * 而它们都是「一个浮层里、占满宽、指上去有底色的一行」。选中态只有主题下拉写了,
 * danger 态只有右键菜单写了 —— 收成一份之后两种态对所有菜单都在。
 *
 * **它刻意不挂 `data-bn="btn"`**:皮肤给按钮写的实底落到每一行菜单上会很难看,
 * 而挂点词表里没有 `menu-item` 这一档。浮层本体已经挂了 `glass-strong`,皮肤能
 * 改的是那层。要不要给菜单行开一个新挂点是产品决定,不在这次重构里。
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { Icon, MenuItem } from "../index";

afterEach(cleanup);

const row = () => screen.getByRole("button");

describe("MenuItem", () => {
	it("占满整行、左对齐、指上去有底色", () => {
		render(<MenuItem onClick={() => {}}>浅色</MenuItem>);
		const cls = row().className.split(/\s+/);
		for (const c of ["w-full", "text-left", "hover:bg-bn-hover-muted", "cursor-pointer"]) {
			expect([c, cls.includes(c)]).toEqual([c, true]);
		}
	});

	it("不挂按钮挂点 —— 菜单行不该吃皮肤给按钮写的实底", () => {
		render(<MenuItem onClick={() => {}}>浅色</MenuItem>);
		expect(row().getAttribute("data-bn")).toBeNull();
	});

	it("选中态染粉加粗,未选中走正文色", () => {
		const { unmount } = render(<MenuItem onClick={() => {}}>浅色</MenuItem>);
		expect(row().className).toContain("text-bn-text-primary");
		expect(row().className).not.toContain("font-bold");
		unmount();

		render(
			<MenuItem active onClick={() => {}}>
				浅色
			</MenuItem>,
		);
		expect(row().className).toContain("text-bn-pink");
		expect(row().className).toContain("font-bold");
	});

	it("danger 整行转红,连图标一起", () => {
		render(
			<MenuItem danger icon={<Icon.close size={14} />} onClick={() => {}}>
				删除
			</MenuItem>,
		);
		expect(row().className).toContain("text-bn-danger-text");
		const iconSlot = row().firstElementChild;
		expect(iconSlot?.className).toContain("text-bn-danger-text");
	});

	it("图标槽不被长文案压扁,平时走次级色", () => {
		render(
			<MenuItem icon={<Icon.image size={16} />} onClick={() => {}}>
				添加图片
			</MenuItem>,
		);
		const iconSlot = row().firstElementChild;
		expect(iconSlot?.className).toContain("shrink-0");
		expect(iconSlot?.className).toContain("text-bn-text-secondary");
	});

	it("不给图标就不留空槽 —— 否则没图标的那几行文字会缩进", () => {
		const { unmount } = render(<MenuItem onClick={() => {}}>浅色</MenuItem>);
		// 纯文字 children 是文本节点,不是元素:没图标时行内一个元素子节点都不该有。
		expect(row().children.length).toBe(0);
		unmount();

		render(
			<MenuItem icon={<Icon.image size={16} />} onClick={() => {}}>
				浅色
			</MenuItem>,
		);
		expect(row().children.length).toBe(1);
	});

	/**
	 * 主题下拉每行是「标题 + 一行小字说明」,读屏器默认会把两段连起来念成
	 * 「浅色 一直亮着」。名字得只留标题 —— 收编时漏掉这条,header-theme 的三条
	 * 测试当场红了。
	 */
	it("行内有副标题时,读屏器名字只取 ariaLabel", () => {
		render(
			<MenuItem ariaLabel="浅色" onClick={() => {}}>
				<span>浅色</span>
				<span>一直亮着</span>
			</MenuItem>,
		);
		expect(screen.getByRole("button", { name: "浅色" })).toBeTruthy();
	});

	it("role 可换成 menuitem,给真的 role=menu 容器用", () => {
		render(
			<MenuItem role="menuitem" onClick={() => {}}>
				置顶
			</MenuItem>,
		);
		expect(screen.getByRole("menuitem")).toBeTruthy();
	});

	it("点得动,禁用时点不动", () => {
		const onClick = vi.fn();
		const { unmount } = render(<MenuItem onClick={onClick}>浅色</MenuItem>);
		fireEvent.click(row());
		expect(onClick).toHaveBeenCalledTimes(1);
		unmount();
		render(
			<MenuItem disabled onClick={onClick}>
				浅色
			</MenuItem>,
		);
		fireEvent.click(row());
		expect(onClick).toHaveBeenCalledTimes(1);
	});
});
