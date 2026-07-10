// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useLongPress } from "./useLongPress";

/**
 * 触屏没有右键,靠长按兜底唤起菜单。useLongPress 返回一组 pointer handler:
 * 按住满阈值(默认 500ms)触发 onLongPress 并带上触发点坐标;期间手指挪动超容差
 * 判为滚动、取消;短按(未到阈值就抬手)不触发;长按触发后要吞掉那次抬手 click,
 * 免得误开卡片抽屉。
 */
function down(x: number, y: number, button = 0): PointerEvent {
	return { clientX: x, clientY: y, pointerId: 1, button } as unknown as PointerEvent;
}

function clickEvt(): { evt: MouseEvent } {
	const evt = new MouseEvent("click", { bubbles: true });
	vi.spyOn(evt, "stopPropagation");
	vi.spyOn(evt, "preventDefault");
	return { evt };
}

describe("useLongPress", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("按住满 500ms → 触发 onLongPress,带触发点坐标", () => {
		const onLongPress = vi.fn();
		const { result } = renderHook(() => useLongPress({ onLongPress }));

		act(() => result.current.onPointerDown(down(30, 40)));
		act(() => vi.advanceTimersByTime(500));

		expect(onLongPress).toHaveBeenCalledWith({ x: 30, y: 40 });
	});

	it("短按(未到阈值就抬手) → 不触发 onLongPress", () => {
		const onLongPress = vi.fn();
		const { result } = renderHook(() => useLongPress({ onLongPress }));

		act(() => result.current.onPointerDown(down(30, 40)));
		act(() => vi.advanceTimersByTime(300));
		act(() => result.current.onPointerUp());
		act(() => vi.advanceTimersByTime(500)); // 再等也不该触发

		expect(onLongPress).not.toHaveBeenCalled();
	});

	it("按住期间手指移动超容差(默认 10px) → 判为滚动、取消,不触发", () => {
		const onLongPress = vi.fn();
		const { result } = renderHook(() => useLongPress({ onLongPress }));

		act(() => result.current.onPointerDown(down(30, 40)));
		act(() => vi.advanceTimersByTime(200));
		act(() => result.current.onPointerMove(down(30, 60))); // 位移 20px > 10
		act(() => vi.advanceTimersByTime(500));

		expect(onLongPress).not.toHaveBeenCalled();
	});

	it("按住期间轻微移动(容差内) → 不取消,仍触发", () => {
		const onLongPress = vi.fn();
		const { result } = renderHook(() => useLongPress({ onLongPress }));

		act(() => result.current.onPointerDown(down(30, 40)));
		act(() => result.current.onPointerMove(down(34, 43))); // 位移 5px < 10
		act(() => vi.advanceTimersByTime(500));

		expect(onLongPress).toHaveBeenCalledWith({ x: 30, y: 40 });
	});

	it("长按触发后,紧接着那次 click 被吞掉(阻止冒泡+默认),不误开卡片抽屉", () => {
		const onLongPress = vi.fn();
		const { result } = renderHook(() => useLongPress({ onLongPress }));

		act(() => result.current.onPointerDown(down(30, 40)));
		act(() => vi.advanceTimersByTime(500)); // 触发长按
		const { evt } = clickEvt();
		act(() => result.current.onClickCapture(evt));

		expect(evt.stopPropagation).toHaveBeenCalled();
		expect(evt.preventDefault).toHaveBeenCalled();
	});

	it("非主键(如右键)按下 → 不启动长按,避免与 contextmenu 双触发", () => {
		const onLongPress = vi.fn();
		const { result } = renderHook(() => useLongPress({ onLongPress }));

		act(() => result.current.onPointerDown(down(10, 10, 2)));
		act(() => vi.advanceTimersByTime(500));

		expect(onLongPress).not.toHaveBeenCalled();
	});

	it("普通短按的 click 不被吞", () => {
		const onLongPress = vi.fn();
		const { result } = renderHook(() => useLongPress({ onLongPress }));

		act(() => result.current.onPointerDown(down(30, 40)));
		act(() => vi.advanceTimersByTime(200));
		act(() => result.current.onPointerUp());
		const { evt } = clickEvt();
		act(() => result.current.onClickCapture(evt));

		expect(evt.stopPropagation).not.toHaveBeenCalled();
	});
});
