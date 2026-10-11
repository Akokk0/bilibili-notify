import { describe, expect, it, vi } from "vite-plus/test";
import { stopQuietly } from "../stop-quietly.js";

describe("stopQuietly", () => {
	it("同步抛的交给 onError,不往外抛", () => {
		const onError = vi.fn();
		const err = new Error("sync");
		expect(() =>
			stopQuietly(() => {
				throw err;
			}, onError),
		).not.toThrow();
		expect(onError).toHaveBeenCalledWith(err);
	});

	it("异步拒绝的交给 onError", async () => {
		const onError = vi.fn();
		const err = new Error("async");
		stopQuietly(() => Promise.reject(err), onError);
		await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(err));
	});

	it("不等它:慢的 stop 没落定,函数已经返回", () => {
		const onError = vi.fn();
		let settled = false;
		stopQuietly(
			() =>
				new Promise<void>((resolve) =>
					setTimeout(() => {
						settled = true;
						resolve();
					}, 20),
				),
			onError,
		);
		expect(settled).toBe(false);
		expect(onError).not.toHaveBeenCalled();
	});
});
