import { describe, expect, it } from "vite-plus/test";
import { createSerialQueue, SerialQueueClosedError } from "../serial-queue";

/**
 * 写道:按键串行的任务队列,能等排空(flush)、能关门(close)。持久化各存储都挂在它上面,
 * 关停时「flush 然后关门」保证关停返回之后不再有写入落盘。
 */

/** 手动放行的任务:记下开始 / 结束,`release()` 之前一直挂着。 */
function gate() {
	let release!: () => void;
	const done = new Promise<void>((r) => {
		release = r;
	});
	return { done, release };
}

describe("createSerialQueue", () => {
	it("同一个键:后一个任务等前一个做完才开始", async () => {
		const q = createSerialQueue();
		const log: string[] = [];
		const first = gate();
		const a = q.run("k", async () => {
			log.push("a start");
			await first.done;
			log.push("a end");
		});
		const b = q.run("k", async () => {
			log.push("b start");
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(log).toEqual(["a start"]);
		first.release();
		await Promise.all([a, b]);
		expect(log).toEqual(["a start", "a end", "b start"]);
	});

	it("前一个失败不挡后一个;run 把任务自己的错误原样还回来", async () => {
		const q = createSerialQueue();
		const boom = new Error("boom");
		const a = q.run("k", () => {
			throw boom;
		});
		const b = q.run("k", async () => "b");
		await expect(a).rejects.toBe(boom);
		await expect(b).resolves.toBe("b");
	});

	it("不同键互不等待", async () => {
		const q = createSerialQueue();
		const held = gate();
		const log: string[] = [];
		const a = q.run("a", async () => {
			await held.done;
			log.push("a");
		});
		await q.run("b", () => log.push("b"));
		expect(log).toEqual(["b"]);
		held.release();
		await a;
	});

	it("flush:等到交进来的任务全部落定,等待期间新交进来的也算", async () => {
		const q = createSerialQueue();
		const log: string[] = [];
		const held = gate();
		void q.run("a", async () => {
			await held.done;
			log.push("a");
			void q.run("b", () => log.push("b(晚到)"));
		});
		q.run("c", () => {
			throw new Error("失败也算落定");
		}).catch(() => {});
		const flushed = q.flush().then(() => log.push("flushed"));
		await Promise.resolve();
		expect(log).toEqual([]);
		held.release();
		await flushed;
		expect(log).toEqual(["a", "b(晚到)", "flushed"]);
	});

	it("close:等进行中的做完才返回;关门后交进来的直接拒绝,任务一次都不跑", async () => {
		const q = createSerialQueue();
		const held = gate();
		const log: string[] = [];
		void q.run("k", async () => {
			await held.done;
			log.push("in-flight");
		});
		const closed = q.close().then(() => log.push("closed"));
		const late = q.run("k", () => log.push("late"));
		await expect(late).rejects.toBeInstanceOf(SerialQueueClosedError);
		await expect(late).rejects.toMatchObject({ code: "queue_closed" });
		expect(log).toEqual([]);
		held.release();
		await closed;
		expect(log).toEqual(["in-flight", "closed"]);
		await expect(q.run("other", () => log.push("after"))).rejects.toBeInstanceOf(
			SerialQueueClosedError,
		);
		expect(log).toEqual(["in-flight", "closed"]);
	});
});
