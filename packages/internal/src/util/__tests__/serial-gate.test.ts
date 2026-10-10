/**
 * 单元测试 —— createSerialGate:渲染串行闸。
 *
 * 背景:puppeteer 浏览器冷启动后,多张卡片并发渲染(setContent→截图)会在刚启动的
 * 浏览器上触发 CDP 截图竞态,把同一张卡平铺成 2×2 并裁切(用户报告的「全家福动态
 * 发布第一次启动就 4 连图」)。串行闸保证任意时刻只有一个渲染在跑,彻底消除竞态。
 */

import { describe, expect, it } from "vite-plus/test";
import { createSerialGate } from "../serial-gate";

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

/**
 * 两条车道 —— 链接卡是「谁都能触发」的低价值渲染,不该排在开播 / 动态卡前面。
 *
 * 规矩只有一条:**有正常优先级在等,低优先级就不动。** 正常车道内部仍是 FIFO,
 * 低优先级车道内部也是 FIFO;低优先级可能一直等(饿着),这是刻意的 —— 它的
 * 调用方自己有上限并且会放弃,推送卡没有。
 */
describe("createSerialGate — 低优先级车道", () => {
	it("低优先级在等时来了正常请求,正常的先进", async () => {
		const gate = createSerialGate();
		const order: string[] = [];
		const r1 = await gate.acquire();

		const low = gate.acquire({ priority: "low" }).then((r) => {
			order.push("low");
			return r;
		});
		const normal = gate.acquire().then((r) => {
			order.push("normal");
			return r;
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(order).toEqual([]);

		r1();
		(await normal)();
		(await low)();
		expect(order).toEqual(["normal", "low"]);
	});

	it("正常车道排空之前低优先级一直等,哪怕它先到", async () => {
		const gate = createSerialGate();
		const order: string[] = [];
		const r1 = await gate.acquire();
		const low = gate.acquire({ priority: "low" }).then((r) => {
			order.push("low");
			return r;
		});
		const a = gate.acquire().then((r) => {
			order.push("a");
			return r;
		});
		const b = gate.acquire().then((r) => {
			order.push("b");
			return r;
		});
		r1();
		(await a)();
		// a 放行的那一刻,b 还在正常车道里等 —— 低优先级不能插进去。
		(await b)();
		(await low)();
		expect(order).toEqual(["a", "b", "low"]);
	});

	it("闲着时低优先级立刻进,不用等谁", async () => {
		const gate = createSerialGate();
		const release = await gate.acquire({ priority: "low" });
		expect(typeof release).toBe("function");
		release();
	});

	it("两条车道都算进排队深度", async () => {
		const gate = createSerialGate();
		const r1 = await gate.acquire();
		const low = gate.acquire({ priority: "low" });
		const normal = gate.acquire();
		await Promise.resolve();
		expect(gate.waiting()).toBe(2);
		r1();
		(await normal)();
		(await low)();
		expect(gate.waiting()).toBe(0);
	});
});

/*
 * `run(fn)`:经闸发起的异步活按发起次序一个接一个跑,送达次序 = 发起次序。
 *
 * 它防的是「秒级断流重开时,开播卡与上一场还在途的下播卡并发,谁快谁先到」。B 站直播每个
 * 房间一个(`RoomSessionBase.enqueuePush`),拓展作品与拓展直播按订阅各开一个(ADR-0019 决策 67)。
 * (以下用例原住 bilibili/live/session 那把同名闸的测试里,并进来时一条不少。)
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createSerialGate — run", () => {
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

	it("run 与 acquire 共用一把锁:acquire 持着时 run 不动,release 后才跑", async () => {
		const gate = createSerialGate();
		const release = await gate.acquire();
		let ran = false;
		const p = gate.run(async () => {
			ran = true;
		});
		await sleep(5);
		expect(ran).toBe(false);
		release();
		await p;
		expect(ran).toBe(true);
	});
});
