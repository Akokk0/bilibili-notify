/**
 * 单元测试 — `retry`(指数退避通用重试,packages/api 韧性地基)。
 *
 * 守护契约:
 *   - 首次成功 → 不重试
 *   - 失败到 attempts 上限 → 抛最后一次错误,fn 调用 attempts 次
 *   - shouldRetry=false → 立即停止并抛出该错误
 *   - onRetry 收到 (err, attempt, delay);delay = min(base*factor^(i-1), maxDelay)
 *   - attempts=1 → 不重试
 *   - 已 abort 的 signal → 循环顶 throwIfAborted,fn 永不执行
 *   - sleep 期间 signal 已 abort → reject(signal.reason) 直接外抛
 *
 * 用极小 baseDelayMs(0/1)保持真实定时器下的测试速度。
 */

import { describe, expect, it, vi } from "vite-plus/test";
import { retry } from "./retry";

describe("retry — 成功路径", () => {
	it("首次成功不重试", async () => {
		const fn = vi.fn(async () => 42);
		await expect(retry(fn)).resolves.toBe(42);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("失败一次后成功:fn 两次,onRetry 一次", async () => {
		const fn = vi
			.fn<(a: number) => Promise<string>>()
			.mockRejectedValueOnce(new Error("transient"))
			.mockResolvedValueOnce("ok");
		const onRetry = vi.fn();
		await expect(retry(fn, { baseDelayMs: 0, onRetry })).resolves.toBe("ok");
		expect(fn).toHaveBeenCalledTimes(2);
		expect(onRetry).toHaveBeenCalledTimes(1);
		expect(onRetry.mock.calls[0][1]).toBe(1); // attempt
	});

	it("fn 收到当前 attempt 序号(1-based)", async () => {
		const seen: number[] = [];
		const fn = vi.fn(async (a: number) => {
			seen.push(a);
			if (a < 3) throw new Error("retry");
			return "done";
		});
		await expect(retry(fn, { baseDelayMs: 0 })).resolves.toBe("done");
		expect(seen).toEqual([1, 2, 3]);
	});
});

describe("retry — 失败路径", () => {
	it("失败到默认 attempts(3) 抛最后错误", async () => {
		const fn = vi
			.fn<(a: number) => Promise<never>>()
			.mockRejectedValueOnce(new Error("e1"))
			.mockRejectedValueOnce(new Error("e2"))
			.mockRejectedValueOnce(new Error("e3-last"));
		await expect(retry(fn, { baseDelayMs: 0 })).rejects.toThrow("e3-last");
		expect(fn).toHaveBeenCalledTimes(3);
	});

	it("attempts=1:不重试,单次失败即抛", async () => {
		const fn = vi.fn(async () => {
			throw new Error("once");
		});
		const onRetry = vi.fn();
		await expect(retry(fn, { attempts: 1, onRetry })).rejects.toThrow("once");
		expect(fn).toHaveBeenCalledTimes(1);
		expect(onRetry).not.toHaveBeenCalled();
	});

	it("shouldRetry=false:立即停止,fn 仅一次", async () => {
		const fn = vi.fn(async () => {
			throw new Error("fatal");
		});
		const shouldRetry = vi.fn(() => false);
		await expect(retry(fn, { baseDelayMs: 0, shouldRetry })).rejects.toThrow("fatal");
		expect(fn).toHaveBeenCalledTimes(1);
		expect(shouldRetry).toHaveBeenCalledTimes(1);
	});
});

describe("retry — 退避计算", () => {
	it("delay = min(base*factor^(i-1), maxDelay)", async () => {
		const fn = vi.fn(async () => {
			throw new Error("x");
		});
		const onRetry = vi.fn();
		await expect(
			retry(fn, { attempts: 4, baseDelayMs: 1, factor: 2, maxDelayMs: 3, onRetry }),
		).rejects.toThrow("x");
		// i=1 → min(1,3)=1;i=2 → min(2,3)=2;i=3 → min(4,3)=3(被 maxDelay 钳制)
		const delays = onRetry.mock.calls.map((c) => c[2]);
		expect(delays).toEqual([1, 2, 3]);
	});
});

describe("retry — AbortSignal", () => {
	it("已 abort 的 signal:循环顶抛出,fn 永不执行", async () => {
		const ctrl = new AbortController();
		ctrl.abort();
		const fn = vi.fn(async () => "never");
		await expect(retry(fn, { signal: ctrl.signal })).rejects.toBeDefined();
		expect(fn).not.toHaveBeenCalled();
	});

	it("sleep 期间 signal 已 abort:reject(signal.reason) 直接外抛", async () => {
		const ctrl = new AbortController();
		const reason = new Error("aborted-mid-flight");
		// fn 第一次执行时把自身 abort 掉再抛错 → 进入 sleep 时 signal 已 aborted,
		// sleep 立即 reject(signal.reason),该 rejection 不被 catch,直接外抛。
		const fn = vi.fn(async () => {
			ctrl.abort(reason);
			throw new Error("transient");
		});
		await expect(retry(fn, { attempts: 3, baseDelayMs: 1000, signal: ctrl.signal })).rejects.toBe(
			reason,
		);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	// 回归守护 — P2:选项范围归一 + 末次失败后 abort 优先。
	describe("选项防呆 / 末次 abort (P2)", () => {
		it("attempts<=0 归一为 1:跑一次,失败抛真实错误(不再 throw undefined)", async () => {
			const err = new Error("boom");
			const fn = vi.fn(async () => {
				throw err;
			});
			await expect(retry(fn, { attempts: 0 })).rejects.toBe(err);
			expect(fn).toHaveBeenCalledTimes(1);
		});

		it("末次尝试失败但其间已 abort → 抛 abort 原因而非 fn 错误", async () => {
			const ctrl = new AbortController();
			const reason = new Error("aborted-last");
			const fn = vi.fn(async () => {
				ctrl.abort(reason);
				throw new Error("transient-last");
			});
			await expect(retry(fn, { attempts: 1, signal: ctrl.signal })).rejects.toBe(reason);
			expect(fn).toHaveBeenCalledTimes(1);
		});
	});
});
