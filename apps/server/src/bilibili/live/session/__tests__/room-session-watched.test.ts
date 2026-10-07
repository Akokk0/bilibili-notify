/**
 * B 站「收到观看人数」那一段(1.0 第 2 期 ㉒a 钉住旧行为、㉒d 翻成数字,2026-10-05)。
 *
 * B 站 WS 的 `WATCHED_CHANGE` 帧由 `RoomSession` 的事件漏斗接住(`case "watched"`),落到五个地方:
 * 直播数据里的 `watchedNum`、总线事件(经 `ctx.emitViewers`,两秒节流)、在播快照的 `viewers`,以及
 * 「正在直播」文案与下播卡里的累计观看。
 *
 * ㉒a 钉的是当时的样子:存进去的是 B 站现成的字符串 `text_small`,缺数时「暂未获取到」会被**写回**直播数据
 * (于是下播卡会印出「累计观看人数：暂未获取到」)。㉒d 把观看人数改成精确数 `num`,哨兵不再写回、在播快照也
 * 不用再滤它,这里的断言逐条翻成新行为:
 * - 「存的是 text_small」→「存的是 num」;emit 的实参、快照的 `viewers` 同理是数字;
 * - 两处写回(`tickPushAtTime` / `bootstrapRoomState`)→ 缺数就缺键,文案那头拿到 `undefined`(「暂未获取到」改由
 *   文字渲染器在出口印,见 `template-renderer.test.ts`);
 * - 在播快照的哨兵过滤、数字转字符串 → 没有了(0 是真数,照回 0);
 * - 「占位带进下播卡」→ 一帧没收到时下播卡这一格不画,收到了带精确数。
 * 节流(两秒、每会话各管各)与点赞初值那两组不变。另加「每场重置」一组(上一场的数不许留到下一场)。
 *
 * 策略:沿用 `room-session-handlers.test.ts` 的 plain-object-as-RoomContext 做法,
 * 事件直接喂 `buildEventHandler()` 给出的漏斗;钟只假 `Date`(节流读 `Date.now()`)。
 */

import type { ServiceContext } from "@bilibili-notify/internal";
import { defaultMessageKindLayout } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { liveCardInputFromRoomInfo } from "../../live-card-input";
import type { LiveEvent } from "../../protocol/events.js";
import type { SubItemView } from "../../push-like";
import type { RoomContext } from "../room-helpers";
import { RoomSession } from "../room-session";

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
		liveStreaming: false,
		streamingIntervalHours: 1,
		catchUpOnBoot: false,
		messageLayout: defaultMessageKindLayout("live"),
		...over,
	} as SubItemView;
}

/** 推卡那一刻直播数据里的两格(引用是同一个对象,事后读会变,所以当场抄下来)。 */
interface PushedData {
	watchedNum?: number;
	likedNum?: number;
}

interface Mocks {
	emitViewers: ReturnType<typeof vi.fn>;
	renderLiveStart: ReturnType<typeof vi.fn>;
	renderLiveStreaming: ReturnType<typeof vi.fn>;
	sendLiveNotifyCard: ReturnType<typeof vi.fn>;
	isSubscribed: ReturnType<typeof vi.fn>;
	/** 每次 `sendLiveNotifyCard` 被调用的那一刻,直播数据里的观看人数与点赞。 */
	pushed: PushedData[];
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
	const pushed: PushedData[] = [];
	const m: Mocks = {
		emitViewers: vi.fn(),
		renderLiveStart: vi.fn(() => "开播啦"),
		renderLiveStreaming: vi.fn(() => "直播中"),
		sendLiveNotifyCard: vi.fn(async (p: { liveData: PushedData }) => {
			pushed.push({ watchedNum: p.liveData.watchedNum, likedNum: p.liveData.likedNum });
		}),
		isSubscribed: vi.fn(() => false),
		pushed,
	};
	const ctx = {
		serviceCtx: fakeServiceCtx,
		logger: fakeServiceCtx.logger,
		isDisposed: () => false,
		config: {
			guardTemplate: { enabled: false, default: { template: "", imageUrl: "" }, tiers: {} },
			customLiveMsg: { enable: false },
		},
		templateRenderer: {
			renderLiveStart: m.renderLiveStart,
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

/** 一帧 `WATCHED_CHANGE`:只有精确数 `num`(B 站排好的「1.2万」不进事件)。 */
function watched(num: number): LiveEvent {
	return { kind: "watched", num };
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
	 * 存的是精确数 `num`(㉒a 钉的是 B 站排好的字符串 `text_small`)。
	 * 验红:把 `case "watched"` 里的 `ev.num` 换成 `String(ev.num)`,这条红。
	 */
	it("存的是精确数 num,不是字符串", () => {
		const { ctx } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		funnelOf(s)(watched(12_345));
		expect(s.liveData.watchedNum).toBe(12_345);
	});

	it("每一帧都存(哪怕这一帧被总线节流掉了),最新一帧胜出", () => {
		const { ctx } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		const handler = funnelOf(s);
		handler(watched(8_000));
		handler(watched(9_500));
		handler(watched(12_345));
		expect(s.liveData.watchedNum).toBe(12_345);
	});
});

describe("WATCHED_CHANGE 帧 · 总线事件(emitViewers)的两秒节流", () => {
	/**
	 * 实参是 `(uid, num)`,数字。
	 * 验红:把 `emitViewers(this.sub.uid, ev.num)` 的第二个实参换成 `String(ev.num)`,这条红。
	 */
	it("第一帧就发,实参是 (uid, num)", () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(ctx, makeSub({ uid: "u7" })) as AnySession;
		funnelOf(s)(watched(12_345));
		expect(m.emitViewers).toHaveBeenCalledTimes(1);
		expect(m.emitViewers).toHaveBeenCalledWith("u7", 12_345);
	});

	/**
	 * 验红:把 `VIEWERS_EMIT_THROTTLE_MS` 改成 0,「同一刻连来几帧」那条红;改成 5000,「恰好两秒」那条红;
	 * 把 `>=` 改成 `>`,「恰好两秒」那条红。
	 */
	it("两秒内连来几帧只发一次(发的是最早那帧),每一帧都存", () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		const handler = funnelOf(s);
		handler(watched(1));
		handler(watched(2));
		handler(watched(3));
		expect(m.emitViewers).toHaveBeenCalledTimes(1);
		expect(m.emitViewers).toHaveBeenCalledWith("u1", 1);
		expect(s.liveData.watchedNum).toBe(3);
	});

	it("差 1 毫秒满两秒还不发,恰好两秒发(含边界),发的是那一帧自己的值", () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		const handler = funnelOf(s);
		handler(watched(1));

		vi.setSystemTime(T0 + 1_999);
		handler(watched(2));
		expect(m.emitViewers).toHaveBeenCalledTimes(1);
		expect(s.liveData.watchedNum).toBe(2);

		vi.setSystemTime(T0 + 2_000);
		handler(watched(3));
		expect(m.emitViewers.mock.calls).toEqual([
			["u1", 1],
			["u1", 3],
		]);
	});

	it("节流窗口从**上一次发出**算起,不是从上一帧收到算起", () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		const handler = funnelOf(s);
		handler(watched(1)); // t=0 发
		vi.setSystemTime(T0 + 1_500);
		handler(watched(2)); // 被节流;若窗口按"上一帧收到"重算,下一帧要等到 3500
		vi.setSystemTime(T0 + 2_100);
		handler(watched(3)); // 距上次发出 2100ms,发
		expect(m.emitViewers.mock.calls).toEqual([
			["u1", 1],
			["u1", 3],
		]);
	});

	/** 门控是每个会话(每个 UID)各管各的:甲刚发过,不挡乙。验红:把 `lastViewersEmitMs` 改成模块级变量,这条红。 */
	it("每个 UID 各管各的节流:同一刻两个房间各发一次", () => {
		const a = makeCtx();
		const b = makeCtx();
		const sa = new RoomSession(a.ctx, makeSub({ uid: "ua", roomId: "ra" })) as AnySession;
		const sb = new RoomSession(b.ctx, makeSub({ uid: "ub", roomId: "rb" })) as AnySession;
		funnelOf(sa)(watched(11));
		funnelOf(sb)(watched(22));
		expect(a.m.emitViewers).toHaveBeenCalledWith("ua", 11);
		expect(b.m.emitViewers).toHaveBeenCalledWith("ub", 22);
	});
});

describe("getLiveSnapshot().viewers", () => {
	it("还没收到过帧 → undefined(面板显示「—」)", () => {
		const { ctx } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		expect(s.getLiveSnapshot().viewers).toBeUndefined();
	});

	/** 回的是精确数,不是字符串。验红:让 `viewers` 回 `undefined` 或回 `String(num)`,这条红。 */
	it("收到帧之后回精确数", () => {
		const { ctx } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		funnelOf(s)(watched(12_345));
		expect(s.getLiveSnapshot().viewers).toBe(12_345);
	});

	/**
	 * 0 是真数(从前 `viewers && …` 的真值判断会把它吞成 undefined)。验红:把 `viewers` 改成 `|| undefined`,这条红。
	 */
	it("收到的是 0:回 0,不当成没有", () => {
		const { ctx } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		funnelOf(s)(watched(0));
		expect(s.getLiveSnapshot().viewers).toBe(0);
	});
});

describe("缺数时不写回直播数据 · 周期「正在直播」(tickPushAtTime)", () => {
	/**
	 * ㉒a 钉的是「写回『暂未获取到』」;现在缺数就缺键:文案那头拿到 `undefined`(出口印「暂未获取到」归文字渲染器),
	 * 直播数据里没有这一格,推卡时也没有。
	 * 验红:把 `tickPushAtTime` 里的 `watched` 又写回 `this.liveData.watchedNum`(或写成字符串),这几条红。
	 */
	it("一帧都没收到:文案收到 undefined,直播数据里没有观看人数,推卡时也没有", async () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		primeLiveRoom(s);

		await s.tickPushAtTime();

		expect(m.renderLiveStreaming.mock.calls[0]?.[0].watched).toBeUndefined();
		expect(Object.hasOwn(s.liveData, "watchedNum")).toBe(false);
		expect(m.pushed).toEqual([{ watchedNum: undefined, likedNum: undefined }]);
		expect(s.getLiveSnapshot().viewers).toBeUndefined();
	});

	it("收到过帧:文案和推卡拿的都是那个数,不动它", async () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		primeLiveRoom(s);
		funnelOf(s)(watched(12_345));

		await s.tickPushAtTime();

		expect(m.renderLiveStreaming.mock.calls[0]?.[0]).toMatchObject({ watched: 12_345 });
		expect(s.liveData.watchedNum).toBe(12_345);
		expect(m.pushed.map((p) => p.watchedNum)).toEqual([12_345]);
		expect(s.getLiveSnapshot().viewers).toBe(12_345);
	});

	/** 周期复推一遍不改直播数据:之后来一帧就是那一帧。 */
	it("没数时跑过一遍周期复推,之后再来一帧真值 → 就是那一帧", async () => {
		const { ctx } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		primeLiveRoom(s);
		await s.tickPushAtTime();
		funnelOf(s)(watched(12_345));
		expect(s.liveData.watchedNum).toBe(12_345);
		expect(s.getLiveSnapshot().viewers).toBe(12_345);
	});
});

describe("缺数时不写回直播数据 · 启动时发现正在播(bootstrapRoomState)", () => {
	/**
	 * 验红:把 `bootstrapRoomStateInner` 里的 `watched` 又写回直播数据,这一条与下一条红。
	 */
	it("没开重启补报:文案照算(收到 undefined),直播数据里仍然没有观看人数", async () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(ctx, makeSub({ catchUpOnBoot: false })) as AnySession;
		primeLiveRoom(s);

		expect(await s.bootstrapRoomState()).toBe(true);

		expect(m.sendLiveNotifyCard).not.toHaveBeenCalled();
		expect(m.renderLiveStreaming.mock.calls[0]?.[0].watched).toBeUndefined();
		expect(Object.hasOwn(s.liveData, "watchedNum")).toBe(false);
		expect(s.getLiveSnapshot().viewers).toBeUndefined();
	});

	it("开了重启补报:补报的那张卡直播数据里没有观看人数", async () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(ctx, makeSub({ catchUpOnBoot: true })) as AnySession;
		primeLiveRoom(s);

		await s.bootstrapRoomState();

		expect(m.pushed).toEqual([{ watchedNum: undefined, likedNum: undefined }]);
	});

	it("启动前已经收到过帧(重连补跑的情形):用那个数", async () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(ctx, makeSub({ catchUpOnBoot: true })) as AnySession;
		primeLiveRoom(s);
		funnelOf(s)(watched(12_345));

		await s.bootstrapRoomState();

		expect(m.renderLiveStreaming.mock.calls[0]?.[0]).toMatchObject({ watched: 12_345 });
		expect(s.liveData.watchedNum).toBe(12_345);
		expect(m.pushed.map((p) => p.watchedNum)).toEqual([12_345]);
	});
});

describe("下播卡的累计观看取自同一份直播数据", () => {
	function primeStopBroadcast(s: AnySession): void {
		s.liveStatus = true;
		primeLiveRoom(s);
		s.dispatchWordCloudAndSummary = vi.fn(async () => {});
	}

	const ROOM = { title: "标题", live_time: "2026-01-01 00:00:00" };

	/**
	 * 收到过帧:下播卡的输入里带着精确数(㉒c 留的过渡是「是数字才给」,存了数字就自动接上)。
	 * 验红:把 `liveCardInputFromRoomInfo` 的 `totalViewers` 去掉,这条红。
	 */
	it("收到过帧:下播卡拿到精确数,翻出来的卡输入里有 totalViewers", async () => {
		const { ctx, m } = makeCtx();
		m.isSubscribed.mockReturnValue(true);
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		primeStopBroadcast(s);
		funnelOf(s)(watched(31_200));

		await s.handleLiveEnd("ws");

		expect(m.pushed.map((p) => p.watchedNum)).toEqual([31_200]);
		expect(liveCardInputFromRoomInfo(ROOM, "主播", s.liveData, 3).totalViewers).toBe(31_200);
	});

	/**
	 * 周期复推时一帧都没收到过、之后下播:从前占位被写进直播数据,下播卡的「累计观看人数」印出「暂未获取到」;
	 * 现在不写回,这一格不画。验红:让 `tickPushAtTime` 把缺数写回成字符串占位,这条红。
	 */
	it("周期复推时没收到过帧:下播卡这一格不画(输入里没有 totalViewers 这个键)", async () => {
		const { ctx, m } = makeCtx();
		m.isSubscribed.mockReturnValue(true);
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		primeStopBroadcast(s);
		await s.tickPushAtTime();
		m.pushed.length = 0;

		await s.handleLiveEnd("ws");

		expect(m.pushed.map((p) => p.watchedNum)).toEqual([undefined]);
		expect(
			Object.hasOwn(liveCardInputFromRoomInfo(ROOM, "主播", s.liveData, 3), "totalViewers"),
		).toBe(false);
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

/**
 * 每场重置(㉒d 顺手收的一个现存问题):`liveData` 是**会话级**的,房间一直开着监听,上一场收到过的观看人数与点赞
 * 从前会一直留到下一场 —— 下一场开播卡、`{watched}`、在播快照在新的一帧到来之前拿的都是上一场的数。
 * 现在**开播事件被接受的那一刻**(过了冷却与去重、在刷新房间信息和发开播卡之前)把这两格清掉;下播时不清
 * (下播卡要用),断流接续里重新开播会被「已经是开播状态」的去重挡在前面,不算新的一场、不清。
 */
describe("每场重置:上一场的观看人数与点赞不留到下一场", () => {
	function primeStopBroadcast(s: AnySession): void {
		s.liveStatus = true;
		primeLiveRoom(s);
		s.dispatchWordCloudAndSummary = vi.fn(async () => {});
	}

	/** 上一场收到过数 → 下播。 */
	async function firstLiveThenEnd(s: AnySession, m: Mocks): Promise<void> {
		funnelOf(s)(watched(87_334));
		funnelOf(s)({ kind: "liked", count: 4_000 });
		m.isSubscribed.mockReturnValue(true);
		primeStopBroadcast(s);
		await s.handleLiveEnd("ws");
		expect(s.liveStatus).toBe(false);
	}

	/**
	 * 验红:删掉 `onLiveStart` 里的重置,这几条红(这就是修之前的复现)。
	 */
	it("下一场开播卡:直播数据里没有上一场的观看人数与点赞", async () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		await firstLiveThenEnd(s, m);
		m.pushed.length = 0;

		await s.onLiveStart();

		expect(m.pushed).toEqual([{ watchedNum: undefined, likedNum: undefined }]);
	});

	it("下一场开播后:在播快照的 viewers 是 undefined,不是上一场的数", async () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		await firstLiveThenEnd(s, m);

		await s.onLiveStart();

		expect(s.getLiveSnapshot().viewers).toBeUndefined();
	});

	it("下一场第一次周期「正在直播」:{watched} 拿到的是 undefined(出口印「暂未获取到」),不是上一场的数", async () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		await firstLiveThenEnd(s, m);
		await s.onLiveStart();

		await s.tickPushAtTime();

		expect(m.renderLiveStreaming.mock.calls.at(-1)?.[0].watched).toBeUndefined();
	});

	it("下一场新来的帧照常:开播后收到的数就是这一场的数", async () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		await firstLiveThenEnd(s, m);
		await s.onLiveStart();

		funnelOf(s)(watched(10));
		funnelOf(s)({ kind: "liked", count: 3 });

		expect(s.liveData.watchedNum).toBe(10);
		expect(s.liveData.likedNum).toBe(3);
	});

	/** 清的时机:开播事件被接受的那一刻,而不是等刷新房间信息之后 —— 那几秒里到的帧已经是这一场的了。 */
	it("开播事件到了、房间信息还没刷回来的几秒里收到的帧是这一场的,不被后面的重置抹掉", async () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		await firstLiveThenEnd(s, m);
		// 刷房间信息的那一步里插一帧(WS 早已连着)。
		const refresh = s.useLiveRoomInfo;
		s.useLiveRoomInfo = vi.fn(async (...args: unknown[]) => {
			funnelOf(s)(watched(77));
			return refresh(...args);
		});

		await s.onLiveStart();

		expect(s.liveData.watchedNum).toBe(77);
	});

	/** 下播时不清:下播卡要用这一场的数。 */
	it("下播时不清:下播卡拿到这一场的观看人数与点赞", async () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		funnelOf(s)(watched(87_334));
		funnelOf(s)({ kind: "liked", count: 4_000 });
		m.isSubscribed.mockReturnValue(true);
		primeStopBroadcast(s);

		await s.handleLiveEnd("ws");

		expect(m.pushed).toEqual([{ watchedNum: 87_334, likedNum: 4_000 }]);
	});

	/** 重复的开播事件(已经是开播状态,断流接续里重新开播也是这一条路)被去重挡掉,不当新的一场、不清。 */
	it("已经是开播状态时又来开播事件:被去重忽略,这一场的数不动", async () => {
		const { ctx } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		primeLiveRoom(s);
		s.liveStatus = true;
		funnelOf(s)(watched(500));

		await s.onLiveStart();

		expect(s.liveData.watchedNum).toBe(500);
	});

	/** 重启补报(`bootstrapRoomState`)那条路本来就是新会话:直播数据是空的,不受影响。 */
	it("重启补报:新会话的直播数据本来就是空的", async () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(ctx, makeSub({ catchUpOnBoot: true })) as AnySession;
		primeLiveRoom(s);

		await s.bootstrapRoomState();

		expect(m.pushed).toEqual([{ watchedNum: undefined, likedNum: undefined }]);
	});
});
