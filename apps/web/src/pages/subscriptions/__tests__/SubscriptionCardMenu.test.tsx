// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { SubscriptionCardMenu, type SubscriptionCardMenuProps } from "../SubscriptionCardMenu";

/**
 * 右键 / 长按唤起的浮层菜单。受控组件:父层决定它是否渲染、放在哪(x/y),菜单只
 * 负责画五项、把点击转成对应回调、并在 Esc / 点外时请求关闭。启用 / 禁用文案随
 * 订阅当前状态动态变化。
 */
afterEach(cleanup);

function baseProps(overrides: Partial<SubscriptionCardMenuProps> = {}): SubscriptionCardMenuProps {
	return {
		enabled: true,
		x: 0,
		y: 0,
		onClose: vi.fn(),
		onEdit: vi.fn(),
		onToggleEnabled: vi.fn(),
		onCopyExternalId: vi.fn(),
		copyLabel: "复制 UID",
		onEditTags: vi.fn(),
		onDelete: vi.fn(),
		...overrides,
	};
}

describe("SubscriptionCardMenu", () => {
	it("已启用:显示五项,开关项文案为「禁用订阅」", () => {
		render(<SubscriptionCardMenu {...baseProps({ enabled: true })} />);

		expect(screen.getByText("编辑详情")).toBeTruthy();
		expect(screen.getByText("禁用订阅")).toBeTruthy();
		expect(screen.getByText("复制 UID")).toBeTruthy();
		expect(screen.getByText("编辑标签")).toBeTruthy();
		expect(screen.getByText("删除订阅")).toBeTruthy();
		// ADR-0034:分组改叫标签,旧文案不许残留。
		expect(screen.queryByText("编辑分组")).toBeNull();
	});

	it("点「编辑标签」→ 触发 onEditTags 并请求关闭", () => {
		const onEditTags = vi.fn();
		const onClose = vi.fn();
		render(<SubscriptionCardMenu {...baseProps({ onEditTags, onClose })} />);

		fireEvent.click(screen.getByText("编辑标签"));

		expect(onEditTags).toHaveBeenCalledTimes(1);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("已禁用:开关项文案为「启用订阅」", () => {
		render(<SubscriptionCardMenu {...baseProps({ enabled: false })} />);

		expect(screen.getByText("启用订阅")).toBeTruthy();
		expect(screen.queryByText("禁用订阅")).toBeNull();
	});

	it("点某项 → 触发对应回调并请求关闭", () => {
		const onCopyExternalId = vi.fn();
		const onClose = vi.fn();
		render(<SubscriptionCardMenu {...baseProps({ onCopyExternalId, onClose })} />);

		fireEvent.click(screen.getByText("复制 UID"));

		expect(onCopyExternalId).toHaveBeenCalledTimes(1);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("按 Esc → 请求关闭", () => {
		const onClose = vi.fn();
		render(<SubscriptionCardMenu {...baseProps({ onClose })} />);

		fireEvent.keyDown(document, { key: "Escape" });

		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("在菜单外按下 → 请求关闭", () => {
		const onClose = vi.fn();
		render(<SubscriptionCardMenu {...baseProps({ onClose })} />);

		fireEvent.pointerDown(document.body);

		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("在菜单内部按下 → 不关闭", () => {
		const onClose = vi.fn();
		render(<SubscriptionCardMenu {...baseProps({ onClose })} />);

		fireEvent.pointerDown(screen.getByRole("menu"));

		expect(onClose).not.toHaveBeenCalled();
	});
});
