import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
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

describe("degraded raw → 漂移报警(限流)", () => {
	it("首条 degraded raw 立即 warn,同 cmd 重复不刷屏,第 100 条再报一次累计", async () => {
		const h = makeSessionHarness();
		await h.bootstrap();
		const event = {
			kind: "raw",
			cmd: "SUPER_CHAT_MESSAGE",
			payload: {},
			degraded: true,
		} as const;

		await h.dispatch(event);
		expect(h.warnings).toHaveLength(1);
		expect(h.warnings[0]?.[1]).toEqual({ roomId: "r1", cmd: "SUPER_CHAT_MESSAGE", count: 1 });
		expect(h.warnings[0]?.[0]).toBe("已知直播命令解析降级，请检查是否需要更新");

		for (let i = 2; i <= 99; i++) await h.dispatch(event);
		expect(h.warnings).toHaveLength(1);

		await h.dispatch(event);
		expect(h.warnings).toHaveLength(2);
		expect(h.warnings[1]?.[1]).toEqual({ roomId: "r1", cmd: "SUPER_CHAT_MESSAGE", count: 100 });
	});

	it("不同 cmd 各自计数,各自首条都报", async () => {
		const h = makeSessionHarness();
		await h.bootstrap();

		await h.dispatch({ kind: "raw", cmd: "GUARD_BUY", payload: {}, degraded: true });
		await h.dispatch({ kind: "raw", cmd: "SEND_GIFT_V2", payload: {}, degraded: true });

		expect(h.warnings).toHaveLength(2);
	});

	it("plain raw(刻意不解析的命令)不报警", async () => {
		const h = makeSessionHarness();
		await h.bootstrap();

		await h.dispatch({ kind: "raw", cmd: "STOP_LIVE_ROOM_LIST", payload: {} });

		expect(h.warnings).toEqual([]);
	});
});

describe("漏斗 default:未消费的已解析 kind 也是活的流量", () => {
	it("gift / room-change 等标活跃度,不落进任何业务分支", async () => {
		const h = makeSessionHarness();
		await h.bootstrap();
		h.closeListener.mockClear();

		await h.dispatch({ kind: "rank-count", count: 42 });
		vi.setSystemTime(T0 + LIVE_WS_STALE_MS - 1);
		h.intervals[0]?.fn();
		await h.settle();

		expect(h.closeListener).not.toHaveBeenCalled();
		expect(h.warnings).toEqual([]);
		expect(h.reports).toEqual([]);
	});
});
