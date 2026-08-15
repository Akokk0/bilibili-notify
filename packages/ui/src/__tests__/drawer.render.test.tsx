// @vitest-environment jsdom

/**
 * DrawerShell:右侧滑出的非模态抽屉。与 ModalShell 的分工 —— 抽屉不带遮罩,
 * 页面保持可见可交互(实时调参用);portal 到 body;ESC 关闭。
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { DrawerShell } from "../drawer";

afterEach(cleanup);

describe("DrawerShell", () => {
	it("渲染 children 到 body portal,无遮罩(页面可见)", () => {
		const { container } = render(
			<DrawerShell onClose={() => {}} width={420} ariaLabel="皮肤调整">
				<div>抽屉内容</div>
			</DrawerShell>,
		);
		// portal:不渲染进组件自身子树
		expect(container.firstChild).toBeNull();
		const dialog = screen.getByRole("dialog", { name: "皮肤调整" });
		expect(dialog.textContent).toContain("抽屉内容");
		// 非模态:没有铺满视口的遮罩按钮(ModalShell 的「关闭弹窗」遮罩)
		expect(screen.queryByLabelText("关闭弹窗")).toBeNull();
	});

	it("按 ESC → onClose", () => {
		const onClose = vi.fn();
		render(
			<DrawerShell onClose={onClose} width={420} ariaLabel="皮肤调整">
				<div>x</div>
			</DrawerShell>,
		);
		fireEvent.keyDown(window, { key: "Escape" });
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
