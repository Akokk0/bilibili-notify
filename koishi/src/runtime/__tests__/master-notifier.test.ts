/**
 * 端到端:`bilibili-notify/auth-lost` 与 `bilibili-notify/engine-error` 事件触发
 * 主人私聊(`push.sendPrivateMsg`),并按 per-source 60s 节流合并。
 *
 * 配对独立端 `apps/server/src/runtime/__tests__/master-notifier.test.ts` 行为对称
 * 性回归 —— 子代理审计指出 koishi 端 MasterNotifier 此前只做 warn 日志、未消费
 * auth-lost,本测试锁住对齐后的两端一致行为(同事件 → 同私聊路径 + 同节流粒度)。
 */

import type { BilibiliPush } from "@bilibili-notify/push";
import type { Logger } from "koishi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { MasterNotifier } from "../master-notifier";

type Listener = (...args: unknown[]) => void;

function makeFakeCtx() {
	const listeners = new Map<string, Set<Listener>>();
	return {
		on(name: string, fn: Listener) {
			let set = listeners.get(name);
			if (!set) {
				set = new Set();
				listeners.set(name, set);
			}
			set.add(fn);
			return () => set?.delete(fn);
		},
		emit(name: string, ...args: unknown[]) {
			const set = listeners.get(name);
			if (!set) return;
			for (const fn of set) fn(...args);
		},
	};
}

function makeSilentLogger() {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		level: 1,
	} as unknown as Logger & { warn: ReturnType<typeof vi.fn> };
}

function makePush() {
	return {
		sendPrivateMsg: vi.fn().mockResolvedValue(undefined),
	} as unknown as BilibiliPush & { sendPrivateMsg: ReturnType<typeof vi.fn> };
}

describe("koishi MasterNotifier — auth-lost / engine-error → 私聊", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("auth-lost → push.sendPrivateMsg('账号登录已失效，请到控制台重新扫码登录')", async () => {
		const ctx = makeFakeCtx();
		const push = makePush();
		const logger = makeSilentLogger();
		new MasterNotifier({
			// biome-ignore lint/suspicious/noExplicitAny: koishi Context 测试替身
			ctx: ctx as any,
			logger,
			getPush: () => push,
		}).install();

		ctx.emit("bilibili-notify/auth-lost");
		await vi.runAllTimersAsync();

		expect(push.sendPrivateMsg).toHaveBeenCalledTimes(1);
		expect(push.sendPrivateMsg).toHaveBeenCalledWith("账号登录已失效，请到控制台重新扫码登录");
	});

	it("engine-error → push.sendPrivateMsg + logger.warn(双通道)", async () => {
		const ctx = makeFakeCtx();
		const push = makePush();
		const logger = makeSilentLogger();
		new MasterNotifier({
			// biome-ignore lint/suspicious/noExplicitAny: koishi Context 测试替身
			ctx: ctx as any,
			logger,
			getPush: () => push,
		}).install();

		ctx.emit("bilibili-notify/engine-error", "dynamic", "服务出错");
		await vi.runAllTimersAsync();

		expect(push.sendPrivateMsg).toHaveBeenCalledTimes(1);
		expect(push.sendPrivateMsg).toHaveBeenCalledWith("[dynamic] 服务出错");
		// 不变量:engine-error 必须同时落 warn 日志,主人 push 未配置时日志是唯一通道。
		expect(logger.warn).toHaveBeenCalledWith("[dynamic] 服务出错");
	});

	it("同 source 60s 内重复触发 → DM 仅放行第一条;窗口外重新放行;warn 日志不被节流", async () => {
		const ctx = makeFakeCtx();
		const push = makePush();
		const logger = makeSilentLogger();
		new MasterNotifier({
			// biome-ignore lint/suspicious/noExplicitAny: koishi Context 测试替身
			ctx: ctx as any,
			logger,
			getPush: () => push,
		}).install();

		ctx.emit("bilibili-notify/engine-error", "dynamic", "first");
		await vi.runAllTimersAsync();
		// 同 source 30s 内再 emit:DM 吞掉。
		vi.advanceTimersByTime(30_000);
		ctx.emit("bilibili-notify/engine-error", "dynamic", "second");
		await vi.runAllTimersAsync();
		expect(push.sendPrivateMsg).toHaveBeenCalledTimes(1);

		// 跨过 60s 窗口(累计 >60s):放行。
		vi.advanceTimersByTime(31_000);
		ctx.emit("bilibili-notify/engine-error", "dynamic", "third");
		await vi.runAllTimersAsync();
		expect(push.sendPrivateMsg).toHaveBeenCalledTimes(2);
		expect(push.sendPrivateMsg).toHaveBeenLastCalledWith("[dynamic] third");

		// 不变量:三条 engine-error 全部落 warn 日志(日志通道不被节流影响)。
		expect(logger.warn).toHaveBeenCalledTimes(3);
	});

	it("不同 source 各自独立节流(auth vs engine-error vs 不同 engine)", async () => {
		const ctx = makeFakeCtx();
		const push = makePush();
		new MasterNotifier({
			// biome-ignore lint/suspicious/noExplicitAny: koishi Context 测试替身
			ctx: ctx as any,
			logger: makeSilentLogger(),
			getPush: () => push,
		}).install();

		// 三条不同 source,同一瞬间 emit 全部放行。
		ctx.emit("bilibili-notify/auth-lost");
		ctx.emit("bilibili-notify/engine-error", "dynamic", "d-err");
		ctx.emit("bilibili-notify/engine-error", "live", "l-err");
		await vi.runAllTimersAsync();

		expect(push.sendPrivateMsg).toHaveBeenCalledTimes(3);
		const calls = push.sendPrivateMsg.mock.calls.map((c) => c[0] as string);
		expect(calls).toContain("账号登录已失效，请到控制台重新扫码登录");
		expect(calls).toContain("[dynamic] d-err");
		expect(calls).toContain("[live] l-err");
	});

	it("getPush() 返回 null(install 早于 bringUp 完成):不抛、不计入节流外", async () => {
		const ctx = makeFakeCtx();
		const logger = makeSilentLogger();
		let push: ReturnType<typeof makePush> | null = null;
		new MasterNotifier({
			// biome-ignore lint/suspicious/noExplicitAny: koishi Context 测试替身
			ctx: ctx as any,
			logger,
			getPush: () => push,
		}).install();

		// 早期 push 还没接好:emit 不抛。
		ctx.emit("bilibili-notify/auth-lost");
		await vi.runAllTimersAsync();
		expect(logger.warn).not.toHaveBeenCalled();

		// 节流表已写入:60s 内即便 push 上线,同 source 仍被节流吞掉。
		push = makePush();
		ctx.emit("bilibili-notify/auth-lost");
		await vi.runAllTimersAsync();
		expect(push.sendPrivateMsg).not.toHaveBeenCalled();

		// 跨 60s 后 push 已在线:放行。
		vi.advanceTimersByTime(60_001);
		ctx.emit("bilibili-notify/auth-lost");
		await vi.runAllTimersAsync();
		expect(push.sendPrivateMsg).toHaveBeenCalledTimes(1);
	});

	it("dispose 后 ctx 事件不再触发(release 函数被回收)", async () => {
		const ctx = makeFakeCtx();
		const push = makePush();
		const notifier = new MasterNotifier({
			// biome-ignore lint/suspicious/noExplicitAny: koishi Context 测试替身
			ctx: ctx as any,
			logger: makeSilentLogger(),
			getPush: () => push,
		});
		notifier.install();

		ctx.emit("bilibili-notify/auth-lost");
		await vi.runAllTimersAsync();
		expect(push.sendPrivateMsg).toHaveBeenCalledTimes(1);

		notifier.dispose();
		vi.advanceTimersByTime(60_001); // 清节流,排除与节流的干扰
		ctx.emit("bilibili-notify/auth-lost");
		ctx.emit("bilibili-notify/engine-error", "dynamic", "after-dispose");
		await vi.runAllTimersAsync();
		expect(push.sendPrivateMsg).toHaveBeenCalledTimes(1); // 未涨
	});

	it("push.sendPrivateMsg 抛出 → 走 logger.warn,不向外传播", async () => {
		const ctx = makeFakeCtx();
		const push = makePush();
		push.sendPrivateMsg.mockRejectedValueOnce(new Error("net down"));
		const logger = makeSilentLogger();
		new MasterNotifier({
			// biome-ignore lint/suspicious/noExplicitAny: koishi Context 测试替身
			ctx: ctx as any,
			logger,
			getPush: () => push,
		}).install();

		ctx.emit("bilibili-notify/auth-lost");
		await vi.runAllTimersAsync();

		expect(logger.warn).toHaveBeenCalledTimes(1);
		const warnMock = logger.warn as unknown as ReturnType<typeof vi.fn>;
		const warnArg = warnMock.mock.calls[0]?.[0];
		expect(String(warnArg)).toMatch(/source=auth/);
		expect(String(warnArg)).toMatch(/net down/);
	});
});
