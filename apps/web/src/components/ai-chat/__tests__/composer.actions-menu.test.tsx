// @vitest-environment jsdom
/**
 * 输入框动作行的「+」二级菜单 —— 添加图片 / 女仆技能合并到一颗按钮底下。
 *
 * 曾经两颗图标并排(图片、+),各管一件事。主人要的是收敛成一颗「+」,点开
 * 一个小菜单再选「添加图片」或「女仆技能」—— 动作行不该同时摆好几颗长得
 * 差不多的圆按钮,新主人分不清哪个是哪个。
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { Composer } from "../composer";

afterEach(cleanup);

function renderComposer(over: Partial<Parameters<typeof Composer>[0]> = {}) {
	const onSubmit = vi.fn();
	const onChange = vi.fn();
	const onPickFiles = vi.fn();
	const onRemoveAttachment = vi.fn();
	render(
		<Composer
			value=""
			onChange={onChange}
			onSubmit={onSubmit}
			busy={false}
			aiName="小绫"
			attachments={[]}
			onPickFiles={onPickFiles}
			onRemoveAttachment={onRemoveAttachment}
			{...over}
		/>,
	);
	return { onSubmit, onChange, onPickFiles, onRemoveAttachment };
}

const openMenu = () => fireEvent.click(screen.getByRole("button", { name: "添加" }));

describe("Composer — + 二级菜单", () => {
	it("动作行只有一颗「+」,旧的两颗图标按钮不再单独露面", () => {
		renderComposer();
		expect(screen.queryByRole("button", { name: "添加图片" })).toBeNull();
		expect(screen.queryByRole("button", { name: "唤起女仆技能" })).toBeNull();
		expect(screen.getByRole("button", { name: "添加" })).toBeTruthy();
	});

	it("点「+」弹出菜单,列出「添加图片」与「女仆技能」两项", () => {
		renderComposer();
		openMenu();
		expect(screen.getByRole("menu")).toBeTruthy();
		expect(screen.getByRole("menuitem", { name: "添加图片" })).toBeTruthy();
		expect(screen.getByRole("menuitem", { name: "女仆技能" })).toBeTruthy();
	});

	it("菜单没开时两个子功能都摸不到 —— 是真的收起来了,不是藏起来又能查到", () => {
		renderComposer();
		expect(screen.queryByRole("menu")).toBeNull();
		expect(screen.queryByRole("menuitem")).toBeNull();
	});

	it("选「女仆技能」→ 唤起技能菜单(打 / 、聚焦输入框),同时关掉这层菜单", () => {
		const { onChange } = renderComposer();
		openMenu();
		fireEvent.click(screen.getByRole("menuitem", { name: "女仆技能" }));
		expect(onChange).toHaveBeenCalledWith("/");
		expect(screen.queryByRole("menu")).toBeNull();
	});

	it("选「添加图片」→ 触发隐藏的文件选择框,并关掉菜单", () => {
		renderComposer();
		openMenu();
		const clickSpy = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
		fireEvent.click(screen.getByRole("menuitem", { name: "添加图片" }));
		expect(clickSpy).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole("menu")).toBeNull();
		clickSpy.mockRestore();
	});

	it("附件已满 4 张 → 「添加图片」在菜单里是禁用的,点了没反应", () => {
		const full = [0, 1, 2, 3].map((i) => ({ id: `${i}`, url: `/a/${i}` }));
		renderComposer({ attachments: full });
		openMenu();
		const item = screen.getByRole("menuitem", { name: "添加图片" }) as HTMLButtonElement;
		expect(item.disabled).toBe(true);
		const clickSpy = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
		fireEvent.click(item);
		expect(clickSpy).not.toHaveBeenCalled();
		clickSpy.mockRestore();
	});

	it("Esc 关闭菜单", () => {
		renderComposer();
		openMenu();
		fireEvent.keyDown(document, { key: "Escape" });
		expect(screen.queryByRole("menu")).toBeNull();
	});

	it("点菜单外部关闭菜单", async () => {
		renderComposer();
		openMenu();
		fireEvent.mouseDown(document.body);
		await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
	});
});
