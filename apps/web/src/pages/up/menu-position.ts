export interface MenuPositionInput {
	/** 触发点(鼠标 / 手指)相对视口的 X 坐标。 */
	anchorX: number;
	/** 触发点相对视口的 Y 坐标。 */
	anchorY: number;
	/** 菜单浮层宽度(px)。 */
	menuW: number;
	/** 菜单浮层高度(px)。 */
	menuH: number;
	/** 视口宽度(px)。 */
	viewportW: number;
	/** 视口高度(px)。 */
	viewportH: number;
	/** 距视口边缘留白，默认 8px。 */
	margin?: number;
}

export interface MenuPlacement {
	x: number;
	y: number;
}

/**
 * 算出右键 / 长按菜单浮层左上角应放置的坐标。默认锚在触发点、向右下展开;
 * 贴近视口右 / 下边缘时翻转到触发点左 / 上，且最终 clamp 进视口不溢出。
 */
export function computeMenuPosition(input: MenuPositionInput): MenuPlacement {
	const margin = input.margin ?? 8;
	let x = input.anchorX;
	let y = input.anchorY;
	if (x + input.menuW + margin > input.viewportW) x = input.anchorX - input.menuW;
	if (y + input.menuH + margin > input.viewportH) y = input.anchorY - input.menuH;
	const clamp = (v: number, menu: number, viewport: number): number =>
		Math.min(Math.max(v, margin), Math.max(margin, viewport - menu - margin));
	return {
		x: clamp(x, input.menuW, input.viewportW),
		y: clamp(y, input.menuH, input.viewportH),
	};
}
