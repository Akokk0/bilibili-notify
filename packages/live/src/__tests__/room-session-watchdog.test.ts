/**
 * 回归守护 — live WS 静默失活 watchdog。
 *
 * 开播推送依赖 B 站直播 WS 的 onLiveStart。如果底层连接半开/静默失活且不
 * 触发 error，旧逻辑不会重连，表现为“直播不推送，重启后恢复”。watchdog
 * 以 heartbeat / 任意 WS 事件刷新 activity，超过阈值主动
 * 复用重连状态机；它只自愈连接，不改变直播状态、不发业务推送。
 */

import type { LiveEvent } from "@bilibili-notify/blive";
import type { ServiceContext } from "@bilibili-notify/internal";
import { defaultMessageKindLayout } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { SubItemView } from "../push-like";
import { LiveRoomAccessDeniedError, type RoomContext } from "../room-helpers";
import { LIVE_WS_STALE_MS, RoomSession } from "../room-session";

type EventFunnel = (ev: LiveEvent) => void | Promise<void>;
type WatchdogTestSession = RoomSession & {
	onListenerStarted(): void;
	buildEventHandler(): EventFunnel;
	liveStatus: boolean;
	pushAtTimeTimer: { dispose(): void } | null;
};

type IntervalItem = { fn: () => void; disposed: boolean };
type TimeoutItem = { fn: () => void; ms: number; disposed: boolean };

function makeSub(over: Partial<SubItemView> = {}): SubItemView {
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
		pushTime: 1,
		restartPush: false,
		// 宿主恒填版式;用例按需覆盖。
		messageLayout: defaultMessageKindLayout("live"),
		...over,
	} as SubItemView;
}

function makeMockCtx(): {
	ctx: RoomContext;
	m: {
		intervals: IntervalItem[];
		timeouts: TimeoutItem[];
		closeListener: ReturnType<typeof vi.fn>;
		startLiveRoomListener: ReturnType<typeof vi.fn>;
		getLiveRoomInfo: ReturnType<typeof vi.fn>;
		getMasterInfo: ReturnType<typeof vi.fn>;
		emitEngineError: ReturnType<typeof vi.fn>;
		emitLiveState: ReturnType<typeof vi.fn>;
		stopMonitoring: ReturnType<typeof vi.fn>;
		warn: ReturnType<typeof vi.fn>;
		lastHandler: EventFunnel | undefined;
		intervalDisposeCount: () => number;
		timeoutDelays: () => number[];
		runIntervals: () => Promise<void>;
		runTimeouts: () => Promise<void>;
	};
} {
	const intervals: IntervalItem[] = [];
	const timeouts: TimeoutItem[] = [];
	let intervalDisposes = 0;
	let lastHandler: EventFunnel | undefined;
	const warn = vi.fn();
	const fakeServiceCtx: ServiceContext = {
		logger: { debug() {}, info() {}, warn, error() {} },
		setInterval: (fn) => {
			const item: IntervalItem = { fn, disposed: false };
			intervals.push(item);
			return {
				dispose: () => {
					item.disposed = true;
					intervalDisposes++;
				},
			};
		},
		setTimeout: (fn, ms) => {
			const item: TimeoutItem = { fn, ms, disposed: false };
			timeouts.push(item);
			return {
				dispose: () => {
					item.disposed = true;
				},
			};
		},
		onDispose: () => {},
	};
	const m = {
		intervals,
		timeouts,
		closeListener: vi.fn(),
		startLiveRoomListener: vi.fn(async (_roomId: string, handler: EventFunnel) => {
			lastHandler = handler;
			return true;
		}),
		getLiveRoomInfo: vi.fn(async () => ({
			uid: 1,
			live_status: 0,
			live_time: "",
			short_id: 0,
			room_id: 1,
		})),
		getMasterInfo: vi.fn(async () => ({
			username: "U1",
			userface: "face",
			roomId: 1,
			liveOpenFollowerNum: 0,
			liveEndFollowerNum: 0,
			liveFollowerChange: 0,
		})),
		emitEngineError: vi.fn(),
		emitLiveState: vi.fn(),
		stopMonitoring: vi.fn(),
		warn,
		get lastHandler() {
			return lastHandler;
		},
		intervalDisposeCount: () => intervalDisposes,
		timeoutDelays: () => timeouts.map((t) => t.ms),
		runIntervals: async () => {
			for (const item of [...intervals]) {
				if (!item.disposed) item.fn();
			}
			await Promise.resolve();
			await Promise.resolve();
		},
		runTimeouts: async () => {
			const batch = [...timeouts];
			timeouts.length = 0;
			for (const item of batch) {
				if (!item.disposed) item.fn();
			}
			await Promise.resolve();
			await Promise.resolve();
		},
	};
	const ctx = {
		serviceCtx: fakeServiceCtx,
		logger: fakeServiceCtx.logger,
		isDisposed: () => false,
		closeListener: m.closeListener,
		startLiveRoomListener: m.startLiveRoomListener,
		getLiveRoomInfo: m.getLiveRoomInfo,
		getMasterInfo: m.getMasterInfo,
		emitEngineError: m.emitEngineError,
		emitLiveState: m.emitLiveState,
		stopMonitoring: m.stopMonitoring,
		livePushTimerManager: new Map<string, () => void>(),
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
	return { ctx, m };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(1_000);
});

afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe("RoomSession live WS watchdog", () => {
	it("listener 建立后未超过 180s 不重连", async () => {
		const { ctx, m } = makeMockCtx();
		const session = new RoomSession(ctx, makeSub()) as unknown as WatchdogTestSession;
		session.onListenerStarted();

		vi.setSystemTime(1_000 + LIVE_WS_STALE_MS - 1);
		await m.runIntervals();

		expect(m.closeListener).not.toHaveBeenCalled();
		expect(m.startLiveRoomListener).not.toHaveBeenCalled();
	});

	it("超过 180s 静默 → 只重建连接,不改变直播状态、不取消周期 timer", async () => {
		const { ctx, m } = makeMockCtx();
		const session = new RoomSession(ctx, makeSub()) as unknown as WatchdogTestSession;
		const periodicDispose = vi.fn();
		session.liveStatus = true;
		session.pushAtTimeTimer = { dispose: periodicDispose };
		session.onListenerStarted();

		vi.setSystemTime(1_000 + LIVE_WS_STALE_MS);
		await m.runIntervals();

		expect(m.closeListener).toHaveBeenCalledTimes(1);
		expect(m.timeoutDelays()).toEqual([1000]);
		expect(m.emitLiveState).not.toHaveBeenCalled();
		expect(periodicDispose).not.toHaveBeenCalled();
		expect(session.isLive).toBe(true);
		expect(m.warn.mock.calls[0]?.[0]).toContain("连接静默");

		await m.runTimeouts();
		expect(m.startLiveRoomListener).toHaveBeenCalledTimes(1);
		expect(session.getWsHealthSnapshot().watchdogReconnectCount).toBe(1);
		expect(session.getWsHealthSnapshot().lastActivityReason).toBe("connected");
	});

	it("heartbeat 事件刷新 activity,阈值按刷新后重新计算", async () => {
		const { ctx, m } = makeMockCtx();
		const session = new RoomSession(ctx, makeSub()) as unknown as WatchdogTestSession;
		const handler = session.buildEventHandler();
		session.onListenerStarted();

		vi.setSystemTime(1_000 + 170_000);
		handler({ kind: "heartbeat", popularity: 1 });
		expect(session.getWsHealthSnapshot().lastActivityReason).toBe("heartbeat");

		vi.setSystemTime(1_000 + 170_000 + LIVE_WS_STALE_MS - 1);
		await m.runIntervals();
		expect(m.closeListener).not.toHaveBeenCalled();

		vi.setSystemTime(1_000 + 170_000 + LIVE_WS_STALE_MS);
		await m.runIntervals();
		expect(m.closeListener).toHaveBeenCalledTimes(1);
	});

	it("cancel() 清理 watchdog;即使旧 interval 回调被手动执行也不重连", async () => {
		const { ctx, m } = makeMockCtx();
		const session = new RoomSession(ctx, makeSub()) as unknown as WatchdogTestSession;
		session.onListenerStarted();

		session.cancel();
		vi.setSystemTime(1_000 + LIVE_WS_STALE_MS);
		await m.runIntervals();

		expect(m.intervalDisposeCount()).toBe(1);
		expect(m.closeListener).not.toHaveBeenCalled();
		expect(m.startLiveRoomListener).not.toHaveBeenCalled();
	});

	it("closed 事件触发重连;cancel 后不再触发", async () => {
		// 主动关闭的 close 回声由客户端自己吞掉(close() 后保证静默),不会走到
		// 这个漏斗 —— 旧库时代的 consumeIntentionalClose 对暗号已随之退役。
		const { ctx, m } = makeMockCtx();
		const session = new RoomSession(ctx, makeSub()) as unknown as WatchdogTestSession;
		const handler = session.buildEventHandler();

		handler({ kind: "closed" });
		expect(m.closeListener).toHaveBeenCalledTimes(1);
		expect(m.timeoutDelays()).toEqual([1000]);
		await m.runTimeouts();
		expect(m.startLiveRoomListener).toHaveBeenCalledTimes(1);

		session.cancel();
		handler({ kind: "closed" });
		expect(m.closeListener).toHaveBeenCalledTimes(1);
		expect(m.startLiveRoomListener).toHaveBeenCalledTimes(1);
	});

	it("watchdog 连续 tick 不并发重连", async () => {
		const { ctx, m } = makeMockCtx();
		const session = new RoomSession(ctx, makeSub()) as unknown as WatchdogTestSession;
		session.onListenerStarted();
		vi.setSystemTime(1_000 + LIVE_WS_STALE_MS);

		await m.runIntervals();
		await m.runIntervals();

		expect(m.closeListener).toHaveBeenCalledTimes(1);
		expect(m.startLiveRoomListener).not.toHaveBeenCalled();
		expect(m.timeoutDelays()).toEqual([1000]);
	});

	it("bootstrap 拉房间信息失败时 closeListener 触发 closed 事件也不会重连/启动 watchdog", async () => {
		const { ctx, m } = makeMockCtx();
		const session = new RoomSession(ctx, makeSub()) as unknown as WatchdogTestSession;
		m.getLiveRoomInfo.mockResolvedValueOnce(undefined);
		m.closeListener.mockImplementation(() => m.lastHandler?.({ kind: "closed" }));

		await session.bootstrap();

		expect(m.startLiveRoomListener).toHaveBeenCalledTimes(1); // 仅 bootstrap 建 listener
		expect(m.closeListener).toHaveBeenCalledTimes(1);
		expect(m.timeoutDelays()).toEqual([]); // closed 事件被 cancel 挡住,不排重连
		expect(m.intervals).toHaveLength(0); // info 失败时 watchdog 不启动
	});

	it("bootstrap 遇到受限房直接停止,不拉房间信息也不启动 watchdog", async () => {
		const { ctx, m } = makeMockCtx();
		m.startLiveRoomListener.mockRejectedValueOnce(
			new LiveRoomAccessDeniedError("B 站返回 code=-400 message=room is encrypted"),
		);
		const session = new RoomSession(ctx, makeSub()) as unknown as WatchdogTestSession;

		await session.bootstrap();

		expect(m.getLiveRoomInfo).not.toHaveBeenCalled();
		expect(m.stopMonitoring).toHaveBeenCalledTimes(1);
		expect(m.stopMonitoring.mock.calls[0]).toEqual([
			"弹幕连接不可用：B 站返回 code=-400 message=room is encrypted，可能是加密/付费/测试房或当前账号无权限访问",
			"r1",
		]);
		expect(m.timeouts).toHaveLength(0);
		expect(m.intervals).toHaveLength(0);
	});

	it("watchdog 重连耗尽后停止 watchdog,不会被同一个 stale interval 反复拉起", async () => {
		const { ctx, m } = makeMockCtx();
		m.startLiveRoomListener.mockRejectedValue(new Error("still down"));
		const session = new RoomSession(ctx, makeSub()) as unknown as WatchdogTestSession;
		session.onListenerStarted();
		vi.setSystemTime(1_000 + LIVE_WS_STALE_MS);

		await m.runIntervals();
		for (let i = 0; i < 5; i++) await m.runTimeouts();

		expect(m.startLiveRoomListener).toHaveBeenCalledTimes(5);
		expect(m.emitEngineError).toHaveBeenCalledTimes(1);
		expect(m.intervalDisposeCount()).toBe(1);
		await m.runIntervals();
		expect(m.startLiveRoomListener).toHaveBeenCalledTimes(5);
	});

	it("watchdog 重连遇到受限房时停止监测,不继续退避", async () => {
		const { ctx, m } = makeMockCtx();
		m.startLiveRoomListener.mockRejectedValue(
			new LiveRoomAccessDeniedError("B 站返回 code=-400 message=room is encrypted"),
		);
		const session = new RoomSession(ctx, makeSub()) as unknown as WatchdogTestSession;
		session.onListenerStarted();
		vi.setSystemTime(1_000 + LIVE_WS_STALE_MS);

		await m.runIntervals();
		expect(m.timeoutDelays()).toEqual([1000]);
		await m.runTimeouts();

		expect(m.startLiveRoomListener).toHaveBeenCalledTimes(1);
		expect(m.stopMonitoring).toHaveBeenCalledTimes(1);
		expect(m.stopMonitoring.mock.calls[0]).toEqual([
			"弹幕连接不可用：B 站返回 code=-400 message=room is encrypted，可能是加密/付费/测试房或当前账号无权限访问",
			"r1",
		]);
		expect(m.intervalDisposeCount()).toBe(1);
		expect(m.timeoutDelays()).toEqual([]);
		await m.runIntervals();
		expect(m.startLiveRoomListener).toHaveBeenCalledTimes(1);
	});
});
