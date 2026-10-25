/**
 * 端到端:独立端 `MasterNotifier` 把 bus `pipeline-error` 翻译成主人私聊
 * (`push.notifyMaster`),并按 per-source 60s 节流合并。登录失效不在这里说(由问题通知器说),
 * 它只监听推送链路错误。
 */

import type { Logger } from "@bilibili-notify/internal";
import type { PushRouter } from "@bilibili-notify/push";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { deferred, makeTrackingContext, stillPending } from "../../__tests__/support/track-context";
import { MasterNotifier } from "../master-notifier";
import { createNodeMessageBus } from "../message-bus";

/** 这一页的用例不看关停登记,只要它有 `track` 可调(登记进 track 的那组见文件末尾)。 */
const serviceCtx = { track: () => {} };

function makeSilentLogger() {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	} as unknown as Logger & { warn: ReturnType<typeof vi.fn> };
}

function makePush() {
	return {
		notifyMaster: vi.fn().mockResolvedValue({ ok: true, latencyMs: 1 }),
	} as unknown as PushRouter & { notifyMaster: ReturnType<typeof vi.fn> };
}

describe("MasterNotifier — pipeline-error → 私聊", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("pipeline-error → push.notifyMaster + logger.warn(双通道)", async () => {
		const bus = createNodeMessageBus();
		const push = makePush();
		const logger = makeSilentLogger();
		new MasterNotifier({ bus, push, logger, serviceCtx }).install();

		bus.emit("pipeline-error", { source: "dynamic", message: "服务出错" });
		await vi.runAllTimersAsync();

		expect(push.notifyMaster).toHaveBeenCalledTimes(1);
		expect(push.notifyMaster).toHaveBeenCalledWith("[dynamic] 服务出错");
		// 不变量:pipeline-error 必须同时落 warn 日志,主人 push 未配置时日志是唯一通道。
		expect(logger.warn).toHaveBeenCalledWith("[dynamic] 服务出错");
	});

	it("同 source 60s 内重复触发 → DM 仅放行第一条;窗口外重新放行;warn 日志不被节流", async () => {
		const bus = createNodeMessageBus();
		const push = makePush();
		const logger = makeSilentLogger();
		new MasterNotifier({ bus, push, logger, serviceCtx }).install();

		bus.emit("pipeline-error", { source: "dynamic", message: "first" });
		await vi.runAllTimersAsync();
		vi.advanceTimersByTime(30_000);
		bus.emit("pipeline-error", { source: "dynamic", message: "second" });
		await vi.runAllTimersAsync();
		expect(push.notifyMaster).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(31_000); // 累计 >60s
		bus.emit("pipeline-error", { source: "dynamic", message: "third" });
		await vi.runAllTimersAsync();
		expect(push.notifyMaster).toHaveBeenCalledTimes(2);
		expect(push.notifyMaster).toHaveBeenLastCalledWith("[dynamic] third");

		// 不变量:三条 pipeline-error 全部落 warn 日志(日志通道不被节流影响)。
		expect(logger.warn).toHaveBeenCalledTimes(3);
	});

	it("不同 source 各自独立节流", async () => {
		const bus = createNodeMessageBus();
		const push = makePush();
		new MasterNotifier({ bus, push, logger: makeSilentLogger(), serviceCtx }).install();

		bus.emit("pipeline-error", { source: "dynamic", message: "d-err" });
		bus.emit("pipeline-error", { source: "live", message: "l-err" });
		bus.emit("pipeline-error", { source: "image", message: "i-err" });
		await vi.runAllTimersAsync();

		expect(push.notifyMaster).toHaveBeenCalledTimes(3);
		const calls = push.notifyMaster.mock.calls.map((c) => c[0] as string);
		expect(calls).toContain("[dynamic] d-err");
		expect(calls).toContain("[live] l-err");
		expect(calls).toContain("[image] i-err");
	});

	it("dispose 后 bus 事件不再触发私聊", async () => {
		const bus = createNodeMessageBus();
		const push = makePush();
		const notifier = new MasterNotifier({ bus, push, logger: makeSilentLogger(), serviceCtx });
		notifier.install();

		bus.emit("pipeline-error", { source: "dynamic", message: "before-dispose" });
		await vi.runAllTimersAsync();
		expect(push.notifyMaster).toHaveBeenCalledTimes(1);

		notifier.dispose();
		vi.advanceTimersByTime(60_001); // 清节流避免与 dispose 行为混淆
		bus.emit("pipeline-error", { source: "dynamic", message: "after-dispose" });
		await vi.runAllTimersAsync();

		expect(push.notifyMaster).toHaveBeenCalledTimes(1); // 未涨
	});

	it("notifyMaster 回了失败结果 → 走 logger.warn 带原因,不向外传播", async () => {
		const bus = createNodeMessageBus();
		const push = makePush();
		push.notifyMaster.mockResolvedValueOnce({
			ok: false,
			code: "not_configured",
			message: "没有配置主人目标",
		});
		const logger = makeSilentLogger();
		new MasterNotifier({ bus, push, logger, serviceCtx }).install();

		bus.emit("pipeline-error", { source: "dynamic", message: "出错了" });
		await vi.runAllTimersAsync();

		// 一条是 pipeline-error 自己落的 warn,一条是私信没送到
		const warns = (logger.warn as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
			String(c[0]),
		);
		expect(warns).toHaveLength(2);
		const failed = warns.find((w) => w.includes("私信没送到"));
		expect(failed).toMatch(/source=dynamic/);
		expect(failed).toMatch(/没有配置主人目标/);
	});

	it("push.notifyMaster 抛出 → 走 logger.warn,不向外传播", async () => {
		const bus = createNodeMessageBus();
		const push = makePush();
		push.notifyMaster.mockRejectedValueOnce(new Error("net down"));
		const logger = makeSilentLogger();
		new MasterNotifier({ bus, push, logger, serviceCtx }).install();

		bus.emit("pipeline-error", { source: "dynamic", message: "出错了" });
		await vi.runAllTimersAsync();

		const warnMock = logger.warn as unknown as ReturnType<typeof vi.fn>;
		const warns = warnMock.mock.calls.map((c) => String(c[0]));
		expect(warns).toHaveLength(2);
		const failed = warns.find((w) => w.includes("私信失败"));
		expect(failed).toMatch(/source=dynamic/);
		expect(failed).toMatch(/net down/);
	});
});

/**
 * 关停(切片 ③)。私聊是发出去不等的后台活;登记进 `ctx.track()` 之后,关停等它发完 ——
 * 发送经 dispatcher 回调的目标可达性写回,得赶在各写道关门之前交进去。
 */
describe("MasterNotifier — 登记进 track", () => {
	it("pipeline-error → 私聊发完它才落定", async () => {
		const bus = createNodeMessageBus();
		const send = deferred<{ ok: true; latencyMs: number }>();
		const push = makePush();
		push.notifyMaster.mockReturnValue(send.promise);
		const ctx = makeTrackingContext();
		new MasterNotifier({ bus, push, logger: makeSilentLogger(), serviceCtx: ctx }).install();

		bus.emit("pipeline-error", { source: "dynamic", message: "出错了" });

		expect(ctx.tracked).toHaveLength(1);
		expect(push.notifyMaster).toHaveBeenCalledTimes(1);
		expect(await stillPending(ctx.settled())).toBe(true);
		send.resolve({ ok: true, latencyMs: 1 });
		await ctx.settled();
	});

	it("pipeline-error → 同样登记;被节流吞掉的那次也是一件(很快落定的)事", async () => {
		const bus = createNodeMessageBus();
		const send = deferred<{ ok: true; latencyMs: number }>();
		const push = makePush();
		push.notifyMaster.mockReturnValue(send.promise);
		const ctx = makeTrackingContext();
		new MasterNotifier({ bus, push, logger: makeSilentLogger(), serviceCtx: ctx }).install();

		bus.emit("pipeline-error", { source: "dynamic", message: "first" });
		bus.emit("pipeline-error", { source: "dynamic", message: "second" }); // 60s 内同 source:吞掉

		expect(ctx.tracked).toHaveLength(2);
		expect(push.notifyMaster).toHaveBeenCalledTimes(1);
		const [first, throttled] = ctx.tracked as [Promise<unknown>, Promise<unknown>];
		expect(await stillPending(first)).toBe(true);
		expect(await stillPending(throttled)).toBe(false);
		send.resolve({ ok: true, latencyMs: 1 });
		await first;
	});

	it("私聊发不出去:登记进去的这件事不拒,记一条 warn", async () => {
		const bus = createNodeMessageBus();
		const push = makePush();
		push.notifyMaster.mockRejectedValue(new Error("master unreachable"));
		const logger = makeSilentLogger();
		const ctx = makeTrackingContext();
		new MasterNotifier({ bus, push, logger, serviceCtx: ctx }).install();

		bus.emit("pipeline-error", { source: "dynamic", message: "出错了" });

		await expect(ctx.tracked[0]).resolves.toBeUndefined();
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("master unreachable"));
	});
});
