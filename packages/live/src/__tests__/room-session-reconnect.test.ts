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
import type { RoomContext } from "../room-helpers";
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
	};
}

interface MockBag {
	closeListener: ReturnType<typeof vi.fn>;
	startLiveRoomListener: ReturnType<typeof vi.fn>;
	emitEngineError: ReturnType<typeof vi.fn>;
	emitLiveState: ReturnType<typeof vi.fn>;
	scheduled: Array<() => void>; // 待跑的 sleep callback
	runScheduled: () => Promise<void>; // 把队列里所有 callback 跑一遍
}

function makeMockCtx(opts?: {
	startThrows?: boolean;
}): { ctx: RoomContext; mocks: MockBag } {
	const scheduled: Array<() => void> = [];
	const fakeServiceCtx: ServiceContext = {
		logger: { debug() {}, info() {}, warn() {}, error() {} },
		setInterval: vi.fn(),
		// 把每个 setTimeout 的 callback 收集起来,测试手动驱动
		setTimeout: (fn) => {
			scheduled.push(fn);
			return { dispose: () => {} };
		},
		onDispose: () => {},
	};

	const mocks: MockBag = {
		closeListener: vi.fn(),
		startLiveRoomListener: vi.fn(async () => {
			if (opts?.startThrows) throw new Error("network blip");
		}),
		emitEngineError: vi.fn(),
		emitLiveState: vi.fn(),
		scheduled,
		runScheduled: async () => {
			// snapshot 后清空,避免新 schedule 立即被同一轮跑掉造成递归
			const batch = [...scheduled];
			scheduled.length = 0;
			for (const fn of batch) fn();
			// 让 microtask 跑一轮
			await new Promise((r) => setImmediate(r));
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
