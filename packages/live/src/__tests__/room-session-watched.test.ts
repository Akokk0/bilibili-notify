/**
 * B 站「收到观看人数」那一段 —— 今天的行为(1.0 第 2 期 ㉒a,2026-10-05)。
 *
 * B 站 WS 的 `WATCHED_CHANGE` 帧由 `RoomSession` 的事件漏斗接住(`case "watched"`),落到五个地方:
 * 直播数据里的 `watchedNum`、总线事件(经 `ctx.emitViewers`,两秒节流)、在播快照的 `viewers`,以及
 * 「正在直播」文案与下播卡里的累计观看。这一段此前零覆盖。
 *
 * 钉的是**今天**的样子:存进去的是 B 站现成的字符串 `text_small`(不是数字 `num`),缺数时「暂未获取到」
 * 会被**写回**直播数据。㉒d 把观看人数改成数字、把这句从直播数据里拿掉时,这里的断言跟着翻;翻之前它们
 * 就是「原来是什么样」的账。
 *
 * 策略:沿用 `room-session-handlers.test.ts` 的 plain-object-as-RoomContext 做法,
 * 事件直接喂 `buildEventHandler()` 给出的漏斗;钟只假 `Date`(节流读 `Date.now()`)。
 */

import type { LiveEvent } from "@bilibili-notify/blive";
import type { ServiceContext } from "@bilibili-notify/internal";
import { defaultMessageKindLayout } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { liveCardInputFromRoomInfo } from "../live-card-input";
import type { SubItemView } from "../push-like";
import type { RoomContext } from "../room-helpers";
import { RoomSession } from "../room-session";

// biome-ignore lint/suspicious/noExplicitAny: 测试需访问 private/protected
type AnySession = any;

/** 暂无观看人数时写回直播数据的那句 —— 今天就是这个字面量。 */
const NOT_FETCHED = "暂未获取到";

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
		customGuardBuy: { enable: false },
		customLiveSummary: { enable: false },
		customSpecialDanmakuUsers: { enable: false, msgTemplate: "" },
		customSpecialUsersEnterTheRoom: { enable: false, msgTemplate: "" },
		minScPrice: 0,
		minGuardLevel: 3,
		liveStreaming: false,
		streamingIntervalHours: 1,
		catchUpOnBoot: false,
		messageLayout: defaultMessageKindLayout("live"),
		...over,
	} as SubItemView;
}

interface Mocks {
	emitViewers: ReturnType<typeof vi.fn>;
	renderLiveStreaming: ReturnType<typeof vi.fn>;
	sendLiveNotifyCard: ReturnType<typeof vi.fn>;
	isSubscribed: ReturnType<typeof vi.fn>;
	/** 每次 `sendLiveNotifyCard` 被调用的那一刻,直播数据里 `watchedNum` 是什么(引用是同一个对象,事后读会变)。 */
	watchedWhenPushed: unknown[];
}

function makeCtx(): { ctx: RoomContext; m: Mocks } {
	const fakeServiceCtx: ServiceContext = {
		logger: { debug() {}, info() {}, warn() {}, error() {} },
		setInterval: () => ({ dispose() {} }),
		setTimeout: () => ({ dispose() {} }),
		onDispose: () => {},
		signal: new AbortController().signal,
		track: () => {},
	};
	const watchedWhenPushed: unknown[] = [];
	const m: Mocks = {
		emitViewers: vi.fn(),
		renderLiveStreaming: vi.fn(() => "直播中"),
		sendLiveNotifyCard: vi.fn(async (p: { liveData: { watchedNum?: unknown } }) => {
			watchedWhenPushed.push(p.liveData.watchedNum);
		}),
		isSubscribed: vi.fn(() => false),
		watchedWhenPushed,
	};
	const ctx = {
		serviceCtx: fakeServiceCtx,
		logger: fakeServiceCtx.logger,
		isDisposed: () => false,
		config: { customGuardBuy: { enable: false }, customLiveMsg: { enable: false } },
		templateRenderer: {
			renderLiveStart: vi.fn(() => "开播啦"),
			renderLiveStreaming: m.renderLiveStreaming,
			renderLiveEnd: vi.fn(() => "下播了"),
		},
		danmakuCollector: { clear: vi.fn(), registerRoom: vi.fn() },
		isSubscribed: m.isSubscribed,
		collectsDanmaku: vi.fn(() => false),
		sendLiveNotifyCard: m.sendLiveNotifyCard,
		stopMonitoring: vi.fn(),
		emitLiveState: vi.fn(),
		emitEngineError: vi.fn(),
		emitViewers: m.emitViewers,
		pickBackground: vi.fn(() => undefined),
	} as unknown as RoomContext;
	return { ctx, m };
}

/** 一帧 `WATCHED_CHANGE`:`num` 是精确数,`textSmall` 是 B 站排好的「1.2万」。 */
function watched(num: number, textSmall: string): LiveEvent {
	return { kind: "watched", num, textSmall };
}

/** 事件漏斗(`buildEventHandler` 是 protected,测试经 any 取)。 */
function funnelOf(s: AnySession): (ev: LiveEvent) => void {
	return s.buildEventHandler();
}

/** 把会话摆成「在播」:房间 / 主播信息桩好,`tickPushAtTime` 与 `bootstrapRoomState` 都读得到。 */
function primeLiveRoom(s: AnySession): void {
	s.useLiveRoomInfo = vi.fn(async () => {
		s.liveRoomInfo = {
			live_time: "2026-01-01 00:00:00",
			live_status: 1,
			short_id: 0,
			room_id: 12345,
			title: "标题",
			user_cover: "",
		};
		return true;
	});
	s.useMasterInfo = vi.fn(async () => {
		s.masterInfo = {
			username: "主播",
			userface: "",
			roomId: "r1",
			liveOpenFollowerNum: 100,
			liveEndFollowerNum: 100,
			liveFollowerChange: 0,
		};
		return true;
	});
	s.onListenerStarted = vi.fn();
	s.armPeriodicTimer = vi.fn();
}

// 节流用 `Date.now()`,且 `lastViewersEmitMs` 初值是 0 —— 系统钟要设在 2 秒以后,第一帧才发得出去。
const T0 = 100_000;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(T0);
});

afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe("WATCHED_CHANGE 帧 · 存进直播数据的值", () => {
	/**
	 * 存的是 `text_small` 那句 B 站排好的字符串,**不是**精确数 `num`。㉒d 要把它翻成数字。
	 * 验红:把 `case "watched"` 里的 `ev.textSmall` 换成 `String(ev.num)`,这条红。
	 */
	it("存的是 text_small 的字符串,不是 num", () => {
		const { ctx } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		funnelOf(s)(watched(12_345, "1.2万"));
		expect(s.liveData.watchedNum).toBe("1.2万");
	});

	it("每一帧都存(哪怕这一帧被总线节流掉了),最新一帧胜出", () => {
		const { ctx } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		const handler = funnelOf(s);
		handler(watched(8_000, "8000"));
		handler(watched(9_500, "9500"));
		handler(watched(12_345, "1.2万"));
		expect(s.liveData.watchedNum).toBe("1.2万");
	});
});

describe("WATCHED_CHANGE 帧 · 总线事件(emitViewers)的两秒节流", () => {
	/**
	 * 实参是 `(uid, 那句字符串)`。
	 * 验红:把 `emitViewers(this.sub.uid, ev.textSmall)` 的第二个实参换成 `String(ev.num)`,这条红。
	 */
	it("第一帧就发,实参是 (uid, text_small)", () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(ctx, makeSub({ uid: "u7" })) as AnySession;
		funnelOf(s)(watched(12_345, "1.2万"));
		expect(m.emitViewers).toHaveBeenCalledTimes(1);
		expect(m.emitViewers).toHaveBeenCalledWith("u7", "1.2万");
	});

	/**
	 * 验红:把 `VIEWERS_EMIT_THROTTLE_MS` 改成 0,「同一刻连来几帧」那条红;改成 5000,「恰好两秒」那条红;
	 * 把 `>=` 改成 `>`,「恰好两秒」那条红。
	 */
	it("两秒内连来几帧只发一次(发的是最早那帧),每一帧都存", () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		const handler = funnelOf(s);
		handler(watched(1, "A"));
		handler(watched(2, "B"));
		handler(watched(3, "C"));
		expect(m.emitViewers).toHaveBeenCalledTimes(1);
		expect(m.emitViewers).toHaveBeenCalledWith("u1", "A");
		expect(s.liveData.watchedNum).toBe("C");
	});

	it("差 1 毫秒满两秒还不发,恰好两秒发(含边界),发的是那一帧自己的值", () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		const handler = funnelOf(s);
		handler(watched(1, "A"));

		vi.setSystemTime(T0 + 1_999);
		handler(watched(2, "B"));
		expect(m.emitViewers).toHaveBeenCalledTimes(1);
		expect(s.liveData.watchedNum).toBe("B");

		vi.setSystemTime(T0 + 2_000);
		handler(watched(3, "C"));
		expect(m.emitViewers.mock.calls).toEqual([
			["u1", "A"],
			["u1", "C"],
		]);
	});

	it("节流窗口从**上一次发出**算起,不是从上一帧收到算起", () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		const handler = funnelOf(s);
		handler(watched(1, "A")); // t=0 发
		vi.setSystemTime(T0 + 1_500);
		handler(watched(2, "B")); // 被节流;若窗口按"上一帧收到"重算,下一帧要等到 3500
		vi.setSystemTime(T0 + 2_100);
		handler(watched(3, "C")); // 距上次发出 2100ms,发
		expect(m.emitViewers.mock.calls).toEqual([
			["u1", "A"],
			["u1", "C"],
		]);
	});

	/** 门控是每个会话(每个 UID)各管各的:甲刚发过,不挡乙。验红:把 `lastViewersEmitMs` 改成模块级变量,这条红。 */
	it("每个 UID 各管各的节流:同一刻两个房间各发一次", () => {
		const a = makeCtx();
		const b = makeCtx();
		const sa = new RoomSession(a.ctx, makeSub({ uid: "ua", roomId: "ra" })) as AnySession;
		const sb = new RoomSession(b.ctx, makeSub({ uid: "ub", roomId: "rb" })) as AnySession;
		funnelOf(sa)(watched(1, "甲"));
		funnelOf(sb)(watched(2, "乙"));
		expect(a.m.emitViewers).toHaveBeenCalledWith("ua", "甲");
		expect(b.m.emitViewers).toHaveBeenCalledWith("ub", "乙");
	});
});

describe("getLiveSnapshot().viewers", () => {
	it("还没收到过帧 → undefined(面板显示「—」)", () => {
		const { ctx } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		expect(s.getLiveSnapshot().viewers).toBeUndefined();
	});

	/** 回的是 B 站排好的字符串,不是数字。验红:让 `viewers` 回 `undefined` 或回 num,这条红。 */
	it("收到帧之后回 text_small 那句字符串", () => {
		const { ctx } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		funnelOf(s)(watched(12_345, "1.2万"));
		expect(s.getLiveSnapshot().viewers).toBe("1.2万");
	});

	/**
	 * 类型允许直播数据里放数字(`LiveData.watchedNum?: string | number`),生产里没有人这样写;
	 * 快照那头仍替它兜了一道 `String()`。验红:去掉那道 `typeof w === "number"` 的转换,这条红。
	 */
	it("直播数据里若是数字 → 转成字符串", () => {
		const { ctx } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		s.liveData.watchedNum = 300;
		expect(s.getLiveSnapshot().viewers).toBe("300");
	});

	/** 「暂未获取到」是写回直播数据的占位,不是观看人数 —— 快照把它滤成 undefined。 */
	it("直播数据里是「暂未获取到」→ undefined(占位不当人数)", () => {
		const { ctx } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		s.liveData.watchedNum = NOT_FETCHED;
		expect(s.getLiveSnapshot().viewers).toBeUndefined();
	});
});

describe("{watched} 缺数时把「暂未获取到」写回直播数据 · 周期「正在直播」(tickPushAtTime)", () => {
	/**
	 * 验红:删掉 `tickPushAtTime` 里 `this.liveData.watchedNum = watched` 那行,本组头两条与下播卡那条红;
	 * 把兜底字面量改成别的,同样这三条红。
	 */
	it("一帧都没收到:文案收到「暂未获取到」,直播数据被写成同一句,推卡时带着它", async () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		primeLiveRoom(s);
		expect(s.liveData.watchedNum).toBeUndefined();

		await s.tickPushAtTime();

		expect(m.renderLiveStreaming.mock.calls[0]?.[0]).toMatchObject({ watched: NOT_FETCHED });
		expect(s.liveData.watchedNum).toBe(NOT_FETCHED);
		expect(m.watchedWhenPushed).toEqual([NOT_FETCHED]);
	});

	it("写回之后在播快照把占位滤掉:viewers 仍是 undefined", async () => {
		const { ctx } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		primeLiveRoom(s);
		await s.tickPushAtTime();
		expect(s.liveData.watchedNum).toBe(NOT_FETCHED);
		expect(s.getLiveSnapshot().viewers).toBeUndefined();
	});

	it("收到过帧:文案和推卡拿的都是那句真值,不写回", async () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		primeLiveRoom(s);
		funnelOf(s)(watched(12_345, "1.2万"));

		await s.tickPushAtTime();

		expect(m.renderLiveStreaming.mock.calls[0]?.[0]).toMatchObject({ watched: "1.2万" });
		expect(s.liveData.watchedNum).toBe("1.2万");
		expect(m.watchedWhenPushed).toEqual(["1.2万"]);
	});

	/** 占位不粘在直播数据上:之后来一帧真值,它就被覆盖。 */
	it("写回之后再来一帧真值 → 被真值覆盖,快照也回得出来", async () => {
		const { ctx } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		primeLiveRoom(s);
		await s.tickPushAtTime();
		funnelOf(s)(watched(12_345, "1.2万"));
		expect(s.liveData.watchedNum).toBe("1.2万");
		expect(s.getLiveSnapshot().viewers).toBe("1.2万");
	});
});

describe("{watched} 缺数时把「暂未获取到」写回直播数据 · 启动时发现正在播(bootstrapRoomState)", () => {
	/**
	 * 写回发生在判断「要不要补报」**之前**:`catchUpOnBoot` 关着、一张卡都不发,直播数据也已经被写了。
	 * 验红:删掉 `bootstrapRoomStateInner` 里 `this.liveData.watchedNum = watched` 那行,这一条与下一条红。
	 */
	it("没开重启补报也写回(不发卡,文案照算)", async () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(ctx, makeSub({ catchUpOnBoot: false })) as AnySession;
		primeLiveRoom(s);

		expect(await s.bootstrapRoomState()).toBe(true);

		expect(m.sendLiveNotifyCard).not.toHaveBeenCalled();
		expect(m.renderLiveStreaming.mock.calls[0]?.[0]).toMatchObject({ watched: NOT_FETCHED });
		expect(s.liveData.watchedNum).toBe(NOT_FETCHED);
		expect(s.getLiveSnapshot().viewers).toBeUndefined();
	});

	it("开了重启补报:补报的那张卡带着被写回的占位", async () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(ctx, makeSub({ catchUpOnBoot: true })) as AnySession;
		primeLiveRoom(s);

		await s.bootstrapRoomState();

		expect(m.watchedWhenPushed).toEqual([NOT_FETCHED]);
	});

	it("启动前已经收到过帧(重连补跑的情形):用真值,不写回", async () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(ctx, makeSub({ catchUpOnBoot: true })) as AnySession;
		primeLiveRoom(s);
		funnelOf(s)(watched(12_345, "1.2万"));

		await s.bootstrapRoomState();

		expect(m.renderLiveStreaming.mock.calls[0]?.[0]).toMatchObject({ watched: "1.2万" });
		expect(s.liveData.watchedNum).toBe("1.2万");
		expect(m.watchedWhenPushed).toEqual(["1.2万"]);
	});
});

describe("下播卡的累计观看取自同一份直播数据", () => {
	function primeStopBroadcast(s: AnySession): void {
		s.liveStatus = true;
		primeLiveRoom(s);
		s.dispatchWordCloudAndSummary = vi.fn(async () => {});
	}

	it("收到过帧:下播卡拿到那句真值", async () => {
		const { ctx, m } = makeCtx();
		m.isSubscribed.mockReturnValue(true);
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		primeStopBroadcast(s);
		funnelOf(s)(watched(31_200, "3.1万"));

		await s.handleLiveEnd("ws");

		expect(m.watchedWhenPushed).toEqual(["3.1万"]);
	});

	/**
	 * 「正在直播」周期复推时一帧都没收到过,占位就写进了直播数据 —— 之后下播,下播卡的「累计观看人数」
	 * 一格拿到的就是这句占位(卡片那头字符串原样上卡),卡上会印出「累计观看人数：暂未获取到」。
	 * ㉒d 要拿掉的正是这一条。
	 */
	it("周期复推时没收到过帧:占位被带进下播卡", async () => {
		const { ctx, m } = makeCtx();
		m.isSubscribed.mockReturnValue(true);
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		primeStopBroadcast(s);
		await s.tickPushAtTime();
		m.watchedWhenPushed.length = 0;

		await s.handleLiveEnd("ws");

		expect(m.watchedWhenPushed).toEqual([NOT_FETCHED]);
	});
});

/**
 * 点赞的初值(㉒c):直播数据从前以 `likedNum: "0"` 起步,没收到点赞帧下播卡也画「点赞：0」;现在起步是空的,
 * 没收到点赞帧就没有这一格(翻译出来的卡输入里没有 `likes` 这个键),收到了才有。
 * 放在这里是因为它是会话与翻译的**接线**:直播数据的初值在会话里、「缺了就缺键」在翻译里,各自的单测证明不了接上了。
 */
describe("点赞:没收到点赞帧就没有这一格", () => {
	const room = { title: "标题", live_time: "2026-01-01 00:00:00" };

	it("一帧都没收到:直播数据里没有点赞,下播卡的输入里没有 likes 这个键", () => {
		const { ctx } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		expect(Object.hasOwn(s.liveData, "likedNum")).toBe(false);
		const input = liveCardInputFromRoomInfo(room, "主播", s.liveData, 3);
		expect(Object.hasOwn(input, "likes")).toBe(false);
	});

	/** 验红:把 `RoomSessionBase.liveData` 的初值改回 `{ likedNum: "0" }`(或 0),上一条红。 */
	it("收到点赞帧:数字进直播数据,输入里是这个数(含 0)", () => {
		const { ctx } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		funnelOf(s)({ kind: "liked", count: 5_200 });
		expect(liveCardInputFromRoomInfo(room, "主播", s.liveData, 3).likes).toBe(5_200);
		funnelOf(s)({ kind: "liked", count: 0 });
		expect(liveCardInputFromRoomInfo(room, "主播", s.liveData, 3).likes).toBe(0);
	});
});
