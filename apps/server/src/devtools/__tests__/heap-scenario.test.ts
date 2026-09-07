import { describe, expect, it, vi } from "vite-plus/test";
import { type HeapInjector, heapInjector, injectedMemoryUsage } from "../heap-injection.js";
import { heapPressureScenario } from "../scenarios/heap.js";

/**
 * 「堆逼近上限」场景 —— 概览页那个环在 85% 转橙、95% 转红,服务端同时出一条 warn。
 *
 * 真把堆吃到 92% 才看得到这一档,而那要么等几个小时的泄漏、要么写个撑爆内存的脚本;
 * 造一个读数就能当场看到环变色、sparkline 抬头、日志出 warn 三件事一起发生。
 *
 * 注入的是**读数**,不是显示值:下游的推帧、缓冲、warn 判定全照真的跑一遍 —— 那正是
 * 要验的东西。收摊只由 devtools 这一个口。
 */

function injector(): HeapInjector & { injected: () => number | null } {
	let fake: number | null = null;
	return {
		inject: (ratio) => {
			fake = ratio;
		},
		clear: () => {
			fake = null;
		},
		injected: () => fake,
	};
}

describe("heapPressureScenario", () => {
	it("跑一次就把堆占比按参数注进去", async () => {
		const inj = injector();
		const s = heapPressureScenario({ heap: inj });
		await s.run({ ratio: 92 });
		expect(inj.injected()).toBeCloseTo(0.92, 5);
	});

	it("默认就是 92% —— 想看的是橙那一档,不是随手一个数", async () => {
		const inj = injector();
		const s = heapPressureScenario({ heap: inj });
		const field = s.params.find((p) => p.key === "ratio");
		expect(field?.kind).toBe("number");
		await s.run({});
		expect(inj.injected()).toBeCloseTo(0.92, 5);
	});

	it("「当前生效」条上认得出它,说清注了多少", async () => {
		const inj = injector();
		const s = heapPressureScenario({ heap: inj });
		expect(s.active?.()).toBeNull();
		await s.run({ ratio: 96 });
		expect(s.active?.()?.label).toContain("96");
	});

	it("收摊回真读数", async () => {
		const inj = injector();
		const s = heapPressureScenario({ heap: inj });
		await s.run({ ratio: 92 });
		await s.reset?.();
		expect(inj.injected()).toBeNull();
		expect(s.active?.()).toBeNull();
	});
});

describe("采样器的堆注入口", () => {
	it("注进去的是读数:占比、warn、sparkline 全照真的算一遍", () => {
		const inj = heapInjector();
		const real = () => ({
			rss: 340 * 1024 * 1024,
			heapUsed: 210 * 1024 * 1024,
			heapTotal: 250 * 1024 * 1024,
			external: 12 * 1024 * 1024,
		});
		const read = injectedMemoryUsage(real, inj, () => 512 * 1024 * 1024);

		expect(read().heapUsed).toBe(210 * 1024 * 1024);
		inj.inject(0.92);
		// 92% × 512M —— 由采样器照常算出 92%,而不是绕过它直接显示一个数字。
		expect(read().heapUsed).toBeCloseTo(0.92 * 512 * 1024 * 1024, 0);
		// 已提交量跟着抬上去:used 比 committed 还大是不可能的状态,面板会显示得很怪。
		expect(read().heapTotal).toBeGreaterThanOrEqual(read().heapUsed);

		inj.clear();
		expect(read().heapUsed).toBe(210 * 1024 * 1024);
	});

	it("没注入时把真读数原样交出去,一个字节都不改", () => {
		const spy = vi.fn(() => ({ rss: 1, heapUsed: 2, heapTotal: 3, external: 4 }));
		const read = injectedMemoryUsage(spy, heapInjector(), () => 512);
		expect(read()).toEqual({ rss: 1, heapUsed: 2, heapTotal: 3, external: 4 });
	});
});
