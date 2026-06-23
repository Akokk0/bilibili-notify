/**
 * 单元测试 — 断流接续(live-end grace)状态机。
 *
 * 覆盖四条主路径:
 *   - grace 关 → onLiveEnd 立即走 handleLiveEnd(现状不变)
 *   - grace 开 → onLiveEnd 不立即下播:暂停复推、保持 liveStatus、不清弹幕缓冲、起等待计时器
 *   - 挂起期内 onLiveStart → 接续:取消等待 + 恢复复推 + 不发开播卡 + 不 handleLiveEnd
 *   - 等待到期:B站仍离线 → handleLiveEnd(用定格 diffTime);B站已重开(漏帧) → 接续不下播
 *
 * 一条门控写反 = 要么误报下播、要么真下播永不通知,故逐路径锁死。
 */

import type { ServiceContext } from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { SubItemView } from "../push-like";
import type { RoomContext } from "../room-helpers";
import { RoomSession } from "../room-session";

// biome-ignore lint/suspicious/noExplicitAny: 测试需访问 private/protected
type AnySession = any;

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
		pushTime: 0,
		restartPush: false,
		...over,
	} as SubItemView;
}

interface Captured {
	cb?: () => void | Promise<void>;
	ms?: number;
	dispose: ReturnType<typeof vi.fn>;
}

function makeCtx() {
	const captured: Captured = { dispose: vi.fn() };
	const clear = vi.fn();
	const emitLiveState = vi.fn();
	const fakeServiceCtx: ServiceContext = {
		logger: { debug() {}, info() {}, warn() {}, error() {} },
		setInterval: () => ({ dispose() {} }),
		setTimeout: ((cb: () => void, ms: number) => {
			captured.cb = cb;
			captured.ms = ms;
			return { dispose: captured.dispose };
		}) as ServiceContext["setTimeout"],
		onDispose: () => {},
	};
	const sendLiveNotifyCard = vi.fn(async () => {});
	const ctx = {
		serviceCtx: fakeServiceCtx,
		logger: fakeServiceCtx.logger,
		isDisposed: () => false,
		danmakuCollector: { clear, registerRoom: vi.fn() },
		getTimeDifference: vi.fn(async () => "3小时"),
		emitLiveState,
		sendLiveNotifyCard,
	} as unknown as RoomContext;
	return { ctx, captured, clear, emitLiveState, sendLiveNotifyCard };
}

/** 造一个「已开播」的 session,grace 状态机要测的入口都在 live 态。 */
function liveSession(ctx: RoomContext, sub: SubItemView): AnySession {
	const s = new RoomSession(ctx, sub) as AnySession;
	s.liveStatus = true;
	s.liveTime = "2026-01-01 10:00:00";
	// 把会去拉网络 / 真推送的重活打桩,只观察状态机决策。
	s.handleLiveEnd = vi.fn(async () => {});
	s.armPeriodicTimer = vi.fn();
	s.cancelPeriodicTimer = vi.fn();
	return s;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("RoomSession 断流接续 — grace 关", () => {
	it("onLiveEnd 立即走 handleLiveEnd,不进等待", async () => {
		const { ctx, captured } = makeCtx();
		const s = liveSession(ctx, makeSub({ liveEndGrace: false }));
		await s.onLiveEnd();
		expect(s.handleLiveEnd).toHaveBeenCalledTimes(1);
		expect(captured.cb).toBeUndefined();
	});
});

describe("RoomSession 断流接续 — grace 开", () => {
	it("onLiveEnd 挂起:不下播 / 不清缓冲 / 不翻 idle / 暂停复推 / 起计时器", async () => {
		const { ctx, captured, clear, emitLiveState } = makeCtx();
		const s = liveSession(ctx, makeSub({ liveEndGrace: true, liveEndGraceMinutes: 2 }));
		await s.onLiveEnd();

		expect(s.handleLiveEnd).not.toHaveBeenCalled();
		expect(clear).not.toHaveBeenCalled();
		expect(s.liveStatus).toBe(true);
		expect(emitLiveState).not.toHaveBeenCalled();
		expect(s.cancelPeriodicTimer).toHaveBeenCalledTimes(1);
		expect(captured.ms).toBe(2 * 60 * 1000);
	});

	it("挂起期内重新开播 → 接续:取消等待 + 恢复复推 + 不发开播卡 + 不 handleLiveEnd", async () => {
		const { ctx, captured, sendLiveNotifyCard } = makeCtx();
		const s = liveSession(ctx, makeSub({ liveEndGrace: true }));
		await s.onLiveEnd();
		expect(captured.cb).toBeDefined();

		await s.onLiveStart();

		expect(captured.dispose).toHaveBeenCalledTimes(1); // 等待计时器被取消
		expect(s.armPeriodicTimer).toHaveBeenCalled(); // 复推恢复
		expect(s.handleLiveEnd).not.toHaveBeenCalled();
		expect(sendLiveNotifyCard).not.toHaveBeenCalled(); // 接续不发开播卡
		expect(s.liveStatus).toBe(true);
	});

	it("等待到期且 B站仍离线 → handleLiveEnd(用定格 diffTime)", async () => {
		const { ctx } = makeCtx();
		const s = liveSession(ctx, makeSub({ liveEndGrace: true }));
		s.useLiveRoomInfo = vi.fn(async () => true);
		await s.onLiveEnd();
		s.liveRoomInfo = { live_status: 0 }; // 离线

		await s.onGraceExpiry();

		expect(s.handleLiveEnd).toHaveBeenCalledTimes(1);
		expect(s.handleLiveEnd).toHaveBeenCalledWith("grace", "3小时");
	});

	it("等待到期但 B站已重开(漏帧)→ 不下播,恢复复推", async () => {
		const { ctx } = makeCtx();
		const s = liveSession(ctx, makeSub({ liveEndGrace: true }));
		s.useLiveRoomInfo = vi.fn(async () => true);
		await s.onLiveEnd();
		s.liveRoomInfo = { live_status: 1 }; // 已重新开播

		await s.onGraceExpiry();

		expect(s.handleLiveEnd).not.toHaveBeenCalled();
		expect(s.armPeriodicTimer).toHaveBeenCalled();
	});
});
