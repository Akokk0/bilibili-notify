/**
 * 单元测试 — `withLock`(单槽锁:运行中重复触发丢弃,不排队)。
 *
 * 守护契约:
 *   - fn 进行中,重复触发被丢弃(fn 仅一次)
 *   - fn settle 后锁释放,可再次触发
 *   - fn reject 也释放锁(finally),并回调 onError(err)
 *   - 无 onError 时 reject 不抛同步异常、不悬挂未处理 rejection
 *   - **fn 同步抛出(返回 Promise 前)也必须释放锁**(P0-1 回归:旧实现
 *     `fn().catch().finally()` 会让同步异常绕过 finally,locked 永久 true,
 *     该锁后续所有触发静默跳过 → cron tick 全死)
 */

import { describe, expect, it, vi } from "vite-plus/test";
import { withLock } from "./with-lock";

/** 一个手控 settle 的 deferred。 */
function deferred() {
	let resolve!: () => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("withLock", () => {
	it("运行中重复触发被丢弃,fn 仅执行一次", async () => {
		const d = deferred();
		const fn = vi.fn(() => d.promise);
		const trigger = withLock(fn);
		trigger();
		trigger();
		trigger();
		expect(fn).toHaveBeenCalledTimes(1);
		d.resolve();
		await flush();
	});

	it("fn settle 后锁释放,可再次触发", async () => {
		const d1 = deferred();
		const fn = vi.fn().mockReturnValueOnce(d1.promise).mockResolvedValueOnce(undefined);
		const trigger = withLock(fn);
		trigger();
		trigger(); // 丢弃
		d1.resolve();
		await flush();
		trigger(); // 锁已释放
		await flush();
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("fn reject 也释放锁,并回调 onError(err)", async () => {
		const err = new Error("boom");
		const fn = vi
			.fn<() => Promise<void>>()
			.mockRejectedValueOnce(err)
			.mockResolvedValueOnce(undefined);
		const onError = vi.fn();
		const trigger = withLock(fn, onError);
		trigger();
		await flush();
		expect(onError).toHaveBeenCalledWith(err);
		trigger(); // reject 后锁应已释放
		await flush();
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("无 onError 时 reject 不抛同步异常、不悬挂 unhandled rejection", async () => {
		const fn = vi.fn(async () => {
			throw new Error("silent");
		});
		const trigger = withLock(fn);
		expect(() => trigger()).not.toThrow();
		await flush();
		// 锁应已释放(可再次触发)。
		trigger();
		await flush();
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("P0-1:fn 同步抛出(返回 Promise 前)也释放锁,onError 收到异常", async () => {
		const err = new Error("sync boom");
		// 第一次:同步 throw(非 async reject,而是函数体在 await 前直接抛)。
		// 第二次:正常 resolve,用于证明锁已释放、trigger 可再次生效。
		const fn = vi
			.fn<() => Promise<void>>()
			.mockImplementationOnce(() => {
				throw err;
			})
			.mockResolvedValueOnce(undefined);
		const onError = vi.fn();
		const trigger = withLock(fn, onError);

		expect(() => trigger()).not.toThrow();
		await flush();
		expect(onError).toHaveBeenCalledWith(err);

		trigger(); // 旧实现这里会因 locked 永久 true 而被丢弃
		await flush();
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("P0-1:同步抛出且无 onError 时不悬挂 unhandled rejection,锁仍释放", async () => {
		const fn = vi
			.fn<() => Promise<void>>()
			.mockImplementationOnce(() => {
				throw new Error("sync silent");
			})
			.mockResolvedValueOnce(undefined);
		const trigger = withLock(fn);
		expect(() => trigger()).not.toThrow();
		await flush();
		trigger();
		await flush();
		expect(fn).toHaveBeenCalledTimes(2);
	});
});
