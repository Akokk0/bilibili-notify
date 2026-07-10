// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { makeEmptySubscription } from "../../types/domain";
import { UpCard, type UpCardProps } from "./UpCard";

/**
 * 卡片的菜单触发接线:桌面右键(onContextMenu,阻止浏览器原生菜单)、触屏长按,都
 * 转成 onRequestMenu(坐标),由父层据此在该坐标弹 UpCardMenu。
 */
afterEach(cleanup);

function props(overrides: Partial<UpCardProps> = {}): UpCardProps {
	return {
		sub: makeEmptySubscription("100"),
		selected: false,
		onClick: vi.fn(),
		onToggleSelect: vi.fn(),
		onToggleEnabled: vi.fn(),
		togglePending: false,
		onRequestMenu: vi.fn(),
		...overrides,
	};
}

describe("UpCard 菜单触发", () => {
	it("右键卡片 → onRequestMenu(带触发点坐标)", () => {
		const onRequestMenu = vi.fn();
		const { container } = render(<UpCard {...props({ onRequestMenu })} />);

		fireEvent.contextMenu(container.firstChild as Element, { clientX: 111, clientY: 222 });

		expect(onRequestMenu).toHaveBeenCalledWith({ x: 111, y: 222 });
	});

	it("长按卡片满 500ms → onRequestMenu(带触发点坐标)", () => {
		vi.useFakeTimers();
		try {
			const onRequestMenu = vi.fn();
			const { container } = render(<UpCard {...props({ onRequestMenu })} />);

			// jsdom 的 PointerEvent 不透传 clientX/clientY,手动构造事件注入坐标。
			fireEvent(
				container.firstChild as Element,
				Object.assign(new Event("pointerdown", { bubbles: true }), { clientX: 50, clientY: 60 }),
			);
			act(() => vi.advanceTimersByTime(500));

			expect(onRequestMenu).toHaveBeenCalledWith({ x: 50, y: 60 });
		} finally {
			vi.useRealTimers();
		}
	});
});
