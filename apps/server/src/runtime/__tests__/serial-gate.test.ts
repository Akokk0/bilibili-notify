/**
 * 单元测试 —— createSerialGate:渲染串行闸。
 *
 * 背景:puppeteer 浏览器冷启动后,多张卡片并发渲染(setContent→截图)会在刚启动的
 * 浏览器上触发 CDP 截图竞态,把同一张卡平铺成 2×2 并裁切(用户报告的「全家福动态
 * 发布第一次启动就 4 连图」)。串行闸保证任意时刻只有一个渲染在跑,彻底消除竞态。
 */

import { describe, expect, it } from "vite-plus/test";
import { createSerialGate } from "../serial-gate.js";

describe("createSerialGate", () => {
	it("第二个 acquire 必须等第一个 release 后才放行(互斥)", async () => {
		const gate = createSerialGate();
		const order: string[] = [];

		const r1 = await gate.acquire(); // 立即拿到第一把
		order.push("a-acquired");

		let secondAcquired = false;
		const second = gate.acquire().then((r2: () => void) => {
			secondAcquired = true;
			order.push("b-acquired");
			return r2;
		});

		// 第一把没释放前,第二个绝不能放行
		await Promise.resolve();
		await Promise.resolve();
		expect(secondAcquired).toBe(false);

		order.push("a-release");
		r1();
		const r2 = await second;
		expect(secondAcquired).toBe(true);
		expect(order).toEqual(["a-acquired", "a-release", "b-acquired"]);
		r2();
	});

	it("串行执行多个临界区,绝不重叠", async () => {
		const gate = createSerialGate();
		let active = 0;
		let maxActive = 0;
		const task = async () => {
			const release = await gate.acquire();
			active += 1;
			maxActive = Math.max(maxActive, active);
			await new Promise((r) => setTimeout(r, 5));
			active -= 1;
			release();
		};
		await Promise.all([task(), task(), task(), task()]);
		expect(maxActive).toBe(1); // 全程并发度恒为 1
	});

	it("某个临界区抛错也不卡死后续(release 在 finally 调用)", async () => {
		const gate = createSerialGate();
		const release = await gate.acquire();
		// 模拟调用方 try/finally:即便业务抛错,finally 里 release 仍执行
		try {
			throw new Error("boom");
		} catch {
			// swallow
		} finally {
			release();
		}
		// 后续应能立即拿到
		const r2 = await gate.acquire();
		expect(typeof r2).toBe("function");
		r2();
	});
});

/**
 * 排队深度 —— `/status` 用它回答「是不是卡住了」。
 *
 * 数的是**还在等**的,不含正在跑的那个:主人要知道的是「后面堆了多少」,一个正在跑
 * 的渲染是正常状态,不是积压。
 */
describe("createSerialGate — 排队深度", () => {
	it("闲着时是 0", () => {
		expect(createSerialGate().waiting()).toBe(0);
	});

	it("一个在跑、两个在等 → 2", async () => {
		const gate = createSerialGate();
		const r1 = await gate.acquire();
		const second = gate.acquire();
		const third = gate.acquire();
		// 让两个排队者跑到 await 处挂住
		await Promise.resolve();
		await Promise.resolve();
		expect(gate.waiting()).toBe(2);

		r1();
		(await second)();
		(await third)();
	});

	it("排空之后回落到 0", async () => {
		const gate = createSerialGate();
		const r1 = await gate.acquire();
		const second = gate.acquire();
		r1();
		(await second)();
		expect(gate.waiting()).toBe(0);
	});
});
