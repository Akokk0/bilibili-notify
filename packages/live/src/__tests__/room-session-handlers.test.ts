/**
 * 单元测试 — `RoomSession` 四个帧处理器 + 开/下播冷却去重。
 *
 * 已有 `room-session-reconnect.test.ts` 覆盖 onError 退避/取消;本文件补:
 *   - onIncomeSuperChat:订阅门控 / minScPrice 阈值 / 图片成功 / api 失败文字降级
 *   - onGuardBuy:订阅门控 / minGuardLevel 阈值 / 自定义模板分支 / 图片卡片分支
 *   - onLiveStart:LIVE_EVENT_COOLDOWN 冷却 / liveStatus 去重 / 成功推卡 / 拉房间
 *     信息失败 → stopMonitoring
 *   - onLiveEnd:冷却忽略 / 正常 handleLiveEnd("ws")
 *
 * 这些处理器是 B 站 WS 帧 → 推送的纯转换;一条门控写反 = SC/上舰漏推或乱推。
 *
 * 策略:沿用 reconnect 测试的「plain object as unknown as RoomContext」做法,
 * 只提供处理器实际触达的成员;基类 protected 的 useLiveRoomInfo/useMasterInfo/
 * handleLiveEnd/armPeriodicTimer 用 `(s as any).x = vi.fn()` 就地打桩。
 */

import type { ServiceContext } from "@bilibili-notify/internal";
import { GuardLevel } from "blive-message-listener";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubItemView } from "../push-like";
import { LivePushType } from "../push-like";
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
		...over,
	} as SubItemView;
}

interface CtxMocks {
	recordDanmaku: ReturnType<typeof vi.fn>;
	broadcastToTargets: ReturnType<typeof vi.fn>;
	getUserInfoInLive: ReturnType<typeof vi.fn>;
	generateSCCard: ReturnType<typeof vi.fn>;
	generateGuardCard: ReturnType<typeof vi.fn>;
	renderGuardBuy: ReturnType<typeof vi.fn>;
	renderLiveStart: ReturnType<typeof vi.fn>;
	sendLiveNotifyCard: ReturnType<typeof vi.fn>;
	stopMonitoring: ReturnType<typeof vi.fn>;
	getTimeDifference: ReturnType<typeof vi.fn>;
	emitLiveState: ReturnType<typeof vi.fn>;
	isSubscribed: ReturnType<typeof vi.fn>;
}

function makeCtx(opts?: {
	minScPrice?: number;
	minGuardLevel?: GuardLevel;
	customGuardBuyEnabled?: boolean;
}): { ctx: RoomContext; m: CtxMocks } {
	const fakeServiceCtx: ServiceContext = {
		logger: { debug() {}, info() {}, warn() {}, error() {} },
		setInterval: () => ({ dispose() {} }),
		setTimeout: () => ({ dispose() {} }),
		onDispose: () => {},
	};
	const m: CtxMocks = {
		recordDanmaku: vi.fn(),
		broadcastToTargets: vi.fn(async () => {}),
		getUserInfoInLive: vi.fn(async () => ({ code: 0, data: { uname: "捧场人", face: "f" } })),
		generateSCCard: vi.fn(async () => Buffer.from("sc")),
		generateGuardCard: vi.fn(async () => Buffer.from("guard")),
		renderGuardBuy: vi.fn(() => "上舰文案"),
		renderLiveStart: vi.fn(() => "开播啦"),
		sendLiveNotifyCard: vi.fn(async () => {}),
		stopMonitoring: vi.fn(),
		getTimeDifference: vi.fn(async () => "1小时"),
		emitLiveState: vi.fn(),
		isSubscribed: vi.fn(() => false),
	};
	const ctx = {
		serviceCtx: fakeServiceCtx,
		logger: fakeServiceCtx.logger,
		isDisposed: () => false,
		config: {
			minScPrice: opts?.minScPrice ?? 30,
			minGuardLevel: opts?.minGuardLevel ?? GuardLevel.Jianzhang,
			customGuardBuy: { enable: opts?.customGuardBuyEnabled ?? false },
			customLiveMsg: { enable: false },
		},
		api: { getUserInfoInLive: m.getUserInfoInLive },
		push: { broadcastToTargets: m.broadcastToTargets },
		imageRenderer: {
			generateSCCard: m.generateSCCard,
			generateGuardCard: m.generateGuardCard,
		},
		contentBuilder: {
			text: (t: string) => ({ kind: "text", text: t }),
			image: () => ({ kind: "image" }),
			message: (segs: unknown[]) => segs,
		},
		templateRenderer: {
			renderGuardBuy: m.renderGuardBuy,
			renderLiveStart: m.renderLiveStart,
			renderSpecialDanmaku: () => "",
		},
		danmakuCollector: { recordDanmaku: m.recordDanmaku },
		isSubscribed: m.isSubscribed,
		hasTargets: () => false,
		sendLiveNotifyCard: m.sendLiveNotifyCard,
		stopMonitoring: m.stopMonitoring,
		getTimeDifference: m.getTimeDifference,
		emitLiveState: m.emitLiveState,
		emitEngineError: vi.fn(),
		emitViewers: vi.fn(),
	} as unknown as RoomContext;
	return { ctx, m };
}

beforeEach(() => {
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// onIncomeSuperChat
// ---------------------------------------------------------------------------

describe("RoomSession.onIncomeSuperChat", () => {
	const scBody = { content: "加油", user: { uname: "粉丝", uid: 42 }, price: 50 };

	it("既不收集弹幕也不推 SC → 早 return,不调 api/push", async () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		await s.onIncomeSuperChat(scBody);
		expect(m.recordDanmaku).not.toHaveBeenCalled();
		expect(m.getUserInfoInLive).not.toHaveBeenCalled();
		expect(m.broadcastToTargets).not.toHaveBeenCalled();
	});

	it("仅收集弹幕(wordcloud 订阅)不推 SC → recordDanmaku 调用但不广播", async () => {
		const { ctx, m } = makeCtx();
		m.isSubscribed.mockImplementation((_s: unknown, feat: string) => feat === "wordcloud");
		const s = new RoomSession(ctx, makeSub({ wordcloud: true })) as AnySession;
		await s.onIncomeSuperChat(scBody);
		expect(m.recordDanmaku).toHaveBeenCalledTimes(1);
		expect(m.broadcastToTargets).not.toHaveBeenCalled();
	});

	it("订阅 SC 但 price < minScPrice → 不广播", async () => {
		const { ctx, m } = makeCtx({ minScPrice: 30 });
		m.isSubscribed.mockImplementation((_s: unknown, feat: string) => feat === "superchat");
		const s = new RoomSession(ctx, makeSub({ superchat: true })) as AnySession;
		await s.onIncomeSuperChat({ ...scBody, price: 10 });
		expect(m.broadcastToTargets).not.toHaveBeenCalled();
	});

	it("订阅 SC + 图片生成成功 → broadcastToTargets(Superchat)", async () => {
		const { ctx, m } = makeCtx({ minScPrice: 30 });
		m.isSubscribed.mockImplementation((_s: unknown, feat: string) => feat === "superchat");
		const s = new RoomSession(ctx, makeSub({ superchat: true })) as AnySession;
		await s.onIncomeSuperChat(scBody);
		expect(m.generateSCCard).toHaveBeenCalledTimes(1);
		expect(m.broadcastToTargets).toHaveBeenCalledTimes(1);
		expect(m.broadcastToTargets.mock.calls[0]?.[2]).toBe(LivePushType.Superchat);
	});

	it("订阅 SC + getUserInfoInLive code!=0 → 文字 fallback 广播(Superchat)", async () => {
		const { ctx, m } = makeCtx({ minScPrice: 30 });
		m.isSubscribed.mockImplementation((_s: unknown, feat: string) => feat === "superchat");
		m.getUserInfoInLive.mockResolvedValueOnce({ code: -1, data: {} });
		const s = new RoomSession(ctx, makeSub({ superchat: true })) as AnySession;
		await s.onIncomeSuperChat(scBody);
		expect(m.generateSCCard).not.toHaveBeenCalled();
		expect(m.broadcastToTargets).toHaveBeenCalledTimes(1);
		expect(m.broadcastToTargets.mock.calls[0]?.[2]).toBe(LivePushType.Superchat);
	});
});

// ---------------------------------------------------------------------------
// onGuardBuy
// ---------------------------------------------------------------------------

describe("RoomSession.onGuardBuy", () => {
	const guardBody = {
		guard_level: GuardLevel.Jianzhang,
		gift_name: "舰长",
		user: { uname: "船员", uid: 7 },
	};

	it("未订阅 liveGuardBuy → 早 return", async () => {
		const { ctx, m } = makeCtx();
		m.isSubscribed.mockReturnValue(false);
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		await s.onGuardBuy(guardBody);
		expect(m.broadcastToTargets).not.toHaveBeenCalled();
	});

	it("guard_level 高于阈值(等级不够)→ 不推", async () => {
		// config.minGuardLevel=Zongdu(1);Jianzhang(3) > 1 → return
		const { ctx, m } = makeCtx({ minGuardLevel: GuardLevel.Zongdu });
		m.isSubscribed.mockImplementation((_s: unknown, feat: string) => feat === "liveGuardBuy");
		const s = new RoomSession(ctx, makeSub({ liveGuardBuy: true })) as AnySession;
		await s.onGuardBuy(guardBody);
		expect(m.broadcastToTargets).not.toHaveBeenCalled();
	});

	it("customGuardBuy.enable → 走模板渲染分支,broadcastToTargets(LiveGuardBuy)", async () => {
		const { ctx, m } = makeCtx();
		m.isSubscribed.mockImplementation((_s: unknown, feat: string) => feat === "liveGuardBuy");
		const s = new RoomSession(
			ctx,
			makeSub({
				liveGuardBuy: true,
				customGuardBuy: {
					enable: true,
					captainImgUrl: "cap",
					supervisorImgUrl: "sup",
					governorImgUrl: "gov",
				} as SubItemView["customGuardBuy"],
			}),
		) as AnySession;
		await s.onGuardBuy(guardBody);
		expect(m.renderGuardBuy).toHaveBeenCalledTimes(1);
		expect(m.broadcastToTargets).toHaveBeenCalledTimes(1);
		expect(m.broadcastToTargets.mock.calls[0]?.[2]).toBe(LivePushType.LiveGuardBuy);
	});

	it("默认(custom 关)+ generateGuardCard + api code0 → 图片卡片(LiveGuardBuy)", async () => {
		const { ctx, m } = makeCtx();
		m.isSubscribed.mockImplementation((_s: unknown, feat: string) => feat === "liveGuardBuy");
		m.getUserInfoInLive.mockResolvedValueOnce({
			code: 0,
			data: { uname: "船员", face: "f", is_admin: false },
		});
		const s = new RoomSession(ctx, makeSub({ liveGuardBuy: true })) as AnySession;
		await s.onGuardBuy(guardBody);
		expect(m.generateGuardCard).toHaveBeenCalledTimes(1);
		expect(m.broadcastToTargets).toHaveBeenCalledTimes(1);
		expect(m.broadcastToTargets.mock.calls[0]?.[2]).toBe(LivePushType.LiveGuardBuy);
	});
});

// ---------------------------------------------------------------------------
// onLiveStart
// ---------------------------------------------------------------------------

describe("RoomSession.onLiveStart", () => {
	it("冷却期内(lastLiveStart 刚刷新)→ 忽略,不拉房间信息", async () => {
		const { ctx } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		s.useLiveRoomInfo = vi.fn(async () => true);
		s.lastLiveStart = Date.now(); // now - lastLiveStart ≈ 0 < 10s
		await s.onLiveStart();
		expect(s.useLiveRoomInfo).not.toHaveBeenCalled();
	});

	it("已是开播状态(liveStatus=true)→ 忽略重复开播", async () => {
		const { ctx } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		s.useLiveRoomInfo = vi.fn(async () => true);
		s.liveStatus = true;
		await s.onLiveStart();
		expect(s.useLiveRoomInfo).not.toHaveBeenCalled();
	});

	it("正常路径 → sendLiveNotifyCard + armPeriodicTimer 调用", async () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		s.useLiveRoomInfo = vi.fn(async () => {
			s.liveRoomInfo = {
				live_time: "2026-01-01 00:00:00",
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
			};
			return true;
		});
		s.armPeriodicTimer = vi.fn();
		await s.onLiveStart();
		expect(m.sendLiveNotifyCard).toHaveBeenCalledTimes(1);
		expect(s.armPeriodicTimer).toHaveBeenCalledTimes(1);
	});

	it("A5:卡片推送 await 期间交错下播翻 idle → 不再 armPeriodicTimer", async () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		s.useLiveRoomInfo = vi.fn(async () => {
			s.liveRoomInfo = {
				live_time: "2026-01-01 00:00:00",
				short_id: 0,
				room_id: 12345,
				title: "标题",
				user_cover: "",
			};
			return true;
		});
		s.useMasterInfo = vi.fn(async () => {
			s.masterInfo = { username: "主播", userface: "", roomId: "r1", liveOpenFollowerNum: 100 };
			return true;
		});
		s.armPeriodicTimer = vi.fn();
		// 模拟交错:卡片渲染+推送这步 await 期间,onLiveEnd→handleLiveEnd 已把
		// liveStatus 翻 idle。
		m.sendLiveNotifyCard.mockImplementation(async () => {
			s.liveStatus = false;
		});

		await s.onLiveStart();

		expect(m.sendLiveNotifyCard).toHaveBeenCalledTimes(1); // 卡片在 guard 之前已发
		// 关键不变量:完成时已非开播态 → 绝不 arm 周期定时器(否则 idle 房挂 live timer)。
		expect(s.armPeriodicTimer).not.toHaveBeenCalled();
	});

	it("拉直播间信息失败(useLiveRoomInfo=false)→ stopMonitoring,不推卡", async () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		s.useLiveRoomInfo = vi.fn(async () => false);
		s.useMasterInfo = vi.fn(async () => true);
		await s.onLiveStart();
		expect(m.stopMonitoring).toHaveBeenCalledTimes(1);
		expect(m.sendLiveNotifyCard).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// onLiveEnd
// ---------------------------------------------------------------------------

describe("RoomSession.onLiveEnd", () => {
	it("冷却期内 → 忽略,不调 handleLiveEnd", async () => {
		const { ctx } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		s.handleLiveEnd = vi.fn(async () => {});
		s.lastLiveEnd = Date.now();
		await s.onLiveEnd();
		expect(s.handleLiveEnd).not.toHaveBeenCalled();
	});

	it('正常 → handleLiveEnd("ws")', async () => {
		const { ctx } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		s.handleLiveEnd = vi.fn(async () => {});
		await s.onLiveEnd();
		expect(s.handleLiveEnd).toHaveBeenCalledWith("ws");
	});
});
