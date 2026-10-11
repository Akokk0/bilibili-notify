/**
 * 直播会话往问题表报什么、什么时候清。
 *
 * 之前直播引擎自己私聊主人(三处「这个房间不监听了」、一处「已下播没收到下播事件」),现在改报上报器:
 * - 房间不监听了 → 订阅级 `live_monitor_stopped`(取信息失败、弹幕连接没建起来、重连用尽),
 *   受限房 → `live_room_restricted`,都是 lasting;
 * - 预检被风控拦 → `live:<uid>` 这一路的风控;这一路下一次结果不是风控拦截(成功、别的失败)就清,
 *   会话结束(cancel)也清;
 * - 房间重新监听上了 → 普通的清(补「已恢复」);「已下播没收到下播事件」只留 warn。
 *
 * 用**真上报器 + 记录用的假核心**测「压没压、清没清」:假上报器看不出分层压不压。
 */

import type { ServiceContext } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { PROBLEM_TEXTS } from "../../../problem-texts";
import type { SubItemView } from "../../push-like";
import { MONITOR_STOPPED_CODE, ROOM_RESTRICTED_CODE } from "../room-context";
import {
	LiveRoomAccessDeniedError,
	LiveRoomPreflightBlockedError,
	type RoomContext,
} from "../room-helpers";
import { RoomSession } from "../room-session";
import {
	expectedRestrictedFailure,
	expectedStoppedFailure,
	liveProblemsCtx,
	makeLiveProblems,
	makeRecordingLayers,
} from "./support/live-problems";

function makeSub(): SubItemView {
	return {
		subscriptionId: "sub-1",
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
		liveStreaming: false,
	} as unknown as SubItemView;
}

/** 房间信息:已下播(live_status 0),够 bootstrap 走完。 */
const ROOM = { uid: 1, live_status: 0, live_time: "2026-01-01 10:00:00" };

type Problems =
	| ReturnType<typeof makeLiveProblems>
	| ReturnType<typeof makeRecordingLayers>["layers"];

function makeCtx(problems: Problems) {
	const scheduled: Array<() => void> = [];
	const warns: string[] = [];
	const serviceCtx: ServiceContext = {
		logger: {
			debug() {},
			info() {},
			warn: (m: string) => void warns.push(m),
			error() {},
		},
		setInterval: vi.fn(),
		setTimeout: (fn) => {
			scheduled.push(fn);
			return { dispose() {} };
		},
		onDispose: () => {},
		signal: new AbortController().signal,
		track: () => {},
	};
	const mocks = {
		startLiveRoomListener: vi.fn(async () => true),
		getLiveRoomInfo: vi.fn(async () => ({ ...ROOM }) as unknown),
		stopMonitoring: vi.fn(),
		closeListener: vi.fn(),
		emitEngineError: vi.fn(),
		scheduled,
		warns,
		/** 一次只跑队列里排着的那一批 sleep 回调(逐步驱动重连)。 */
		step: async () => {
			const batch = [...scheduled];
			scheduled.length = 0;
			for (const fn of batch) fn();
			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));
		},
		flushAll: async (maxIters = 50) => {
			for (let i = 0; i < maxIters && scheduled.length > 0; i++) await mocks.step();
		},
	};
	const ctx = {
		serviceCtx,
		logger: serviceCtx.logger,
		isDisposed: () => false,
		config: {},
		livePushTimerManager: new Map<string, () => void>(),
		logSideEffectState: () => {},
		danmakuCollector: { clear: () => {}, registerRoom: () => {} },
		push: { push: async () => {} },
		templateRenderer: {
			renderLiveStart: () => "开播啦",
			renderLiveStreaming: () => "正在直播",
			renderLiveEnd: () => "下播啦",
		},
		isSubscribed: () => false,
		getMasterInfo: async () => ({
			username: "U1",
			userface: "",
			roomId: "r1",
			liveOpenFollowerNum: 1,
			liveEndFollowerNum: 1,
			liveFollowerChange: 0,
		}),
		emitLiveState: vi.fn(),
		emitEngineError: mocks.emitEngineError,
		closeListener: mocks.closeListener,
		stopMonitoring: mocks.stopMonitoring,
		getLiveRoomInfo: mocks.getLiveRoomInfo,
		startLiveRoomListener: mocks.startLiveRoomListener,
		...liveProblemsCtx(problems),
	} as unknown as RoomContext;
	return { ctx, mocks };
}

const blocked = () => new LiveRoomPreflightBlockedError("B 站返回 code=-352");

describe("预检被风控拦:按 live:<uid> 一路报,这一路下一次结果不是风控拦截就清", () => {
	it("bootstrap 被拦:报 live:u1 的风控;长尾重试连上了:清掉", async () => {
		const problems = makeLiveProblems();
		const { ctx, mocks } = makeCtx(problems);
		mocks.startLiveRoomListener.mockRejectedValueOnce(blocked()).mockResolvedValue(true);
		const session = new RoomSession(ctx, makeSub());

		await session.bootstrap();
		expect(problems.reportRisk).toHaveBeenCalledWith("live:u1");
		expect(problems.resolveRisk).not.toHaveBeenCalled();

		await mocks.flushAll();
		expect(problems.resolveRisk).toHaveBeenCalledWith("live:u1");
	});

	it("bootstrap 没被拦(连上了):先清这一路的风控", async () => {
		const problems = makeLiveProblems();
		const { ctx } = makeCtx(problems);
		await new RoomSession(ctx, makeSub()).bootstrap();
		expect(problems.resolveRisk).toHaveBeenCalledWith("live:u1");
		expect(problems.reportRisk).not.toHaveBeenCalled();
	});

	// 验红:删掉 room-session.ts 重连循环里 catch 之后那句 `this.resolveRisk()`,这条红(风控被一路留到会话结束)。
	it("风控之后同一路换了方式失败(预检过了但建连回假):风控当场清掉,不等会话结束", async () => {
		const { layers, present } = makeRecordingLayers();
		const { ctx, mocks } = makeCtx(layers);
		mocks.startLiveRoomListener.mockRejectedValueOnce(blocked()).mockResolvedValue(false);
		const session = new RoomSession(ctx, makeSub());

		await session.bootstrap(); // 预检被拦 → 长尾
		expect(present()).toEqual(["risk_controlled"]);

		await mocks.step(); // 长尾到点:这一次预检过了、建连回假
		expect(present()).toEqual([]);
	});

	it("风控之后建连一路失败直到五档用完:表里最终是这个房间的「停止监听」", async () => {
		const { layers, present } = makeRecordingLayers();
		const { ctx, mocks } = makeCtx(layers);
		mocks.startLiveRoomListener.mockRejectedValueOnce(blocked()).mockResolvedValue(false);
		const session = new RoomSession(ctx, makeSub());

		await session.bootstrap();
		await mocks.flushAll();

		expect(present()).toEqual([`u1:${MONITOR_STOPPED_CODE}`]);
	});

	it("cancel():这一路挂着的风控清掉(会话结束)", async () => {
		const problems = makeLiveProblems();
		const { ctx, mocks } = makeCtx(problems);
		mocks.startLiveRoomListener.mockRejectedValue(blocked());
		const session = new RoomSession(ctx, makeSub());
		await session.bootstrap();
		problems.resolveRisk.mockClear();

		session.cancel();
		expect(problems.resolveRisk).toHaveBeenCalledWith("live:u1");
	});

	it("重连途中又被拦:再报一次(幂等),不当作新的一路", async () => {
		const problems = makeLiveProblems();
		const { ctx, mocks } = makeCtx(problems);
		mocks.startLiveRoomListener.mockRejectedValue(blocked());
		const session = new RoomSession(ctx, makeSub());
		await session.bootstrap();
		await mocks.step();
		expect(problems.reportRisk.mock.calls.map((c) => c[0])).toEqual(["live:u1", "live:u1"]);
	});
});

describe("受限房:报 live_room_restricted,不跑退避", () => {
	it("bootstrap 遇到受限房:先清风控、再报受限房(lasting、带文案里的 notify 与恢复说法)", async () => {
		const problems = makeLiveProblems();
		const { ctx, mocks } = makeCtx(problems);
		const denied = new LiveRoomAccessDeniedError("B 站返回 code=-400 message=room is encrypted");
		mocks.startLiveRoomListener.mockRejectedValue(denied);

		await new RoomSession(ctx, makeSub()).bootstrap();

		expect(problems.resolveRisk).toHaveBeenCalledWith("live:u1");
		expect(problems.reportFailure).toHaveBeenCalledTimes(1);
		expect(problems.reportFailure).toHaveBeenCalledWith(
			expectedRestrictedFailure("u1", "r1", denied.message),
		);
		expect(problems.reportFailure.mock.calls[0]?.[0].code).toBe(ROOM_RESTRICTED_CODE);
		expect(mocks.stopMonitoring).toHaveBeenCalledWith(denied.message, "r1");
		expect(mocks.emitEngineError).not.toHaveBeenCalled();
	});

	it("重连时遇到受限房:报受限房,停监测", async () => {
		const problems = makeLiveProblems();
		const { ctx, mocks } = makeCtx(problems);
		const denied = new LiveRoomAccessDeniedError("B 站返回 code=-400 message=room is encrypted");
		mocks.startLiveRoomListener.mockRejectedValue(denied);
		const session = new RoomSession(ctx, makeSub());

		// biome-ignore lint/suspicious/noExplicitAny: 测试 private 方法
		void (session as any).onError();
		await mocks.flushAll();

		expect(problems.reportFailure).toHaveBeenCalledWith(
			expectedRestrictedFailure("u1", "r1", denied.message),
		);
		expect(mocks.stopMonitoring).toHaveBeenCalledTimes(1);
	});
});

describe("房间不监听了:报 live_monitor_stopped(lasting),原因各取一条", () => {
	it("弹幕连接没建起来(startLiveRoomListener 回假):原因是「弹幕连接建立失败」", async () => {
		const problems = makeLiveProblems();
		const { ctx, mocks } = makeCtx(problems);
		mocks.startLiveRoomListener.mockResolvedValue(false);

		await new RoomSession(ctx, makeSub()).bootstrap();

		expect(problems.reportFailure).toHaveBeenCalledTimes(1);
		expect(problems.reportFailure).toHaveBeenCalledWith(
			expectedStoppedFailure("u1", "r1", PROBLEM_TEXTS.liveStopReasons.danmakuConnect),
		);
		expect(mocks.closeListener).toHaveBeenCalledWith("r1");
	});

	it("连上后首次取房间信息失败:原因是「取直播间信息失败」", async () => {
		const problems = makeLiveProblems();
		const { ctx, mocks } = makeCtx(problems);
		mocks.getLiveRoomInfo.mockResolvedValue(undefined);

		await new RoomSession(ctx, makeSub()).bootstrap();

		expect(problems.reportFailure).toHaveBeenCalledWith(
			expectedStoppedFailure("u1", "r1", PROBLEM_TEXTS.liveStopReasons.roomInfo),
		);
		expect(mocks.closeListener).toHaveBeenCalledWith("r1");
	});

	it("重连五档用完放弃:原因是「连接持续失败，重试 5 次后放弃」,不走组件告警", async () => {
		const problems = makeLiveProblems();
		const { ctx, mocks } = makeCtx(problems);
		mocks.startLiveRoomListener.mockResolvedValue(false);
		const session = new RoomSession(ctx, makeSub());

		// biome-ignore lint/suspicious/noExplicitAny: 测试 private 方法
		void (session as any).onError();
		await mocks.flushAll();

		expect(problems.reportFailure).toHaveBeenCalledTimes(1);
		expect(problems.reportFailure).toHaveBeenCalledWith(
			expectedStoppedFailure("u1", "r1", PROBLEM_TEXTS.liveStopReasons.gaveUp),
		);
		expect(mocks.emitEngineError).not.toHaveBeenCalled();
	});

	it("房间重新监听上了(初始房态拉到):普通的清「停止监听」(不带 notify),受限房同理在弹幕连上时清", async () => {
		const problems = makeLiveProblems();
		const { ctx } = makeCtx(problems);

		await new RoomSession(ctx, makeSub()).bootstrap();

		expect(problems.resolveFailure).toHaveBeenCalledWith({
			externalId: "u1",
			code: MONITOR_STOPPED_CODE,
		});
		expect(problems.resolveFailure).toHaveBeenCalledWith({
			externalId: "u1",
			code: ROOM_RESTRICTED_CODE,
		});
		// 都是普通的清:第二个参数(notify: false)一个都不带
		expect(problems.resolveFailure.mock.calls.every((c) => c.length === 1)).toBe(true);
	});

	it("连不上的房间不清「停止监听」(还没监听上)", async () => {
		const problems = makeLiveProblems();
		const { ctx, mocks } = makeCtx(problems);
		mocks.startLiveRoomListener.mockResolvedValue(false);

		await new RoomSession(ctx, makeSub()).bootstrap();

		expect(problems.resolveFailure).not.toHaveBeenCalledWith({
			externalId: "u1",
			code: MONITOR_STOPPED_CODE,
		});
	});
});

describe("周期复推那一拍", () => {
	// biome-ignore lint/suspicious/noExplicitAny: 测试 protected 方法
	type AnySession = any;

	it("取房间信息失败:报「停止监听」并停监测", async () => {
		const problems = makeLiveProblems();
		const { ctx, mocks } = makeCtx(problems);
		mocks.getLiveRoomInfo.mockResolvedValue(undefined);
		const session = new RoomSession(ctx, makeSub()) as AnySession;

		await session.tickPushAtTime();

		expect(problems.reportFailure).toHaveBeenCalledWith(
			expectedStoppedFailure("u1", "r1", PROBLEM_TEXTS.liveStopReasons.roomInfo),
		);
		expect(mocks.stopMonitoring).toHaveBeenCalledTimes(1);
	});

	// 验红:删掉 room-session-base.ts handleLiveEnd 里取信息失败那一支的 `this.reportStopped(…)`,这条红。
	it("下播时取房间信息失败:报「停止监听」并停监测", async () => {
		const problems = makeLiveProblems();
		const { ctx, mocks } = makeCtx(problems);
		mocks.getLiveRoomInfo.mockResolvedValue(undefined);
		const session = new RoomSession(ctx, makeSub()) as AnySession;
		session.liveStatus = true;

		await session.handleLiveEnd("ws");

		expect(problems.reportFailure).toHaveBeenCalledWith(
			expectedStoppedFailure("u1", "r1", PROBLEM_TEXTS.liveStopReasons.roomInfo),
		);
		expect(mocks.stopMonitoring).toHaveBeenCalledTimes(1);
	});

	it("发现已下播却没收到下播事件:只记一行 warn,不报问题、不私聊,照常进下播处理", async () => {
		const problems = makeLiveProblems();
		const { ctx, mocks } = makeCtx(problems);
		const session = new RoomSession(ctx, makeSub()) as AnySession;
		session.triggerLiveEnd = vi.fn(async () => {});

		await session.tickPushAtTime();

		expect(mocks.warns.some((w) => w.includes("已下播但未收到 onLiveEnd"))).toBe(true);
		expect(problems.reportFailure).not.toHaveBeenCalled();
		expect(session.triggerLiveEnd).toHaveBeenCalledWith("polling");
		// ctx.push 上只有 push:要是还去私聊主人,上面这个调用就抛了
	});
});
