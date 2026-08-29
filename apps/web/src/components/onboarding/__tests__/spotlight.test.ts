/**
 * 聚光灯的拦截块几何 —— 视口减去洞集的矩形补集(y 扫描分带)。
 * 钉住:补集不盖洞、洞外全覆盖、洞可以出界/重叠。
 */

import { describe, expect, it } from "vite-plus/test";
import { type SpotRect, subtractRects } from "../spotlight";

const VIEW: SpotRect = { top: 0, left: 0, width: 100, height: 100 };

function area(rects: readonly SpotRect[]): number {
	return rects.reduce((s, r) => s + r.width * r.height, 0);
}

function covers(rects: readonly SpotRect[], x: number, y: number): boolean {
	return rects.some(
		(r) => x >= r.left && x < r.left + r.width && y >= r.top && y < r.top + r.height,
	);
}

describe("subtractRects 拦截块分割", () => {
	it("单洞居中:洞内无块、洞外四向都有覆盖,面积守恒", () => {
		const hole = { top: 40, left: 40, width: 20, height: 20 };
		const blocks = subtractRects(VIEW, [hole]);
		expect(covers(blocks, 50, 50)).toBe(false);
		expect(covers(blocks, 50, 10)).toBe(true);
		expect(covers(blocks, 50, 90)).toBe(true);
		expect(covers(blocks, 10, 50)).toBe(true);
		expect(covers(blocks, 90, 50)).toBe(true);
		expect(area(blocks)).toBe(100 * 100 - 20 * 20);
	});

	it("双洞(多入口场景):两洞都露出,洞间区域仍被拦", () => {
		const holes = [
			{ top: 10, left: 10, width: 10, height: 10 },
			{ top: 70, left: 70, width: 10, height: 10 },
		];
		const blocks = subtractRects(VIEW, holes);
		expect(covers(blocks, 15, 15)).toBe(false);
		expect(covers(blocks, 75, 75)).toBe(false);
		expect(covers(blocks, 50, 50)).toBe(true);
		expect(area(blocks)).toBe(100 * 100 - 2 * 100);
	});

	it("洞出界(目标滚出视口):截进视口再算,不产生负尺寸块", () => {
		const blocks = subtractRects(VIEW, [{ top: -10, left: -10, width: 20, height: 20 }]);
		expect(covers(blocks, 5, 5)).toBe(false);
		expect(covers(blocks, 50, 50)).toBe(true);
		expect(blocks.every((b) => b.width > 0 && b.height > 0)).toBe(true);
		expect(area(blocks)).toBe(100 * 100 - 10 * 10);
	});

	it("洞重叠:重叠区不重复计,补集面积正确", () => {
		const holes = [
			{ top: 40, left: 40, width: 20, height: 20 },
			{ top: 50, left: 50, width: 20, height: 20 },
		];
		const blocks = subtractRects(VIEW, holes);
		expect(covers(blocks, 55, 55)).toBe(false);
		// 并集面积 = 400 + 400 - 100(重叠)
		expect(area(blocks)).toBe(100 * 100 - 700);
	});

	it("无洞:整个视口一块拦死(理论态,渲染层无洞时根本不亮灯)", () => {
		const blocks = subtractRects(VIEW, []);
		expect(area(blocks)).toBe(100 * 100);
	});
});
