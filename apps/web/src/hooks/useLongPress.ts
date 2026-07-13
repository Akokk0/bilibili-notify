import { useCallback, useRef } from "react";

interface LongPressPoint {
	x: number;
	y: number;
}

/** handler 只读取坐标与按键,故用结构类型,DOM / React 的 PointerEvent 都能传入。 */
type PointerLike = { clientX: number; clientY: number; button?: number };

/** click 只需阻止冒泡 / 默认,用结构类型兼容 DOM / React 的 MouseEvent。 */
type ClickLike = { stopPropagation: () => void; preventDefault: () => void };

export interface UseLongPressOptions {
	onLongPress: (point: LongPressPoint) => void;
	/** 触发阈值,默认 500ms。 */
	delayMs?: number;
	/** 手指移动超过该像素判为滚动、取消长按,默认 10px。 */
	moveTolerance?: number;
}

export interface LongPressHandlers {
	onPointerDown: (e: PointerLike) => void;
	onPointerMove: (e: PointerLike) => void;
	onPointerUp: () => void;
	onClickCapture: (e: ClickLike) => void;
}

export function useLongPress({
	onLongPress,
	delayMs = 500,
	moveTolerance = 10,
}: UseLongPressOptions): LongPressHandlers {
	const timer = useRef<number | null>(null);
	const start = useRef<LongPressPoint | null>(null);
	/** 长按刚触发过 → 吞掉紧接着那次 click,免得误开卡片抽屉。 */
	const suppressClick = useRef(false);

	const cancel = useCallback(() => {
		if (timer.current !== null) {
			window.clearTimeout(timer.current);
			timer.current = null;
		}
		start.current = null;
	}, []);

	const onPointerDown = useCallback(
		(e: PointerLike) => {
			// 只对主键 / 触摸(button 0 或缺省)长按;右键等非主键交给 contextmenu,避免双触发。
			if (e.button != null && e.button !== 0) return;
			cancel();
			suppressClick.current = false;
			const x = e.clientX;
			const y = e.clientY;
			start.current = { x, y };
			timer.current = window.setTimeout(() => {
				suppressClick.current = true;
				onLongPress({ x, y });
			}, delayMs);
		},
		[cancel, onLongPress, delayMs],
	);

	const onClickCapture = useCallback((e: ClickLike) => {
		if (suppressClick.current) {
			e.stopPropagation();
			e.preventDefault();
			suppressClick.current = false;
		}
	}, []);

	const onPointerMove = useCallback(
		(e: PointerLike) => {
			if (start.current === null || timer.current === null) return;
			const dx = e.clientX - start.current.x;
			const dy = e.clientY - start.current.y;
			if (Math.hypot(dx, dy) > moveTolerance) cancel();
		},
		[cancel, moveTolerance],
	);

	return { onPointerDown, onPointerMove, onPointerUp: cancel, onClickCapture };
}
