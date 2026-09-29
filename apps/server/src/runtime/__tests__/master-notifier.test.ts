/**
 * 端到端:独立端 `MasterNotifier` 把 bus `auth-lost` / `engine-error` 翻译成主人私聊
 * (`push.sendPrivateMsg`),并按 per-source 60s 节流合并。
 *
 * 与 koishi 端 `koishi/src/runtime/__tests__/master-notifier.test.ts` 行为对称 ——
 * 同事件 → 同私聊路径 + 同节流粒度。此前 `engines.test.ts` 只覆盖了 auth-lost →
 * live.teardown 的事件级转译,从未断言私聊真的发出。
 */

import type { Logger } from "@bilibili-notify/internal";
import type { BilibiliPush } from "@bilibili-notify/push";
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
		sendPrivateMsg: vi.fn().mockResolvedValue(undefined),
	} as unknown as BilibiliPush & { sendPrivateMsg: ReturnType<typeof vi.fn> };
}

describe("MasterNotifier (standalone) — auth-lost / engine-error → 私聊", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("auth-lost → push.sendPrivateMsg('账号登录已失效，请到控制台重新扫码登录')", async () => {
		const bus = createNodeMessageBus();
		const push = makePush();
		new MasterNotifier({ bus, push, logger: makeSilentLogger(), serviceCtx }).install();

		bus.emit("auth-lost");
		await vi.runAllTimersAsync();

		expect(push.sendPrivateMsg).toHaveBeenCalledTimes(1);
		expect(push.sendPrivateMsg).toHaveBeenCalledWith("账号登录已失效，请到控制台重新扫码登录");
	});

	it("engine-error → push.sendPrivateMsg + logger.warn(双通道)", async () => {
		const bus = createNodeMessageBus();
		const push = makePush();
		const logger = makeSilentLogger();
		new MasterNotifier({ bus, push, logger, serviceCtx }).install();

		bus.emit("engine-error", "dynamic", "服务出错");
		await vi.runAllTimersAsync();

		expect(push.sendPrivateMsg).toHaveBeenCalledTimes(1);
		expect(push.sendPrivateMsg).toHaveBeenCalledWith("[dynamic] 服务出错");
		// 不变量:engine-error 必须同时落 warn 日志,主人 push 未配置时日志是唯一通道。
		expect(logger.warn).toHaveBeenCalledWith("[dynamic] 服务出错");
	});

	it("同 source 60s 内重复触发 → DM 仅放行第一条;窗口外重新放行;warn 日志不被节流", async () => {
		const bus = createNodeMessageBus();
		const push = makePush();
		const logger = makeSilentLogger();
		new MasterNotifier({ bus, push, logger, serviceCtx }).install();

		bus.emit("engine-error", "dynamic", "first");
		await vi.runAllTimersAsync();
		vi.advanceTimersByTime(30_000);
		bus.emit("engine-error", "dynamic", "second");
		await vi.runAllTimersAsync();
		expect(push.sendPrivateMsg).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(31_000); // 累计 >60s
		bus.emit("engine-error", "dynamic", "third");
		await vi.runAllTimersAsync();
		expect(push.sendPrivateMsg).toHaveBeenCalledTimes(2);
		expect(push.sendPrivateMsg).toHaveBeenLastCalledWith("[dynamic] third");

		// 不变量:三条 engine-error 全部落 warn 日志(日志通道不被节流影响)。
		expect(logger.warn).toHaveBeenCalledTimes(3);
	});

	it("不同 source 各自独立节流(auth vs 不同 engine)", async () => {
		const bus = createNodeMessageBus();
		const push = makePush();
		new MasterNotifier({ bus, push, logger: makeSilentLogger(), serviceCtx }).install();

		bus.emit("auth-lost");
		bus.emit("engine-error", "dynamic", "d-err");
		bus.emit("engine-error", "live", "l-err");
		await vi.runAllTimersAsync();

		expect(push.sendPrivateMsg).toHaveBeenCalledTimes(3);
		const calls = push.sendPrivateMsg.mock.calls.map((c) => c[0] as string);
		expect(calls).toContain("账号登录已失效，请到控制台重新扫码登录");
		expect(calls).toContain("[dynamic] d-err");
		expect(calls).toContain("[live] l-err");
	});

	it("dispose 后 bus 事件不再触发私聊", async () => {
		const bus = createNodeMessageBus();
		const push = makePush();
		const notifier = new MasterNotifier({ bus, push, logger: makeSilentLogger(), serviceCtx });
		notifier.install();

		bus.emit("auth-lost");
		await vi.runAllTimersAsync();
		expect(push.sendPrivateMsg).toHaveBeenCalledTimes(1);

		notifier.dispose();
		vi.advanceTimersByTime(60_001); // 清节流避免与 dispose 行为混淆
		bus.emit("auth-lost");
		bus.emit("engine-error", "dynamic", "after-dispose");
		await vi.runAllTimersAsync();

		expect(push.sendPrivateMsg).toHaveBeenCalledTimes(1); // 未涨
	});

	it("push.sendPrivateMsg 抛出 → 走 logger.warn,不向外传播", async () => {
		const bus = createNodeMessageBus();
		const push = makePush();
		push.sendPrivateMsg.mockRejectedValueOnce(new Error("net down"));
		const logger = makeSilentLogger();
		new MasterNotifier({ bus, push, logger, serviceCtx }).install();

		bus.emit("auth-lost");
		await vi.runAllTimersAsync();

		expect(logger.warn).toHaveBeenCalledTimes(1);
		const warnMock = logger.warn as unknown as ReturnType<typeof vi.fn>;
		const warnArg = warnMock.mock.calls[0]?.[0];
		expect(String(warnArg)).toMatch(/source=auth/);
		expect(String(warnArg)).toMatch(/net down/);
	});
});

/**
 * 关停(切片 ③)。私聊是发出去不等的后台活;登记进 `ctx.track()` 之后,关停等它发完 ——
 * 发送经 sink 回调的目标可达性写回,得赶在各写道关门之前交进去。
 */
describe("MasterNotifier — 登记进 track", () => {
	it("auth-lost → 私聊发完它才落定", async () => {
		const bus = createNodeMessageBus();
		const send = deferred();
		const push = makePush();
		push.sendPrivateMsg.mockReturnValue(send.promise);
		const ctx = makeTrackingContext();
		new MasterNotifier({ bus, push, logger: makeSilentLogger(), serviceCtx: ctx }).install();

		bus.emit("auth-lost");

		expect(ctx.tracked).toHaveLength(1);
		expect(push.sendPrivateMsg).toHaveBeenCalledTimes(1);
		expect(await stillPending(ctx.settled())).toBe(true);
		send.resolve(undefined);
		await ctx.settled();
	});

	it("engine-error → 同样登记;被节流吞掉的那次也是一件(很快落定的)事", async () => {
		const bus = createNodeMessageBus();
		const send = deferred();
		const push = makePush();
		push.sendPrivateMsg.mockReturnValue(send.promise);
		const ctx = makeTrackingContext();
		new MasterNotifier({ bus, push, logger: makeSilentLogger(), serviceCtx: ctx }).install();

		bus.emit("engine-error", "dynamic", "first");
		bus.emit("engine-error", "dynamic", "second"); // 60s 内同 source:吞掉

		expect(ctx.tracked).toHaveLength(2);
		expect(push.sendPrivateMsg).toHaveBeenCalledTimes(1);
		const [first, throttled] = ctx.tracked as [Promise<unknown>, Promise<unknown>];
		expect(await stillPending(first)).toBe(true);
		expect(await stillPending(throttled)).toBe(false);
		send.resolve(undefined);
		await first;
	});

	it("私聊发不出去:登记进去的这件事不拒,记一条 warn", async () => {
		const bus = createNodeMessageBus();
		const push = makePush();
		push.sendPrivateMsg.mockRejectedValue(new Error("master unreachable"));
		const logger = makeSilentLogger();
		const ctx = makeTrackingContext();
		new MasterNotifier({ bus, push, logger, serviceCtx: ctx }).install();

		bus.emit("auth-lost");

		await expect(ctx.tracked[0]).resolves.toBeUndefined();
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("master unreachable"));
	});
});
