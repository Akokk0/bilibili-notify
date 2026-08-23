// @vitest-environment jsdom

/**
 * `useDismiss` —— 「点外面关掉」的唯一写法。收编前站内抄了五份且行为不一致
 * (只有一份处理 Escape、只有一份 pointerdown),这里钉住收编后的行为面。
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { useDismiss } from "../popover";

afterEach(cleanup);

function Host({
	onDismiss,
	enabled = true,
	escape: escToClose = false,
	event,
}: {
	onDismiss: () => void;
	enabled?: boolean;
	escape?: boolean;
	event?: "mousedown" | "pointerdown";
}) {
	const ref = useRef<HTMLDivElement>(null);
	useDismiss(ref, onDismiss, { enabled, escape: escToClose, event });
	return (
		<div>
			<div ref={ref}>
				<button type="button">inside</button>
			</div>
			<button type="button">outside</button>
		</div>
	);
}

describe("useDismiss", () => {
	it("点外面触发,点里面不触发", () => {
		const spy = vi.fn();
		render(<Host onDismiss={spy} />);
		fireEvent.mouseDown(screen.getByText("inside"));
		expect(spy).not.toHaveBeenCalled();
		fireEvent.mouseDown(screen.getByText("outside"));
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("enabled=false 时不挂监听 —— 浮层收起后点哪都不该再触发", () => {
		const spy = vi.fn();
		render(<Host onDismiss={spy} enabled={false} />);
		fireEvent.mouseDown(screen.getByText("outside"));
		expect(spy).not.toHaveBeenCalled();
	});

	it("escape 选项开着时按 Esc 也关;默认不管键盘", () => {
		const spy = vi.fn();
		render(<Host onDismiss={spy} escape />);
		fireEvent.keyDown(document, { key: "Escape" });
		expect(spy).toHaveBeenCalledTimes(1);
		cleanup();
		const spy2 = vi.fn();
		render(<Host onDismiss={spy2} />);
		fireEvent.keyDown(document, { key: "Escape" });
		expect(spy2).not.toHaveBeenCalled();
	});

	it("event=pointerdown 走 pointer 事件,mousedown 不再触发", () => {
		const spy = vi.fn();
		render(<Host onDismiss={spy} event="pointerdown" />);
		fireEvent.mouseDown(screen.getByText("outside"));
		expect(spy).not.toHaveBeenCalled();
		fireEvent.pointerDown(screen.getByText("outside"));
		expect(spy).toHaveBeenCalledTimes(1);
	});
});
