/**
 * 单元测试 — 串行闸(`createSerialGate`)。
 *
 * 它防的是「秒级断流重开时,开播卡与上一场还在途的下播卡并发,谁快谁先到」:送达次序
 * 必须 = 发起次序。B 站直播每个房间一个(`RoomSessionBase.enqueuePush`),拓展直播按
 * 订阅各开一个(ADR-0019 决策 67)。
 */

import { describe, expect, it } from "vite-plus/test";
import { createSerialGate } from "../serial-gate";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createSerialGate", () => {
	it("前一个在途时发起的后一个,等前一个完成才开始(先慢后快也不抢跑)", async () => {
		const gate = createSerialGate();
		const events: string[] = [];
		const a = gate.run(async () => {
			events.push("a:begin");
			await sleep(30);
			events.push("a:done");
		});
		const b = gate.run(async () => {
			events.push("b:begin");
			await sleep(1);
			events.push("b:done");
		});
		await Promise.all([a, b]);
		expect(events).toEqual(["a:begin", "a:done", "b:begin", "b:done"]);
	});

	it("run 原样交回 fn 的结果", async () => {
		const gate = createSerialGate();
		await expect(gate.run(async () => 42)).resolves.toBe(42);
	});

	it("前一个失败不挡后一个;失败原样抛回它自己的发起方", async () => {
		const gate = createSerialGate();
		const boom = new Error("boom");
		const order: string[] = [];
		const p1 = gate
			.run(async () => {
				throw boom;
			})
			.then(
				() => order.push("p1:resolved"),
				(e: unknown) => order.push(e === boom ? "p1:rejected(boom)" : "p1:rejected(other)"),
			);
		const p2 = gate
			.run(async () => {
				order.push("p2:ran");
				return "ok";
			})
			.then((v) => order.push(`p2:resolved(${v})`));
		await Promise.all([p1, p2]);
		expect(order).toEqual(["p1:rejected(boom)", "p2:ran", "p2:resolved(ok)"]);
	});

	it("fn 同步抛错也只变成这一个的 reject,不断链", async () => {
		const gate = createSerialGate();
		const p1 = gate.run(() => {
			throw new Error("sync boom");
		});
		const p2 = gate.run(async () => "after");
		await expect(p1).rejects.toThrow("sync boom");
		await expect(p2).resolves.toBe("after");
	});

	it("一口气发起多个(越早的越慢):按发起次序逐个跑,任一时刻只有一个在跑", async () => {
		const gate = createSerialGate();
		const started: number[] = [];
		let running = 0;
		let maxRunning = 0;
		const all = [0, 1, 2, 3, 4].map((i) =>
			gate.run(async () => {
				started.push(i);
				running++;
				maxRunning = Math.max(maxRunning, running);
				await sleep(10 - i * 2);
				running--;
				return i;
			}),
		);
		await expect(Promise.all(all)).resolves.toEqual([0, 1, 2, 3, 4]);
		expect(started).toEqual([0, 1, 2, 3, 4]);
		expect(maxRunning).toBe(1);
	});

	it("两个闸互不相干:一个闸里卡着慢的,另一个闸照常跑", async () => {
		const slow = createSerialGate();
		const other = createSerialGate();
		const events: string[] = [];
		const a = slow.run(async () => {
			await sleep(30);
			events.push("slow:done");
		});
		const b = other.run(async () => {
			events.push("other:done");
		});
		await Promise.all([a, b]);
		expect(events).toEqual(["other:done", "slow:done"]);
	});
});
