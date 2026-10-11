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
import type { SubItemView } from "../../push-like";
import type { RoomContext } from "../room-helpers";
import { RoomSession } from "../room-session";
import { liveProblemsCtx, makeLiveProblems } from "./support/live-problems";

// biome-ignore lint/suspicious/noExplicitAny: 测试需访问 private/protected
type AnySession = any;

function makeSub(over: Partial<SubItemView> = {}): SubItemView {
	return {
		uid: "u1",
		uname: "U1",
		roomId: "r1",
		post: false,
		liveStart: true,
		liveEnd: true,
		membership: false,
		superchat: false,
		extras: { atAllPost: false, atAllLiveStart: true, wordcloud: false, liveSummary: false },
		target: {},
		customCardStyle: { enable: false },
		customLiveMsg: { enable: false },
		guardTemplate: { enabled: false, default: { template: "", imageUrl: "" }, tiers: {} },
		customLiveSummary: { enable: false },
		customSpecialDanmakuUsers: { enable: false, msgTemplate: "" },
		customSpecialUsersEnterTheRoom: { enable: false, msgTemplate: "" },
		liveStreaming: true, // 开着 → armPeriodicTimer 会真的建 interval
		streamingIntervalHours: 1,
		catchUpOnBoot: false,
		...over,
	} as SubItemView;
}

function makeCtx(opts?: { disposed?: boolean }) {
	const intervalDispose = vi.fn();
	/** 每次 setInterval 的间隔(毫秒),按建立的先后。 */
	const intervals: number[] = [];
	const livePushTimerManager = new Map<string, () => void>();
	const fakeServiceCtx: ServiceContext = {
		logger: { debug() {}, info() {}, warn() {}, error() {} },
		setInterval: ((_fn: () => void, ms: number) => {
			intervals.push(ms);
			return { dispose: intervalDispose };
		}) as ServiceContext["setInterval"],
		setTimeout: (() => ({ dispose() {} })) as ServiceContext["setTimeout"],
		onDispose: () => {},
		signal: new AbortController().signal,
		track: () => {},
	};
	const ctx = {
		serviceCtx: fakeServiceCtx,
		logger: fakeServiceCtx.logger,
		isDisposed: () => opts?.disposed ?? false,
		livePushTimerManager,
		logSideEffectState: vi.fn(),
		...liveProblemsCtx(makeLiveProblems()),
	} as unknown as RoomContext;
	return { ctx, livePushTimerManager, intervals, intervalDispose };
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

// ⑬d 直播拆键:周期「正在直播」有了自己的开关(`liveStreaming`)与间隔(`streamingIntervalHours`)。
// 拆键之前这头的计时只看间隔、**不看开关**:只开了下播、没开开播的订阅照样计时、出卡,
// 到推送闸才扔 —— 白打 B 站、白出图。现在开关开着才计时。
describe("RoomSession.armPeriodicTimer — 开关与间隔", () => {
	const HOUR = 60 * 60 * 1000;

	it("liveStreaming 关 → 不建 interval、不登记(关着不计时,更不出卡)", () => {
		const { ctx, livePushTimerManager, intervals } = makeCtx();
		const s = new RoomSession(ctx, makeSub({ liveStreaming: false })) as AnySession;

		s.armPeriodicTimer();

		expect(intervals).toEqual([]);
		expect(livePushTimerManager.has("r1")).toBe(false);
	});

	it("liveStreaming 开 → 按 streamingIntervalHours 小时建 interval", () => {
		const { ctx, livePushTimerManager, intervals } = makeCtx();
		const s = new RoomSession(
			ctx,
			makeSub({ liveStreaming: true, streamingIntervalHours: 3 }),
		) as AnySession;

		s.armPeriodicTimer();

		expect(intervals).toEqual([3 * HOUR]);
		expect(livePushTimerManager.has("r1")).toBe(true);
	});

	it("开着、却是 liveStart 关着:周期计时只看自己的开关,不连带开播那把", () => {
		const { ctx, intervals } = makeCtx();
		const s = new RoomSession(
			ctx,
			makeSub({ liveStart: false, liveStreaming: true, streamingIntervalHours: 2 }),
		) as AnySession;

		s.armPeriodicTimer();

		expect(intervals).toEqual([2 * HOUR]);
	});

	it("热更:在播时把开关关掉再 rearm → 拆掉旧的、不再建新的", () => {
		const { ctx, livePushTimerManager, intervals, intervalDispose } = makeCtx();
		const sub = makeSub({ liveStreaming: true, streamingIntervalHours: 1 });
		const s = new RoomSession(ctx, sub) as AnySession;
		s.liveStatus = true; // 直接赋值:这里的 ctx 没有 emitLiveState
		s.armPeriodicTimer();
		expect(intervals).toEqual([1 * HOUR]);

		sub.liveStreaming = false;
		s.rearmPeriodicTimer();

		expect(intervalDispose).toHaveBeenCalledTimes(1);
		expect(intervals).toEqual([1 * HOUR]); // 没有第二次 setInterval
		expect(livePushTimerManager.has("r1")).toBe(false);
	});

	it("热更:在播时把开关从关打开再 rearm → 这时才开始计时", () => {
		const { ctx, livePushTimerManager, intervals } = makeCtx();
		const sub = makeSub({ liveStreaming: false });
		const s = new RoomSession(ctx, sub) as AnySession;
		s.liveStatus = true; // 直接赋值:这里的 ctx 没有 emitLiveState
		s.armPeriodicTimer();
		expect(intervals).toEqual([]);

		sub.liveStreaming = true;
		sub.streamingIntervalHours = 4;
		s.rearmPeriodicTimer();

		expect(intervals).toEqual([4 * HOUR]);
		expect(livePushTimerManager.has("r1")).toBe(true);
	});

	it("热更:间隔改了 → 旧的拆掉、按新间隔重建", () => {
		const { ctx, intervals, intervalDispose } = makeCtx();
		const sub = makeSub({ liveStreaming: true, streamingIntervalHours: 1 });
		const s = new RoomSession(ctx, sub) as AnySession;
		s.liveStatus = true; // 直接赋值:这里的 ctx 没有 emitLiveState
		s.armPeriodicTimer();

		sub.streamingIntervalHours = 6;
		s.rearmPeriodicTimer();

		expect(intervalDispose).toHaveBeenCalledTimes(1);
		expect(intervals).toEqual([1 * HOUR, 6 * HOUR]);
	});
});
