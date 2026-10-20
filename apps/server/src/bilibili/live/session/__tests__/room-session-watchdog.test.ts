import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { LiveRoomAccessDeniedError } from "../room-helpers.js";
import { LIVE_WS_STALE_MS } from "../room-session.js";
import { makeSessionHarness } from "./support/room-session.js";

const T0 = 1_000_000;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(T0);
});

afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe("RoomSession live WS watchdog", () => {
	it("listener 建立后未超过 180s 不重连", async () => {
		const h = makeSessionHarness();
		await h.bootstrap();
		await h.dispatch({ kind: "heartbeat", popularity: 1 });
		vi.setSystemTime(T0 + LIVE_WS_STALE_MS - 1);

		h.intervals[0]?.fn();
		await h.settle();

		expect(h.closeListener).not.toHaveBeenCalled();
		expect(h.timeoutDelays).toEqual([]);
	});

	it("超过 180s 静默 → 只重建连接,不改变直播状态、不取消周期 timer", async () => {
		const h = makeSessionHarness();
		await h.bootstrap();
		h.reports.length = 0;
		await h.dispatch({ kind: "heartbeat", popularity: 1 });
		vi.setSystemTime(T0 + LIVE_WS_STALE_MS);

		h.intervals[0]?.fn();
		await h.settle();

		expect(h.closeListener).toHaveBeenCalledTimes(1);
		expect(h.timeoutDelays).toEqual([1_000]);
		expect(h.reports).toEqual([]);

		await h.runTimeouts();
		expect(h.startLiveRoomListener).toHaveBeenCalledTimes(2);
	});

	it("heartbeat 事件刷新 activity,阈值按刷新后重新计算", async () => {
		const h = makeSessionHarness();
		await h.bootstrap();
		vi.setSystemTime(T0 + 170_000);
		await h.dispatch({ kind: "heartbeat", popularity: 1 });

		vi.setSystemTime(T0 + 170_000 + LIVE_WS_STALE_MS - 1);
		h.intervals[0]?.fn();
		await h.settle();
		expect(h.closeListener).not.toHaveBeenCalled();

		vi.setSystemTime(T0 + 170_000 + LIVE_WS_STALE_MS);
		h.intervals[0]?.fn();
		await h.settle();
		expect(h.closeListener).toHaveBeenCalledTimes(1);
	});

	it("cancel() 清理 watchdog;即使旧 interval 回调被手动执行也不重连", async () => {
		const h = makeSessionHarness();
		await h.bootstrap();
		h.session.cancel();
		vi.setSystemTime(T0 + LIVE_WS_STALE_MS);

		h.intervals[0]?.fn();
		await h.settle();

		expect(h.intervals[0]?.disposed).toBe(true);
		expect(h.closeListener).not.toHaveBeenCalled();
		expect(h.timeoutDelays).toEqual([]);
	});

	it("closed 事件触发重连;cancel 后不再触发", async () => {
		const h = makeSessionHarness();
		await h.bootstrap();
		h.closeListener.mockClear();
		h.startLiveRoomListener.mockClear();

		await h.dispatch({ kind: "closed" });
		expect(h.closeListener).toHaveBeenCalledTimes(1);
		expect(h.timeoutDelays).toEqual([1_000]);
		await h.runTimeouts();
		expect(h.startLiveRoomListener).toHaveBeenCalledTimes(1);

		h.session.cancel();
		await h.dispatch({ kind: "closed" });
		expect(h.closeListener).toHaveBeenCalledTimes(1);
		expect(h.startLiveRoomListener).toHaveBeenCalledTimes(1);
	});

	it("watchdog 连续 tick 不并发重连", async () => {
		const h = makeSessionHarness();
		await h.bootstrap();
		await h.dispatch({ kind: "heartbeat", popularity: 1 });
		vi.setSystemTime(T0 + LIVE_WS_STALE_MS);

		h.intervals[0]?.fn();
		h.intervals[0]?.fn();
		await h.settle();

		expect(h.closeListener).toHaveBeenCalledTimes(1);
		expect(h.startLiveRoomListener).toHaveBeenCalledTimes(1);
		expect(h.timeoutDelays).toEqual([1_000]);
	});

	it("bootstrap 拉房间信息失败时 closeListener 触发 closed 事件也不会重连/启动 watchdog", async () => {
		const h = makeSessionHarness({
			roomInfo: async () => undefined,
		});
		h.closeListener.mockImplementation(() => {
			queueMicrotask(() => {
				void h.handler({ kind: "closed" });
			});
		});

		await h.bootstrap();

		expect(h.closeListener).toHaveBeenCalledTimes(1);
		expect(h.timeoutDelays).toEqual([]);
		expect(h.intervals.every((item) => item.disposed)).toBe(true);
	});

	it("bootstrap 遇到受限房直接停止,不拉房间信息也不启动 watchdog", async () => {
		const h = makeSessionHarness({
			listener: async () =>
				Promise.reject(
					new LiveRoomAccessDeniedError("B 站返回 code=-400 message=room is encrypted"),
				),
		});

		await h.bootstrap();

		expect(h.fetchRoomInfo).not.toHaveBeenCalled();
		expect(h.problems.reportFailure).toHaveBeenCalledTimes(1);
		expect(h.intervals).toHaveLength(0);
	});

	it("watchdog 重连耗尽后停止 watchdog,不会被同一个 stale interval 反复拉起", async () => {
		const h = makeSessionHarness();
		await h.bootstrap();
		h.startLiveRoomListener.mockRejectedValue(new Error("still down"));
		await h.dispatch({ kind: "heartbeat", popularity: 1 });
		vi.setSystemTime(T0 + LIVE_WS_STALE_MS);

		h.intervals[0]?.fn();
		for (let i = 0; i < 5; i++) await h.runTimeouts();

		expect(h.startLiveRoomListener).toHaveBeenCalledTimes(6);
		expect(h.problems.reportFailure).toHaveBeenCalledTimes(1);
		expect(h.intervals[0]?.disposed).toBe(true);
		h.intervals[0]?.fn();
		await h.settle();
		expect(h.startLiveRoomListener).toHaveBeenCalledTimes(6);
	});

	it("watchdog 重连遇到受限房时停止监测,不继续退避", async () => {
		const h = makeSessionHarness();
		await h.bootstrap();
		h.startLiveRoomListener.mockRejectedValue(
			new LiveRoomAccessDeniedError("B 站返回 code=-400 message=room is encrypted"),
		);
		await h.dispatch({ kind: "heartbeat", popularity: 1 });
		vi.setSystemTime(T0 + LIVE_WS_STALE_MS);

		h.intervals[0]?.fn();
		await h.settle();
		expect(h.timeoutDelays).toEqual([1_000]);
		await h.runTimeouts();

		expect(h.startLiveRoomListener).toHaveBeenCalledTimes(2);
		expect(h.problems.reportFailure).toHaveBeenCalledTimes(1);
		expect(h.intervals[0]?.disposed).toBe(true);
		expect(h.timeoutDelays).toEqual([1_000]);
	});
});
