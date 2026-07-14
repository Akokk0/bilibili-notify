/**
 * 单元测试 — armPeriodicTimer 的 cancelled / disposed 守卫。
 *
 * 回归:teardown(stopForUid / disposeAll / auth-lost)与 in-flight onLiveStart /
 * bootstrap 交错时,session 已 cancel()(或 ctx 已 disposed),但 onLiveStart 恢复后
 * 仍走到 armPeriodicTimer —— 此前它不查 cancelled,会挂上一个孤儿 setInterval:session
 * 已从 sessionRecord 删除,这个 interval 却永远 tick(getLiveRoomInfo + '正在直播' 推送
 * 到已拆订阅),且 re-subscribe 时 livePushTimerManager.set 覆盖句柄 → 永久失联无法 dispose。
 *
 * 不变量:cancel() 之后 / ctx disposed 时,armPeriodicTimer 必须是 no-op(不建 interval、
 * 不写 livePushTimerManager)。
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
		pushTime: 1, // >0 → armPeriodicTimer 会真的建 interval
		restartPush: false,
		...over,
	} as SubItemView;
}

function makeCtx(opts?: { disposed?: boolean }) {
	const intervalDispose = vi.fn();
	const livePushTimerManager = new Map<string, () => void>();
	const fakeServiceCtx: ServiceContext = {
		logger: { debug() {}, info() {}, warn() {}, error() {} },
		setInterval: () => ({ dispose: intervalDispose }),
		setTimeout: (() => ({ dispose() {} })) as ServiceContext["setTimeout"],
		onDispose: () => {},
	};
	const ctx = {
		serviceCtx: fakeServiceCtx,
		logger: fakeServiceCtx.logger,
		isDisposed: () => opts?.disposed ?? false,
		livePushTimerManager,
		logSideEffectState: vi.fn(),
	} as unknown as RoomContext;
	return { ctx, livePushTimerManager };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("RoomSession.armPeriodicTimer — cancelled / disposed 守卫", () => {
	it("正常态 → arm 建 interval 并登记进 livePushTimerManager(正向对照)", () => {
		const { ctx, livePushTimerManager } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;

		s.armPeriodicTimer();

		expect(livePushTimerManager.has("r1")).toBe(true);
	});

	it("cancel() 之后 arm → no-op,不留孤儿 timer", () => {
		const { ctx, livePushTimerManager } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;

		// 模拟 teardown 抢在 in-flight onLiveStart 的 armPeriodicTimer 之前 cancel()。
		s.cancel();
		s.armPeriodicTimer();

		expect(livePushTimerManager.has("r1")).toBe(false);
	});

	it("ctx 已 disposed → arm 也 no-op", () => {
		const { ctx, livePushTimerManager } = makeCtx({ disposed: true });
		const s = new RoomSession(ctx, makeSub()) as AnySession;

		s.armPeriodicTimer();

		expect(livePushTimerManager.has("r1")).toBe(false);
	});
});
