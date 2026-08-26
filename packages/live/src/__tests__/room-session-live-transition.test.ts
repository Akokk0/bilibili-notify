/**
 * 单元测试 — 「翻成在播」的每一条通道,以及彻底放弃监听时的收口。
 *
 * 这一组守的是同一条不变量:**凡是先 await 网络、再把 `liveStatus` 翻成 true 的地方,
 * 那段窗口内到达的下播事件都必须被记账**。窗口里 `liveStatus` 还是 false,于是这条
 * END 会撞上 `handleLiveEnd` 的 `!liveStatus` 守卫被静默丢弃;我们随后又无条件翻成
 * 在播 —— 这一场从此再也等不到第二条 END,面板恒显「直播中」,统计侧按 now−startedAt
 * 计时长、每天自增 24 小时且无上限,而默认 `pushTime=0` 连轮询兜底都没有。
 *
 * 这个守卫最初只加在 `onLiveStart` 和重连核对两处,而通道其实有四条:
 *   - `bootstrap()` —— 装好 WS 到翻状态之间隔着刷房间/主播信息 + 卡片渲染推送,窗口最长
 *   - `onLiveEnd` 的 10s 冷却 —— 它在 `handleLiveEnd` **之前**就 return,记账代码根本走不到
 *   - 中止路径 —— 判定这一场已结束就直接返回,弹幕缓冲没人清,泄漏进下一场词云
 *   - 退避耗尽放弃 —— 干翻状态而不走下播流水线,周期定时器还挂着
 *
 * 每层自己的单测当时都是绿的,裂缝全在这些跨路径的不变量上,所以在这里逐条钉死。
 */

import type { LiveEvent } from "@bilibili-notify/blive";
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

const LIVE_ROOM = {
	uid: 1,
	room_id: 1,
	short_id: 0,
	live_status: 1,
	live_time: "2026-01-01 10:00:00",
	title: "标题",
	user_cover: "",
	keyframe: "",
	area_name: "分区",
};

const MASTER = {
	username: "U1",
	userface: "",
	roomId: "r1",
	liveOpenFollowerNum: 100,
	liveEndFollowerNum: 100,
	liveFollowerChange: 0,
};

function makeCtx(over: Partial<Record<string, unknown>> = {}) {
	/** 每个 setInterval 句柄的 dispose 计数 —— 周期复推定时器是否真被解除靠它判定。 */
	let intervalDisposes = 0;
	/** 退避 sleep 的 callback 队列,由测试手动驱动,不真等 1s/2s/4s…… */
	const scheduled: Array<() => void> = [];
	const fakeServiceCtx: ServiceContext = {
		logger: { debug() {}, info() {}, warn() {}, error() {} },
		setInterval: (() => ({
			dispose: () => {
				intervalDisposes++;
			},
		})) as ServiceContext["setInterval"],
		setTimeout: ((fn: () => void) => {
			scheduled.push(fn);
			return { dispose() {} };
		}) as ServiceContext["setTimeout"],
		onDispose: () => {},
	};

	const mocks = {
		emitLiveState: vi.fn(),
		emitEngineError: vi.fn(),
		sendLiveNotifyCard: vi.fn(async () => {}),
		clear: vi.fn(),
		registerRoom: vi.fn(),
		closeListener: vi.fn(),
		stopMonitoring: vi.fn(),
		sendPrivateMsg: vi.fn(async () => {}),
		getTimeDifference: vi.fn(async () => "3小时"),
		getLiveRoomInfo: vi.fn(async () => ({ ...LIVE_ROOM })),
		startLiveRoomListener: vi.fn(async () => true),
		intervalDisposes: () => intervalDisposes,
		/** 反复跑退避 sleep 的 callback 直到队列空 —— 把整条重连链一次性驱动完。 */
		flushAll: async (maxIters = 50) => {
			for (let i = 0; i < maxIters && scheduled.length > 0; i++) {
				const batch = [...scheduled];
				scheduled.length = 0;
				for (const fn of batch) fn();
				await new Promise((r) => setImmediate(r));
			}
		},
	};

	const ctx = {
		serviceCtx: fakeServiceCtx,
		logger: fakeServiceCtx.logger,
		isDisposed: () => false,
		config: {},
		livePushTimerManager: new Map<string, () => void>(),
		logSideEffectState: () => {},
		danmakuCollector: { clear: mocks.clear, registerRoom: mocks.registerRoom },
		push: { sendPrivateMsg: mocks.sendPrivateMsg, broadcastToTargets: async () => {} },
		templateRenderer: {
			renderLiveStart: () => "开播啦",
			renderLiveOngoing: () => "正在直播",
			renderLiveEnd: () => "下播啦",
		},
		isSubscribed: (_sub: SubItemView, kind: string) => kind === "liveEnd",
		getMasterInfo: async () => ({ ...MASTER }),
		emitLiveState: mocks.emitLiveState,
		emitEngineError: mocks.emitEngineError,
		sendLiveNotifyCard: mocks.sendLiveNotifyCard,
		closeListener: mocks.closeListener,
		stopMonitoring: mocks.stopMonitoring,
		getTimeDifference: mocks.getTimeDifference,
		getLiveRoomInfo: mocks.getLiveRoomInfo,
		startLiveRoomListener: mocks.startLiveRoomListener,
		...over,
	} as unknown as RoomContext;

	return { ctx, mocks };
}

/** 该 UP 被 emit 成「在播」的次数 —— 判定「有没有翻成在播」只看这个。 */
const liveEmits = (m: ReturnType<typeof vi.fn>) =>
	m.mock.calls.filter((c: unknown[]) => c[1] === "live").length;

/**
 * 事件漏斗在类型上返回 `void | Promise<void>` —— 测试要等这条事件真正跑完才能断言,
 * 否则断言会跑在事件处理之前。
 */
const dispatch = (r: unknown): Promise<void> => Promise.resolve(r as Promise<void> | undefined);
type EventFunnel = (ev: LiveEvent) => void | Promise<void>;

beforeEach(() => {
	vi.clearAllMocks();
});

describe("bootstrap() 期间到达的下播事件", () => {
	it("装好 WS 到翻状态之间收到 END → 不翻成在播", async () => {
		// 冷启动时 UP 正在播,而 bootstrap 还在刷房间信息 / 渲染推送「正在直播」卡片
		// 的这几秒里 UP 停播了。END 撞上守卫被丢弃,B 站也不会再发第二条;若这里仍
		// 无条件翻成在播,这个房间就永久停在「直播中」,统计侧每天平白多记 24 小时。
		const { ctx, mocks } = makeCtx();
		let handler: EventFunnel | undefined;
		mocks.startLiveRoomListener.mockImplementation(async (...args: unknown[]) => {
			handler = args[1] as EventFunnel;
			return true;
		});
		// 在翻状态之前的最后一段 await 里插进这条 END。
		mocks.getTimeDifference.mockImplementation(async () => {
			await dispatch(handler?.({ kind: "live-end" }));
			return "3小时";
		});

		const session = new RoomSession(ctx, makeSub()) as AnySession;
		await session.bootstrap();

		expect(session.isLive).toBe(false);
		expect(liveEmits(mocks.emitLiveState)).toBe(0);
	});

	it("中止时排空弹幕缓冲 —— 否则这几秒的弹幕会混进下一场词云", async () => {
		const { ctx, mocks } = makeCtx();
		let handler: EventFunnel | undefined;
		mocks.startLiveRoomListener.mockImplementation(async (...args: unknown[]) => {
			handler = args[1] as EventFunnel;
			return true;
		});
		mocks.getTimeDifference.mockImplementation(async () => {
			await dispatch(handler?.({ kind: "live-end" }));
			return "3小时";
		});

		const session = new RoomSession(ctx, makeSub()) as AnySession;
		await session.bootstrap();

		expect(mocks.clear).toHaveBeenCalledWith("r1");
	});

	it("期间真开播不能被去重吞掉 —— 否则换来一个反向的永久卡死", async () => {
		// 记账窗口若同时兼任 LIVE 去重闸门,就会出现:bootstrap 拉到 live_status=0
		// (还没开播),紧接着 UP 在这几秒里开播,那条 LIVE 被当成「重复事件」吞掉,
		// 而 bootstrap 自己也不会翻成在播 —— 房间永久停在「未直播」,和这一组要修的
		// 「永久停在直播中」正好凑成一对。去重是 onLiveStart 的重入守卫,不归 bootstrap 管。
		let handler: EventFunnel | undefined;
		let started: Promise<void> | undefined;
		// bootstrap 拉主播信息的这一刻 UP 开播了 —— 此时房间快照已是「未开播」,
		// 而 WS 已经在派发事件。
		const { ctx, mocks } = makeCtx({
			getMasterInfo: async () => {
				if (!started) {
					mocks.getLiveRoomInfo.mockResolvedValue({ ...LIVE_ROOM });
					started = dispatch(handler?.({ kind: "live-start" }));
				}
				return { ...MASTER };
			},
		});
		mocks.getLiveRoomInfo.mockResolvedValue({ ...LIVE_ROOM, live_status: 0 });
		mocks.startLiveRoomListener.mockImplementation(async (...args: unknown[]) => {
			handler = args[1] as EventFunnel;
			return true;
		});

		const session = new RoomSession(ctx, makeSub()) as AnySession;
		await session.bootstrap();
		await started;

		expect(session.isLive).toBe(true);
	});

	it("没有 END 时照常翻成在播 —— 守卫不能把正常路径也一并挡掉", async () => {
		const { ctx, mocks } = makeCtx();
		const session = new RoomSession(ctx, makeSub()) as AnySession;
		await session.bootstrap();

		expect(session.isLive).toBe(true);
		expect(liveEmits(mocks.emitLiveState)).toBe(1);
	});
});

describe("onLiveStart 准备期间到达的下播事件", () => {
	/** 起一个「WS 已装好、尚未开播」的 session,并把 handler 交出来供测试派发事件。 */
	async function readySession(sub = makeSub()) {
		const { ctx, mocks } = makeCtx();
		mocks.getLiveRoomInfo.mockResolvedValue({ ...LIVE_ROOM, live_status: 0 });
		let handler: EventFunnel | undefined;
		mocks.startLiveRoomListener.mockImplementation(async (...args: unknown[]) => {
			handler = args[1] as EventFunnel;
			return true;
		});
		const session = new RoomSession(ctx, sub) as AnySession;
		await session.bootstrap();
		expect(session.isLive).toBe(false);
		return { session, mocks, handler: handler as EventFunnel };
	}

	it("刷新房间信息期间收到 END → 不翻成在播", async () => {
		const { session, mocks, handler } = await readySession();
		mocks.getLiveRoomInfo.mockImplementation(async () => {
			await dispatch(handler({ kind: "live-end" }));
			return { ...LIVE_ROOM };
		});

		await dispatch(handler({ kind: "live-start" }));

		expect(session.isLive).toBe(false);
		expect(liveEmits(mocks.emitLiveState)).toBe(0);
	});

	it("落在 END 冷却期里的那条也算数 —— 冷却是给重复帧用的,不是给新一场用的", async () => {
		// 直播抖动:t=0 收到 END(正常处理完),t=3s 收到 LIVE(开播冷却已过,被接受,
		// 开始刷房间信息),t=8s 又来一条 END。第二条落在 10s 冷却窗口内,`onLiveEnd`
		// 在 `triggerLiveEnd` 之前就 return —— 而记账代码在 `handleLiveEnd` 里,根本走不到。
		const { session, mocks, handler } = await readySession();
		session.lastLiveEnd = Date.now(); // 刚处理过一条 END
		mocks.getLiveRoomInfo.mockImplementation(async () => {
			await dispatch(handler({ kind: "live-end" })); // 冷却期内的第二条
			return { ...LIVE_ROOM };
		});

		await dispatch(handler({ kind: "live-start" }));

		expect(session.isLive).toBe(false);
		expect(liveEmits(mocks.emitLiveState)).toBe(0);
	});

	it("中止时排空弹幕缓冲", async () => {
		const { session, mocks, handler } = await readySession();
		mocks.getLiveRoomInfo.mockImplementation(async () => {
			await dispatch(handler({ kind: "live-end" }));
			return { ...LIVE_ROOM };
		});

		await dispatch(handler({ kind: "live-start" }));

		expect(session.isLive).toBe(false);
		expect(mocks.clear).toHaveBeenCalledWith("r1");
	});

	it("没有 END 时照常开播并推卡", async () => {
		const { session, mocks, handler } = await readySession();
		await dispatch(handler({ kind: "live-start" }));

		expect(session.isLive).toBe(true);
		expect(liveEmits(mocks.emitLiveState)).toBe(1);
		expect(mocks.sendLiveNotifyCard).toHaveBeenCalled();
	});
});

describe("退避耗尽彻底放弃监听", () => {
	it("解除周期复推定时器 —— 否则轮询兜底每小时私聊一次且永不停", async () => {
		// 放弃路径把 `liveStatus` 翻成 false 但没解定时器:下一次 tick 看到 live_status===0,
		// 发一条「已下播但未收到 WS 下播事件」私聊,再调 triggerLiveEnd → handleLiveEnd
		// 却在 `!liveStatus` 守卫处提前返回,走不到解除定时器那行。于是同一条私聊每小时
		// 重复一次,直到进程重启。
		const { ctx, mocks } = makeCtx();
		mocks.startLiveRoomListener.mockRejectedValue(new Error("network down"));
		const session = new RoomSession(ctx, makeSub({ pushTime: 1 })) as AnySession;
		session.liveStatus = true;
		session.liveTime = LIVE_ROOM.live_time;
		session.armPeriodicTimer();
		expect(ctx.livePushTimerManager.size).toBe(1);

		const giveUp = session.reconnect("watchdog");
		await mocks.flushAll();
		await giveUp;

		expect(mocks.emitEngineError).toHaveBeenCalledTimes(1);
		expect(session.isLive).toBe(false);
		expect(mocks.intervalDisposes()).toBeGreaterThanOrEqual(1);
		expect(ctx.livePushTimerManager.size).toBe(0);
	});

	it("在播时放弃 → 走完整下播流水线,而不是干翻状态", async () => {
		// WS 死了,但 HTTP 还活着 —— 下播卡 / 词云 / 总结都还发得出来,弹幕缓冲也得排空。
		// 改这条路径之前,`pushTime` 非 0 的用户还能靠轮询兜底晚几小时收到下播卡;
		// 只翻状态不走流水线的话,这些人从此一条都收不到。
		const { ctx, mocks } = makeCtx();
		mocks.startLiveRoomListener.mockRejectedValue(new Error("network down"));
		mocks.getLiveRoomInfo.mockResolvedValue({ ...LIVE_ROOM, live_status: 0 });
		const session = new RoomSession(ctx, makeSub()) as AnySession;
		session.liveStatus = true;
		session.liveTime = LIVE_ROOM.live_time;

		const giveUp = session.reconnect("watchdog");
		await mocks.flushAll();
		await giveUp;

		expect(session.isLive).toBe(false);
		expect(mocks.sendLiveNotifyCard).toHaveBeenCalled();
		expect(mocks.clear).toHaveBeenCalledWith("r1");
	});

	it("下播流水线自己炸了也要收口成下播 —— 这是最后一道收尾,不能再抛", async () => {
		// watchdog 那条路是 `void this.reconnect(...)` 发起的,抛出去就是个没人接的
		// rejection,而状态停在 true —— 恰好变回我们要消灭的那个僵尸。
		const { ctx, mocks } = makeCtx();
		mocks.startLiveRoomListener.mockRejectedValue(new Error("network down"));
		mocks.getLiveRoomInfo.mockRejectedValue(new Error("HTTP 也挂了"));
		const session = new RoomSession(ctx, makeSub()) as AnySession;
		session.liveStatus = true;
		session.liveTime = LIVE_ROOM.live_time;

		const giveUp = session.reconnect("watchdog");
		await mocks.flushAll();
		await expect(giveUp).resolves.toBeUndefined();

		expect(session.isLive).toBe(false);
	});

	it("本就没在播时放弃 → 不推下播卡", async () => {
		const { ctx, mocks } = makeCtx();
		mocks.startLiveRoomListener.mockRejectedValue(new Error("network down"));
		const session = new RoomSession(ctx, makeSub()) as AnySession;

		const giveUp = session.reconnect("watchdog");
		await mocks.flushAll();
		await giveUp;

		expect(mocks.emitEngineError).toHaveBeenCalledTimes(1);
		expect(mocks.sendLiveNotifyCard).not.toHaveBeenCalled();
	});
});
