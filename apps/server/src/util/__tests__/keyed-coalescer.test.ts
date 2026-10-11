import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createKeyedCoalescer } from "../keyed-coalescer.js";

describe("createKeyedCoalescer", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("窗口里连着碰同一个键只在尾沿发一次,且不往后推", () => {
		const fired: string[] = [];
		const coalescer = createKeyedCoalescer({ windowMs: 250, onFire: (key) => fired.push(key) });
		coalescer.touch("a");
		vi.advanceTimersByTime(200);
		coalescer.touch("a");
		vi.advanceTimersByTime(49);
		expect(fired).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(fired).toEqual(["a"]);
		vi.advanceTimersByTime(1_000);
		expect(fired).toEqual(["a"]);
	});

	it("不同的键各算各的窗口", () => {
		const fired: string[] = [];
		const coalescer = createKeyedCoalescer({ windowMs: 250, onFire: (key) => fired.push(key) });
		coalescer.touch("a");
		vi.advanceTimersByTime(100);
		coalescer.touch("b");
		vi.advanceTimersByTime(150);
		expect(fired).toEqual(["a"]);
		vi.advanceTimersByTime(100);
		expect(fired).toEqual(["a", "b"]);
	});

	it("窗口过后再碰重新起算一个窗口", () => {
		const fired: string[] = [];
		const coalescer = createKeyedCoalescer({ windowMs: 250, onFire: (key) => fired.push(key) });
		coalescer.touch("a");
		vi.advanceTimersByTime(250);
		coalescer.touch("a");
		vi.advanceTimersByTime(249);
		expect(fired).toEqual(["a"]);
		vi.advanceTimersByTime(1);
		expect(fired).toEqual(["a", "a"]);
	});

	it("给了 onError 时回调抛错只交给它,不影响别的键与后续", () => {
		const fired: string[] = [];
		const errors: Array<[string, string]> = [];
		const coalescer = createKeyedCoalescer({
			windowMs: 250,
			onFire: (key) => {
				fired.push(key);
				if (key === "bad") throw new Error("boom");
			},
			onError: (key, err) => errors.push([key, (err as Error).message]),
		});
		coalescer.touch("bad");
		coalescer.touch("good");
		vi.advanceTimersByTime(250);
		expect(fired).toEqual(["bad", "good"]);
		expect(errors).toEqual([["bad", "boom"]]);
		coalescer.touch("bad");
		vi.advanceTimersByTime(250);
		expect(fired).toEqual(["bad", "good", "bad"]);
	});

	it("没给 onError 时抛错照旧往外抛,抛过的键下次照常起算", () => {
		let calls = 0;
		const coalescer = createKeyedCoalescer({
			windowMs: 250,
			onFire: () => {
				calls += 1;
				if (calls === 1) throw new Error("boom");
			},
		});
		coalescer.touch("a");
		expect(() => vi.advanceTimersByTime(250)).toThrow("boom");
		coalescer.touch("a");
		vi.advanceTimersByTime(250);
		expect(calls).toBe(2);
	});

	it("cancel 只作废这个键挂着的,之后再碰照常起算", () => {
		const fired: string[] = [];
		const coalescer = createKeyedCoalescer({ windowMs: 250, onFire: (key) => fired.push(key) });
		coalescer.touch("a");
		coalescer.touch("b");
		coalescer.cancel("a");
		vi.advanceTimersByTime(250);
		expect(fired).toEqual(["b"]);
		coalescer.touch("a");
		vi.advanceTimersByTime(250);
		expect(fired).toEqual(["b", "a"]);
	});

	it("cancelAll 作废全部挂着的,但之后再碰仍然发", () => {
		const fired: string[] = [];
		const coalescer = createKeyedCoalescer({ windowMs: 250, onFire: (key) => fired.push(key) });
		coalescer.touch("a");
		coalescer.touch("b");
		coalescer.cancelAll();
		vi.advanceTimersByTime(250);
		expect(fired).toEqual([]);
		coalescer.touch("a");
		vi.advanceTimersByTime(250);
		expect(fired).toEqual(["a"]);
	});

	it("dispose 作废挂着的,之后再碰的也不发", () => {
		const fired: string[] = [];
		const coalescer = createKeyedCoalescer({ windowMs: 250, onFire: (key) => fired.push(key) });
		coalescer.touch("a");
		coalescer.dispose();
		vi.advanceTimersByTime(250);
		expect(fired).toEqual([]);
		coalescer.touch("a");
		vi.advanceTimersByTime(250);
		expect(fired).toEqual([]);
	});

	it("给了 setTimer 就走它,作废时摘它交回的把手", () => {
		const jobs: Array<{ fn: () => void; ms: number; disposed: boolean }> = [];
		const coalescer = createKeyedCoalescer({
			windowMs: 1_000,
			onFire: () => {},
			setTimer: (fn, ms) => {
				const job = { fn, ms, disposed: false };
				jobs.push(job);
				return {
					dispose: () => {
						job.disposed = true;
					},
				};
			},
		});
		coalescer.touch("a");
		coalescer.touch("a");
		expect(jobs.map((job) => job.ms)).toEqual([1_000]);
		coalescer.dispose();
		expect(jobs[0]?.disposed).toBe(true);
	});
});
