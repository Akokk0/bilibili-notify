// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { UpCardMenu, type UpCardMenuProps } from "./UpCardMenu";

/**
 * 右键 / 长按唤起的浮层菜单。受控组件:父层决定它是否渲染、放在哪(x/y),菜单只
 * 负责画五项、把点击转成对应回调、并在 Esc / 点外时请求关闭。启用 / 禁用文案随
 * 订阅当前状态动态变化。
 */
afterEach(cleanup);

function baseProps(overrides: Partial<UpCardMenuProps> = {}): UpCardMenuProps {
	return {
		enabled: true,
		x: 0,
		y: 0,
		onClose: vi.fn(),
		onEdit: vi.fn(),
		onToggleEnabled: vi.fn(),
		onCopyUid: vi.fn(),
		onAddToGroup: vi.fn(),
		onDelete: vi.fn(),
		...overrides,
	};
}

describe("UpCardMenu", () => {
	it("已启用:显示五项,开关项文案为「禁用订阅」", () => {
		render(<UpCardMenu {...baseProps({ enabled: true })} />);

		expect(screen.getByText("编辑详情")).toBeTruthy();
		expect(screen.getByText("禁用订阅")).toBeTruthy();
		expect(screen.getByText("复制 UID")).toBeTruthy();
		expect(screen.getByText("编辑分组")).toBeTruthy();
		expect(screen.getByText("删除订阅")).toBeTruthy();
	});

	it("已禁用:开关项文案为「启用订阅」", () => {
		render(<UpCardMenu {...baseProps({ enabled: false })} />);

		expect(screen.getByText("启用订阅")).toBeTruthy();
		expect(screen.queryByText("禁用订阅")).toBeNull();
	});

	it("点某项 → 触发对应回调并请求关闭", () => {
		const onCopyUid = vi.fn();
		const onClose = vi.fn();
		render(<UpCardMenu {...baseProps({ onCopyUid, onClose })} />);

		fireEvent.click(screen.getByText("复制 UID"));

		expect(onCopyUid).toHaveBeenCalledTimes(1);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("按 Esc → 请求关闭", () => {
		const onClose = vi.fn();
		render(<UpCardMenu {...baseProps({ onClose })} />);

		fireEvent.keyDown(document, { key: "Escape" });

		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("在菜单外按下 → 请求关闭", () => {
		const onClose = vi.fn();
		render(<UpCardMenu {...baseProps({ onClose })} />);

		fireEvent.pointerDown(document.body);

		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("在菜单内部按下 → 不关闭", () => {
		const onClose = vi.fn();
		render(<UpCardMenu {...baseProps({ onClose })} />);

		fireEvent.pointerDown(screen.getByRole("menu"));

		expect(onClose).not.toHaveBeenCalled();
	});
});
