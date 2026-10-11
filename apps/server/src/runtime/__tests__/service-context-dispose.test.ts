/**
 * ServiceContext 的关停:分段收尾、后台活登记、`signal`、预算(data-and-migration「持久化底层与关停」)。
 *
 * 关停顺序是 `stop`(停生产者)→ `drain`(HTTP 排空)→ 等 `track()` 登记的后台活 → `flush`(写道落盘、关门)
 * → `dispose`(其余收尾)。预算用完就不再等,但剩下的钩子照样调用 —— 写道总得有机会关门,关停之后才不会
 * 再有写入落进数据目录(守卫 8)。
 */

import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { LogEntry } from "../../ws/types.js";
import { createNodeServiceContext } from "../service-context.js";

function harness() {
	const seen: LogEntry[] = [];
	const ctx = createNodeServiceContext({
		name: "svc",
		level: "debug",
		pretty: false,
		onLog: (e) => seen.push(e),
		destination: new Writable({ write: (_chunk, _enc, cb) => cb() }),
	});
	const at = (level: LogEntry["level"]) => seen.filter((e) => e.level === level).map((e) => e.msg);
	return { ctx, warns: () => at("warn"), errors: () => at("error") };
}

const forever = (): Promise<void> => new Promise(() => {});

afterEach(() => {
	vi.useRealTimers();
});

describe("createNodeServiceContext — 分段收尾", () => {
	it("按 stop → drain → flush → dispose 跑,与登记先后无关;同一段里后登记的先跑", async () => {
		const { ctx } = harness();
		const order: string[] = [];
		ctx.onDispose(() => void order.push("dispose-1"));
		ctx.onDispose(() => void order.push("flush-1"), "flush");
		ctx.onDispose(() => void order.push("stop-1"), "stop");
		ctx.onDispose(() => void order.push("drain-1"), "drain");
		ctx.onDispose(() => void order.push("stop-2"), "stop");
		ctx.onDispose(() => void order.push("dispose-2"));

		await ctx.dispose();

		expect(order).toEqual(["stop-2", "stop-1", "drain-1", "flush-1", "dispose-2", "dispose-1"]);
	});

	it("钩子抛错只记一条 error,后面的照跑", async () => {
		const { ctx, errors } = harness();
		const order: string[] = [];
		ctx.onDispose(() => void order.push("first-registered"));
		ctx.onDispose(() => {
			throw new Error("boom");
		});

		await ctx.dispose();

		expect(order).toEqual(["first-registered"]);
		expect(errors()).toHaveLength(1);
	});

	it("关停中登记的钩子:那一段还没跑到就排进去,已经跑过就当场跑", async () => {
		const { ctx } = harness();
		const order: string[] = [];
		ctx.onDispose(() => {
			ctx.onDispose(() => void order.push("late-stop"), "stop");
			ctx.onDispose(() => void order.push("late-flush"), "flush");
		}, "drain");
		ctx.onDispose(() => void order.push("flush"), "flush");

		await ctx.dispose();
		ctx.onDispose(() => void order.push("after-dispose"));
		await new Promise((resolve) => setImmediate(resolve));

		expect(order).toEqual(["late-stop", "late-flush", "flush", "after-dispose"]);
	});

	it("并发调 dispose 拿到的是同一次关停:第二次也等到全部收完", async () => {
		const { ctx } = harness();
		let release!: () => void;
		ctx.onDispose(() => new Promise<void>((resolve) => (release = resolve)));

		const first = ctx.dispose();
		let secondDone = false;
		const second = ctx.dispose().then(() => (secondDone = true));
		await new Promise((resolve) => setImmediate(resolve));
		expect(secondDone).toBe(false);

		release();
		await Promise.all([first, second]);
		expect(secondDone).toBe(true);
	});

	it("子系统的 ctx 与父级共用 signal、后台活登记与分段钩子", async () => {
		const { ctx } = harness();
		const sub = ctx.forSubsystem("live", "bilibili");
		const order: string[] = [];
		let release!: () => void;
		sub.track(new Promise<void>((resolve) => (release = resolve)).then(() => order.push("task")));
		sub.onDispose(() => {
			order.push("stop");
			setTimeout(release, 20);
		}, "stop");
		ctx.onDispose(() => void order.push("flush"), "flush");

		expect(sub.signal).toBe(ctx.signal);
		await ctx.dispose();
		expect(order).toEqual(["stop", "task", "flush"]);
	});
});

describe("createNodeServiceContext — signal", () => {
	it("关停之前不中止;stop 段的钩子跑的时候已经中止", async () => {
		const { ctx } = harness();
		let abortedDuringStop: boolean | undefined;
		ctx.onDispose(() => {
			abortedDuringStop = ctx.signal.aborted;
		}, "stop");

		expect(ctx.signal.aborted).toBe(false);
		await ctx.dispose();
		expect(abortedDuringStop).toBe(true);
	});
});

describe("createNodeServiceContext — track", () => {
	it("登记的后台活在 drain 之后、flush 之前等齐,活里接着登记的也等", async () => {
		const { ctx } = harness();
		const order: string[] = [];
		let release!: () => void;
		ctx.track(
			new Promise<void>((resolve) => (release = resolve)).then(() => {
				order.push("task");
				ctx.track(Promise.resolve().then(() => order.push("follow-up")));
			}),
		);
		// 隔一个宏任务再放行:只隔几个微任务的话，不等它也会恰好赶在 flush 前面落定。
		ctx.onDispose(() => {
			order.push("drain");
			setTimeout(release, 20);
		}, "drain");
		ctx.onDispose(() => void order.push("flush"), "flush");

		await ctx.dispose();

		expect(order).toEqual(["drain", "task", "follow-up", "flush"]);
	});

	it("后台活失败了不挡关停", async () => {
		const { ctx } = harness();
		const order: string[] = [];
		ctx.track(Promise.reject(new Error("write failed")));
		ctx.onDispose(() => void order.push("flush"), "flush");

		await ctx.dispose();

		expect(order).toEqual(["flush"]);
	});
});

describe("createNodeServiceContext — 预算", () => {
	it("前面有钩子挂住时,只等到给 flush 留的余量为止", async () => {
		vi.useFakeTimers();
		const { ctx, warns } = harness();
		const order: string[] = [];
		ctx.onDispose(forever, "stop");
		ctx.onDispose(() => void order.push("flush"), "flush");
		ctx.onDispose(() => void order.push("dispose"));

		const done = ctx.dispose({ timeoutMs: 8_000, flushReserveMs: 2_000 });
		await vi.advanceTimersByTimeAsync(5_999);
		expect(order).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		await done;

		expect(order).toEqual(["flush", "dispose"]);
		expect(warns().some((msg) => msg.includes("stop"))).toBe(true);
	});

	it("后台活超出 flush 之前的预算就不再等", async () => {
		vi.useFakeTimers();
		const { ctx } = harness();
		const order: string[] = [];
		ctx.track(forever());
		ctx.onDispose(() => void order.push("flush"), "flush");

		const done = ctx.dispose({ timeoutMs: 8_000, flushReserveMs: 2_000 });
		await vi.advanceTimersByTimeAsync(5_999);
		expect(order).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		await done;

		expect(order).toEqual(["flush"]);
	});

	it("总预算用完以后,剩下的钩子照样调用、只是不再等", async () => {
		vi.useFakeTimers();
		const { ctx } = harness();
		const order: string[] = [];
		ctx.onDispose(forever, "flush");
		ctx.onDispose(() => void order.push("dispose-a"));
		ctx.onDispose(() => void order.push("dispose-b"));
		ctx.onDispose(forever);

		const done = ctx.dispose({ timeoutMs: 1_000 });
		await vi.advanceTimersByTimeAsync(1_000);
		await done;

		expect(order).toEqual(["dispose-b", "dispose-a"]);
	});
});

describe("createNodeServiceContext — 定时器", () => {
	it("关停开始时挂着的定时器,在 stop 段之前就清掉", async () => {
		vi.useFakeTimers();
		const { ctx } = harness();
		const fired: string[] = [];
		ctx.setInterval(() => fired.push("interval"), 10);
		ctx.onDispose(async () => {
			await vi.advanceTimersByTimeAsync(100);
		}, "stop");

		await ctx.dispose();

		expect(fired).toEqual([]);
	});

	it("关停中开的定时器在关停结束时清掉;关停之后开的一次也不跑", async () => {
		vi.useFakeTimers();
		const { ctx } = harness();
		const fired: string[] = [];
		ctx.onDispose(() => {
			ctx.setTimeout(() => fired.push("during"), 10_000);
		}, "stop");

		await ctx.dispose();
		ctx.setTimeout(() => fired.push("after-timeout"), 1);
		ctx.setInterval(() => fired.push("after-interval"), 1);
		await vi.advanceTimersByTimeAsync(20_000);

		expect(fired).toEqual([]);
	});
});
