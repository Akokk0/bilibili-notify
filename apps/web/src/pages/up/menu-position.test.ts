import { describe, expect, it } from "vite-plus/test";
import { computeMenuPosition } from "./menu-position";

/**
 * 右键 / 长按菜单是一个跟手浮层：默认菜单左上角锚在触发点、向右下展开；
 * 贴近视口右 / 下边缘时翻转，避免溢出被裁切。computeMenuPosition 把这套
 * 定位规则抽成纯函数，好在 node 环境无 DOM 地穷举边界。
 */
describe("computeMenuPosition", () => {
	it("空间充足时,菜单左上角锚定在触发点(向右下展开)", () => {
		const p = computeMenuPosition({
			anchorX: 100,
			anchorY: 100,
			menuW: 180,
			menuH: 200,
			viewportW: 1000,
			viewportH: 800,
		});
		expect(p).toEqual({ x: 100, y: 100 });
	});

	it("触发点贴近右边缘 → 菜单向左翻转(右缘对齐触发点),下方够则纵向不翻", () => {
		// 950 + 180 + 8(margin) = 1138 > 1000 → 横向翻转:x = 950 - 180 = 770
		// 100 + 200 + 8 = 308 < 800 → 纵向空间足,y 不翻
		const p = computeMenuPosition({
			anchorX: 950,
			anchorY: 100,
			menuW: 180,
			menuH: 200,
			viewportW: 1000,
			viewportH: 800,
		});
		expect(p).toEqual({ x: 770, y: 100 });
	});

	it("视口极小,翻转后仍越界 → clamp 进视口、贴 margin 不溢出", () => {
		// 横向:50+180+8>200 翻转 x=50-180=-130 < margin → clamp 到 8
		// 纵向:30+200+8>150 翻转 y=30-200=-170 < margin → clamp 到 8
		const p = computeMenuPosition({
			anchorX: 50,
			anchorY: 30,
			menuW: 180,
			menuH: 200,
			viewportW: 200,
			viewportH: 150,
		});
		expect(p).toEqual({ x: 8, y: 8 });
	});
});
