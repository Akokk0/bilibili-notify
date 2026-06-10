/**
 * 回归守护 — P1-C 短期-c:RoomSession.cancel() 阻断退避重连。
 *
 * 关键不变量:
 *   - cancel() 后再触发 onError → 不重连、不告警、什么都不做
 *   - 重连 sleep 期间 cancel() → 醒来时 cancelled 检测命中,不调 startLiveRoomListener
 *
 * 这两条契约失效 = ListenerManager.stopForUid 之后旧 session 还会被自动接回来 → 用户
 * 关了 listener 反而越关越多。
 */

import type { ServiceContext } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vitest";
import type { SubItemView } from "../push-like";
import { LiveRoomAccessDeniedError, type RoomContext } from "../room-helpers";
import { RoomSession } from "../room-session";

function makeSub(): SubItemView {
	return {
		uid: "u1",
		uname: "U1",
		roomId: "r1",
		dynamic: false,
		live: true,
		liveEnd: true,
		liveGuardBuy: false,
		superchat: false,
		wordcloud: false,
		liveSummary: false,
		target: {},
		customCardStyle: { enable: false },
		customLiveMsg: { enable: false },
		customGuardBuy: { enable: false },
		customLiveSummary: { enable: false },
		customSpecialDanmakuUsers: { enable: false, msgTemplate: "" },
		customSpecialUsersEnterTheRoom: { enable: false, msgTemplate: "" },
		minScPrice: 0,
		minGuardLevel: 3,
		pushTime: 0,
		restartPush: false,
	};
}

interface ScheduledItem {
	fn: () => void;
	ms: number;
}

interface MockBag {
	closeListener: ReturnType<typeof vi.fn>;
	startLiveRoomListener: ReturnType<typeof vi.fn>;
	emitEngineError: ReturnType<typeof vi.fn>;
	emitLiveState: ReturnType<typeof vi.fn>;
	stopMonitoring: ReturnType<typeof vi.fn>;
	scheduled: ScheduledItem[]; // 待跑的 sleep callback + 对应 delay
	delays: () => number[]; // 至今 schedule 过的 delay 列表(按顺序)
	disposeCount: () => number; // setTimeout 句柄被 dispose 的次数(L3)
	runScheduled: () => Promise<void>; // 把队列里所有 callback 跑一遍
	flushAll: (maxIters?: number) => Promise<void>; // 反复 runScheduled 直到队列空
}

function makeMockCtx(opts?: { startThrows?: boolean }): { ctx: RoomContext; mocks: MockBag } {
	const scheduled: ScheduledItem[] = [];
	const delayLog: number[] = [];
	let disposes = 0;
	const fakeServiceCtx: ServiceContext = {
		logger: { debug() {}, info() {}, warn() {}, error() {} },
		setInterval: vi.fn(),
		// 把每个 setTimeout 的 callback + delay 收集起来,测试手动驱动 + 校验退避序列
		setTimeout: (fn, ms) => {
			scheduled.push({ fn, ms });
			delayLog.push(ms);
			return {
				dispose: () => {
					disposes++;
				},
			};
		},
		onDispose: () => {},
	};

	const mocks: MockBag = {
		closeListener: vi.fn(),
		// L4:startLiveRoomListener 现返回 boolean(true=有 listener)。成功须返
		// true,否则 reconnectLoop 视作失败继续退避。
		startLiveRoomListener: vi.fn(async () => {
			if (opts?.startThrows) throw new Error("network blip");
			return true;
		}),
		emitEngineError: vi.fn(),
		emitLiveState: vi.fn(),
		stopMonitoring: vi.fn(),
		scheduled,
		delays: () => [...delayLog],
		disposeCount: () => disposes,
		runScheduled: async () => {
			// snapshot 后清空,避免新 schedule 立即被同一轮跑掉造成递归
			const batch = [...scheduled];
			scheduled.length = 0;
			for (const item of batch) item.fn();
			// 让 microtask 跑一轮
			await new Promise((r) => setImmediate(r));
		},
		flushAll: async (maxIters = 50) => {
			for (let i = 0; i < maxIters && scheduled.length > 0; i++) {
				const batch = [...scheduled];
				scheduled.length = 0;
				for (const item of batch) item.fn();
				await new Promise((r) => setImmediate(r));
			}
		},
	};

	const ctx = {
		serviceCtx: fakeServiceCtx,
		logger: fakeServiceCtx.logger,
		isDisposed: () => false,
		closeListener: mocks.closeListener,
		startLiveRoomListener: mocks.startLiveRoomListener,
		emitEngineError: mocks.emitEngineError,
		emitLiveState: mocks.emitLiveState,
		stopMonitoring: mocks.stopMonitoring,
		livePushTimerManager: new Map<string, () => void>(), // cancelPeriodicTimer 需要
		danmakuCollector: { clear: () => {}, registerRoom: () => {} },
		push: { sendPrivateMsg: async () => {}, broadcastToTargets: async () => {} },
		contentBuilder: {
			text: (t: string) => ({ kind: "text", text: t }),
			image: () => ({ kind: "image" }),
			message: (segs: unknown[]) => segs,
		},
		isSubscribed: () => false,
		hasTargets: () => false,
		templateRenderer: { renderSpecialDanmaku: () => "" },
	} as unknown as RoomContext;

	return { ctx, mocks };
}

describe("RoomSession.cancel() — P1-C 短期-c", () => {
	it("cancel() 之后触发 onError 不重连(直接 return,不动 startLiveRoomListener / emitEngineError)", async () => {
		const { ctx, mocks } = makeMockCtx();
		const session = new RoomSession(ctx, makeSub());
		session.cancel();

		// 触发内部 onError;它是 private,用 cast 调用。
		// biome-ignore lint/suspicious/noExplicitAny: 测试 private 方法
		await (session as any).onError();

		expect(mocks.closeListener).not.toHaveBeenCalled();
		expect(mocks.startLiveRoomListener).not.toHaveBeenCalled();
		expect(mocks.emitEngineError).not.toHaveBeenCalled();
		expect(mocks.scheduled).toHaveLength(0); // 没排重连
	});

	it("sleep 期间 cancel() → 醒来时 cancelled 命中,不调 startLiveRoomListener", async () => {
		const { ctx, mocks } = makeMockCtx();
		const session = new RoomSession(ctx, makeSub());

		// biome-ignore lint/suspicious/noExplicitAny: 测试 private 方法
		const errorPromise = (session as any).onError();

		// 第一阶段 — onError 进入退避 sleep,schedule 了一个 callback
		await new Promise((r) => setImmediate(r));
		expect(mocks.scheduled.length).toBeGreaterThanOrEqual(1);
		expect(mocks.closeListener).toHaveBeenCalledTimes(1);

		// 用户取消(对应 ListenerManager.stopForUid 路径)
		session.cancel();
		await mocks.runScheduled();
		await errorPromise;

		expect(mocks.startLiveRoomListener).not.toHaveBeenCalled();
		expect(mocks.emitEngineError).not.toHaveBeenCalled();
	});

	it("无 cancel 时 sleep 后正常发起 startLiveRoomListener", async () => {
		const { ctx, mocks } = makeMockCtx();
		const session = new RoomSession(ctx, makeSub());

		// biome-ignore lint/suspicious/noExplicitAny: 测试 private 方法
		const errorPromise = (session as any).onError();
		await new Promise((r) => setImmediate(r));
		await mocks.runScheduled();
		await errorPromise;

		expect(mocks.startLiveRoomListener).toHaveBeenCalledTimes(1);
		expect(mocks.emitEngineError).not.toHaveBeenCalled();
	});
});

describe("RoomSession 退避状态机 — codex review minor-4", () => {
	it("连续失败 5 次 → 退避序列 = [1000, 2000, 4000, 8000, 16000]", async () => {
		const { ctx, mocks } = makeMockCtx({ startThrows: true });
		const session = new RoomSession(ctx, makeSub());

		// biome-ignore lint/suspicious/noExplicitAny: 测试 private 方法
		void (session as any).onError();
		// L1/L3:单飞 reconnectLoop 用 while 续链(无 setTimeout(0) 递归);每步
		// 仅 sleepReconnect 排一个定时器。flushAll 反复 drive 出全链路。
		await mocks.flushAll();

		// 仅退避表的 5 档,各一次(已无 setTimeout(0) 的 0ms 让栈;filter d>0
		// 仍保留以防御未来引入其它 0ms 定时器)。
		const backoffOnly = mocks.delays().filter((d) => d > 0);
		expect(backoffOnly).toEqual([1000, 2000, 4000, 8000, 16000]);
	});

	it("第 6 次失败时退避耗尽 → emitEngineError + 不再 schedule 新 backoff", async () => {
		const { ctx, mocks } = makeMockCtx({ startThrows: true });
		const session = new RoomSession(ctx, makeSub());

		// biome-ignore lint/suspicious/noExplicitAny: 测试 private 方法
		void (session as any).onError();
		await mocks.flushAll();

		// 5 次 startLiveRoomListener 都失败 → reconnectLoop 跑满 5 档退避后退出 while → 放弃
		expect(mocks.startLiveRoomListener).toHaveBeenCalledTimes(5);
		expect(mocks.emitEngineError).toHaveBeenCalledTimes(1);
		expect(mocks.emitEngineError.mock.calls[0][0]).toMatch(/重试 5 次后放弃监听/);

		// 耗尽路径之后不应该再 schedule 新 backoff
		const backoffOnly = mocks.delays().filter((d) => d > 0);
		expect(backoffOnly).toHaveLength(5); // 不会多出第 6 个 backoff
	});

	it("受限房错误 → 立即停止监测,不跑满 5 档退避", async () => {
		const { ctx, mocks } = makeMockCtx();
		mocks.startLiveRoomListener.mockRejectedValue(
			new LiveRoomAccessDeniedError("B 站返回 code=-400 message=room is encrypted"),
		);
		const session = new RoomSession(ctx, makeSub());

		// biome-ignore lint/suspicious/noExplicitAny: 测试 private 方法
		void (session as any).onError();
		await mocks.flushAll();

		expect(mocks.startLiveRoomListener).toHaveBeenCalledTimes(1);
		expect(mocks.stopMonitoring).toHaveBeenCalledTimes(1);
		expect(mocks.stopMonitoring.mock.calls[0]).toEqual([
			"弹幕连接不可用：B 站返回 code=-400 message=room is encrypted，可能是加密/付费/测试房或当前账号无权限访问",
			"r1",
		]);
		expect(mocks.emitEngineError).not.toHaveBeenCalled();
		expect(mocks.delays().filter((d) => d > 0)).toEqual([1000]);
	});

	it("重连成功 → reconnectAttempts 复位,下一轮 onError 从 1000ms 重新开始", async () => {
		// vi.fn 行为脚本:第 1 次 throw,第 2 次 ok(true),第 3 次 throw。
		// reconnectLoop:1000 退避→第1次 throw(catch,继续)→2000 退避→第2次
		// 返回 true→复位 attempts 并退出。
		const { ctx, mocks } = makeMockCtx();
		mocks.startLiveRoomListener
			.mockRejectedValueOnce(new Error("blip 1"))
			.mockResolvedValueOnce(true) // L4:成功 = 返回 true
			.mockRejectedValueOnce(new Error("blip 2"));

		const session = new RoomSession(ctx, makeSub());
		// 第一轮 onError(failure)
		// biome-ignore lint/suspicious/noExplicitAny: 测试 private 方法
		void (session as any).onError();
		await mocks.flushAll();
		// 1000ms 退避 → startListener 抛(catch,while 续) → 2000ms 退避 →
		// startListener 返回 true → reconnectAttempts 复位
		expect(mocks.delays().filter((d) => d > 0)).toEqual([1000, 2000]);
		expect(mocks.startLiveRoomListener).toHaveBeenCalledTimes(2);

		// 第二轮 onError(failure):因为上一轮 success 复位,下一轮还是从 1000 开始
		// biome-ignore lint/suspicious/noExplicitAny: 测试 private 方法
		void (session as any).onError();
		await mocks.flushAll();
		const round2 = mocks
			.delays()
			.filter((d) => d > 0)
			.slice(2);
		expect(round2[0]).toBe(1000); // 不是 4000 / 8000
	});
});

describe("RoomSession 重连 post-await 重校 — ②6", () => {
	it("startLiveRoomListener 返回 true 但其间 cancelled 翻转 → 关闭孤儿 listener,不计成功", async () => {
		const { ctx, mocks } = makeMockCtx();
		const session = new RoomSession(ctx, makeSub());
		// 模拟 startLiveRoomListener 在 await 期间与 stopForUid 交错:
		// 它确实建好了 listener(返回 true),但返回前 session 已被取消。
		mocks.startLiveRoomListener.mockImplementationOnce(async () => {
			session.cancel();
			return true;
		});

		// biome-ignore lint/suspicious/noExplicitAny: 测试 private 方法
		void (session as any).onError();
		await mocks.flushAll();

		// 只发起一次;返回 true 后 post-await 重校命中 cancelled → 主动 closeListener
		// 关掉孤儿(loop 顶部 1 次 + 孤儿 1 次 = 2),不 emitEngineError、不再排重连。
		expect(mocks.startLiveRoomListener).toHaveBeenCalledTimes(1);
		expect(mocks.closeListener).toHaveBeenCalledTimes(2);
		expect(mocks.emitEngineError).not.toHaveBeenCalled();
		expect(mocks.scheduled).toHaveLength(0);
	});
});

describe("RoomSession 重连竞态 — L1/L3", () => {
	it("L1:并发 onError 单飞 —— 只跑一轮重连(startLiveRoomListener 仅一次)", async () => {
		const { ctx, mocks } = makeMockCtx();
		const session = new RoomSession(ctx, makeSub());

		// 两次并发触发(WS 错误常突发多帧)。
		// biome-ignore lint/suspicious/noExplicitAny: 测试 private 方法
		const p1 = (session as any).onError();
		// biome-ignore lint/suspicious/noExplicitAny: 测试 private 方法
		const p2 = (session as any).onError();
		await new Promise((r) => setImmediate(r));

		// #1 进入退避并 schedule 一个 sleep;#2 撞 reconnecting 守卫直接 return,
		// 没有第二次 closeListener / 第二个 sleep。
		expect(mocks.scheduled).toHaveLength(1);
		expect(mocks.closeListener).toHaveBeenCalledTimes(1);

		await mocks.flushAll();
		await Promise.all([p1, p2]);

		// 单飞:整个过程只发起一次 startLiveRoomListener(不会装回重复 listener)。
		expect(mocks.startLiveRoomListener).toHaveBeenCalledTimes(1);
	});

	it("L3:退避 sleep 期间 cancel() → dispose 定时器并立即 unwind(不等 expiry)", async () => {
		const { ctx, mocks } = makeMockCtx();
		const session = new RoomSession(ctx, makeSub());

		// biome-ignore lint/suspicious/noExplicitAny: 测试 private 方法
		const p = (session as any).onError();
		await new Promise((r) => setImmediate(r));
		expect(mocks.scheduled).toHaveLength(1); // 正在退避 sleep
		expect(mocks.disposeCount()).toBe(0);

		session.cancel(); // 对应 ListenerManager.stopForUid / disposeAll 路径
		await p; // clearReconnectSleep 唤醒 loop → 命中 cancelled → 立即返回,无需驱动 scheduled

		expect(mocks.disposeCount()).toBe(1); // 退避定时器被 dispose,不留回调到 expiry
		expect(mocks.startLiveRoomListener).not.toHaveBeenCalled();
		expect(mocks.emitEngineError).not.toHaveBeenCalled();
	});
});
