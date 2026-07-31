import { describe, expect, it } from "vite-plus/test";
import { createSerialQueue } from "../preview-queue";

/** 一个手动控制何时 settle 的任务,用来观察「第二个有没有抢跑」。 */
function deferred<T = void>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("卡片预览的串行队列", () => {
	it("前一个没结束,后一个绝不开跑", async () => {
		const enqueue = createSerialQueue();
		const first = deferred();
		const started: string[] = [];

		const a = enqueue(async () => {
			started.push("a");
			await first.promise;
		});
		const b = enqueue(async () => {
			started.push("b");
		});

		// 让微任务跑干净:此时 a 已在跑,b 必须还没被调用。
		await Promise.resolve();
		await Promise.resolve();
		expect(started).toEqual(["a"]);

		first.resolve();
		await Promise.all([a, b]);
		expect(started).toEqual(["a", "b"]);
	});

	it("按入队顺序跑(FIFO)—— 全家福四张卡的出图顺序才和格子顺序对得上", async () => {
		const enqueue = createSerialQueue();
		const done: number[] = [];
		await Promise.all(
			[0, 1, 2, 3].map((i) =>
				enqueue(async () => {
					done.push(i);
				}),
			),
		);
		expect(done).toEqual([0, 1, 2, 3]);
	});

	it("拿得到每个任务自己的返回值", async () => {
		const enqueue = createSerialQueue();
		const values = await Promise.all([enqueue(async () => "x"), enqueue(async () => 42)]);
		expect(values).toEqual(["x", 42]);
	});

	/**
	 * 队列最要命的失败模式:一个任务抛了,把整条队伍锁死 —— 一张卡渲染失败,后面三张
	 * 永远转圈,而且没有任何错误可看。所以失败只能落到它自己的调用方头上。
	 */
	it("一个任务失败不拖累后面的,错误也只抛给它自己", async () => {
		const enqueue = createSerialQueue();
		const failing = enqueue(async () => {
			throw new Error("渲染炸了");
		});
		const after = enqueue(async () => "我还活着");

		await expect(failing).rejects.toThrow("渲染炸了");
		await expect(after).resolves.toBe("我还活着");
	});

	it("同步抛出的任务同样不锁死队列", async () => {
		const enqueue = createSerialQueue();
		const boom = enqueue(() => {
			throw new Error("同步炸");
		});
		const after = enqueue(async () => "ok");

		await expect(boom).rejects.toThrow("同步炸");
		await expect(after).resolves.toBe("ok");
	});
});
