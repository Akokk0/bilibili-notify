import { describe, expect, it, vi } from "vite-plus/test";
import { resolveExpectedParent, startParentWatch } from "../parent-watch.js";

/**
 * 桌面版的 sidecar 是 launcher 起的子进程,但**父进程被强杀时它不会跟着死** ——
 * 会被 launchd 收养(ppid 变 1)继续跑。2026-08-31 实地踩到:一个孤儿 sidecar
 * 活了三个小时,占着数据目录,还害得后续启动全挂。
 *
 * 所以 sidecar 自己得盯着:父进程还是不是原来那个,不是了就自杀。
 */

const tick = () => {
	const calls: Array<() => void> = [];
	return {
		schedule: (fn: () => void) => calls.push(fn),
		run: (times = 1) => {
			for (let i = 0; i < times; i++) for (const fn of calls) fn();
		},
	};
};

describe("resolveExpectedParent", () => {
	it("正常 pid → 取出来", () => {
		expect(resolveExpectedParent("12345")).toBe(12345);
	});

	// 没传 = 不是桌面版起的(Docker / 直接跑),这套机制整个不该开。
	it("没传 / 空 → null(关掉,别自作主张盯着谁)", () => {
		expect(resolveExpectedParent(undefined)).toBeNull();
		expect(resolveExpectedParent("")).toBeNull();
	});

	it("看不懂的值 → null,不猜", () => {
		for (const raw of ["abc", "12.5", "-5", "NaN", "1e999"]) {
			expect(resolveExpectedParent(raw)).toBeNull();
		}
	});

	// ppid=1 意味着「一出生就已经是孤儿」,盯着它永远不会触发,是个假守卫。
	it("0 / 1 → null(这俩当父进程没有意义)", () => {
		expect(resolveExpectedParent("0")).toBeNull();
		expect(resolveExpectedParent("1")).toBeNull();
	});
});

describe("startParentWatch", () => {
	it("父进程没变 → 什么都不做", () => {
		const t = tick();
		const onOrphaned = vi.fn();
		startParentWatch({ expectedParent: 42, getPpid: () => 42, onOrphaned, schedule: t.schedule });
		t.run(5);
		expect(onOrphaned).not.toHaveBeenCalled();
	});

	it("被 launchd 收养(ppid→1) → 自杀", () => {
		const t = tick();
		const onOrphaned = vi.fn();
		startParentWatch({ expectedParent: 42, getPpid: () => 1, onOrphaned, schedule: t.schedule });
		t.run();
		expect(onOrphaned).toHaveBeenCalledTimes(1);
	});

	// 不是所有系统都收养给 1(可能是 subreaper),所以判据是「变了」不是「等于 1」。
	it("被别的 subreaper 收养 → 一样自杀", () => {
		const t = tick();
		const onOrphaned = vi.fn();
		startParentWatch({ expectedParent: 42, getPpid: () => 999, onOrphaned, schedule: t.schedule });
		t.run();
		expect(onOrphaned).toHaveBeenCalledTimes(1);
	});

	// 关停要走完整流程,期间定时器还在跑;重复触发会把关停打断成一团乱。
	it("只触发一次,后续 tick 不再重复喊", () => {
		const t = tick();
		const onOrphaned = vi.fn();
		startParentWatch({ expectedParent: 42, getPpid: () => 1, onOrphaned, schedule: t.schedule });
		t.run(4);
		expect(onOrphaned).toHaveBeenCalledTimes(1);
	});

	// getPpid 在某些平台可能抛;守卫抛异常把整个进程带走,比它想防的问题更糟。
	it("getPpid 抛了 → 当作没事发生,不误杀", () => {
		const t = tick();
		const onOrphaned = vi.fn();
		startParentWatch({
			expectedParent: 42,
			getPpid: () => {
				throw new Error("boom");
			},
			onOrphaned,
			schedule: t.schedule,
		});
		expect(() => t.run(3)).not.toThrow();
		expect(onOrphaned).not.toHaveBeenCalled();
	});
});
