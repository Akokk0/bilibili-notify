/**
 * 协议漂移观测 — degraded raw 的上游报警 + 漏斗 default 的活跃度标记。
 *
 * blive 把「已知命令解析失败」标成 `degraded: true` 的 raw(SEND_GIFT_V2
 * 迁移那种字段漂移的信号);RoomSession 负责把它变成能看见的 warn 日志,
 * 但要限流 —— 漂移一旦发生是每帧都漂,逐帧 warn 会刷爆日志。
 *
 * 顺带钉住:业务不消费的已解析 kind(gift / room-change 等 12 个)走漏斗
 * default 也要标活跃度 —— 它们和 raw 一样是活的流量,watchdog 不该因为
 * 房间只刷礼物不发弹幕就误判静默。
 */

import type { LiveEvent } from "@bilibili-notify/blive";
import type { ServiceContext } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { SubItemView } from "../push-like";
import type { RoomContext } from "../room-helpers";
import { RoomSession } from "../room-session";

type EventFunnel = (ev: LiveEvent) => void | Promise<void>;
type TestSession = RoomSession & { buildEventHandler(): EventFunnel };

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
		pushTime: 1,
		restartPush: false,
	};
}

function makeSession(): { session: TestSession; warn: ReturnType<typeof vi.fn> } {
	const warn = vi.fn();
	const fakeServiceCtx: ServiceContext = {
		logger: { debug() {}, info() {}, warn, error() {} },
		setInterval: () => ({ dispose() {} }),
		setTimeout: () => ({ dispose() {} }),
		onDispose: () => {},
	};
	const ctx = {
		serviceCtx: fakeServiceCtx,
		logger: fakeServiceCtx.logger,
		isDisposed: () => false,
		danmakuCollector: { clear: () => {}, registerRoom: () => {} },
	} as unknown as RoomContext;
	const session = new RoomSession(ctx, makeSub()) as unknown as TestSession;
	return { session, warn };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(1_000);
});

afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe("degraded raw → 漂移报警(限流)", () => {
	it("首条 degraded raw 立即 warn,同 cmd 重复不刷屏,第 100 条再报一次累计", () => {
		const { session, warn } = makeSession();
		const handler = session.buildEventHandler();
		const ev: LiveEvent = {
			kind: "raw",
			cmd: "SUPER_CHAT_MESSAGE",
			payload: {},
			degraded: true,
		};

		handler(ev);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toContain("SUPER_CHAT_MESSAGE");
		expect(warn.mock.calls[0]?.[0]).toContain("r1");

		for (let i = 2; i <= 99; i++) handler(ev);
		expect(warn).toHaveBeenCalledTimes(1);

		handler(ev); // 第 100 条
		expect(warn).toHaveBeenCalledTimes(2);
		expect(warn.mock.calls[1]?.[0]).toContain("100");
	});

	it("不同 cmd 各自计数,各自首条都报", () => {
		const { session, warn } = makeSession();
		const handler = session.buildEventHandler();

		handler({ kind: "raw", cmd: "GUARD_BUY", payload: {}, degraded: true });
		handler({ kind: "raw", cmd: "SEND_GIFT_V2", payload: {}, degraded: true });
		expect(warn).toHaveBeenCalledTimes(2);
	});

	it("plain raw(刻意不解析的命令)不报警", () => {
		const { session, warn } = makeSession();
		const handler = session.buildEventHandler();

		handler({ kind: "raw", cmd: "STOP_LIVE_ROOM_LIST", payload: {} });
		expect(warn).not.toHaveBeenCalled();
	});
});

describe("漏斗 default:未消费的已解析 kind 也是活的流量", () => {
	it("gift / room-change 等标活跃度,不落进任何业务分支", () => {
		const { session, warn } = makeSession();
		const handler = session.buildEventHandler();
		// 让 lastActivityAt 从 0 起跳,便于断言确实被刷新
		expect(session.getWsHealthSnapshot().lastActivityAt).toBe(0);

		handler({ kind: "rank-count", count: 42 });
		expect(session.getWsHealthSnapshot().lastActivityAt).toBe(1_000);
		expect(session.getWsHealthSnapshot().lastActivityReason).toBe("other");
		expect(warn).not.toHaveBeenCalled();
	});
});
