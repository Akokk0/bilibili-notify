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

import { GuardLevel } from "@bilibili-notify/blive";
import type { ServiceContext } from "@bilibili-notify/internal";
import { defaultMessageKindLayout } from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { SubItemView } from "../push-like";
import { LivePushType, wantsLiveEndExtras } from "../push-like";
import { RoomContext } from "../room-helpers";
import { RoomSession } from "../room-session";
import { LiveType } from "../types";

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
		liveEndExtras: { wordcloud: false, liveSummary: false },
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
		// 宿主恒填版式;用例按需覆盖。
		messageLayout: defaultMessageKindLayout("live"),
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
	renderLiveOngoing: ReturnType<typeof vi.fn>;
	renderLiveEnd: ReturnType<typeof vi.fn>;
	renderSpecialUserEnter: ReturnType<typeof vi.fn>;
	sendLiveNotifyCard: ReturnType<typeof vi.fn>;
	stopMonitoring: ReturnType<typeof vi.fn>;
	getTimeDifference: ReturnType<typeof vi.fn>;
	emitLiveState: ReturnType<typeof vi.fn>;
	isSubscribed: ReturnType<typeof vi.fn>;
	collectsDanmaku: ReturnType<typeof vi.fn>;
	hasTargets: ReturnType<typeof vi.fn>;
	safeBroadcast: ReturnType<typeof vi.fn>;
}

function makeCtx(opts?: { customGuardBuyEnabled?: boolean }): { ctx: RoomContext; m: CtxMocks } {
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
		renderLiveOngoing: vi.fn(() => "直播中"),
		renderLiveEnd: vi.fn(() => "下播了"),
		renderSpecialUserEnter: vi.fn(() => "进房文案"),
		sendLiveNotifyCard: vi.fn(async () => {}),
		stopMonitoring: vi.fn(),
		getTimeDifference: vi.fn(async () => "1小时"),
		emitLiveState: vi.fn(),
		isSubscribed: vi.fn(() => false),
		collectsDanmaku: vi.fn((sub: SubItemView) => wantsLiveEndExtras(sub)),
		hasTargets: vi.fn(() => false),
		safeBroadcast: vi.fn(),
	};
	const ctx = {
		serviceCtx: fakeServiceCtx,
		logger: fakeServiceCtx.logger,
		isDisposed: () => false,
		config: {
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
			renderLiveOngoing: m.renderLiveOngoing,
			renderLiveEnd: m.renderLiveEnd,
			renderSpecialDanmaku: () => "",
			renderSpecialUserEnter: m.renderSpecialUserEnter,
		},
		danmakuCollector: { recordDanmaku: m.recordDanmaku, clear: vi.fn(), registerRoom: vi.fn() },
		isSubscribed: m.isSubscribed,
		collectsDanmaku: m.collectsDanmaku,
		hasTargets: m.hasTargets,
		safeBroadcast: m.safeBroadcast,
		sendLiveNotifyCard: m.sendLiveNotifyCard,
		stopMonitoring: m.stopMonitoring,
		getTimeDifference: m.getTimeDifference,
		emitLiveState: m.emitLiveState,
		emitEngineError: vi.fn(),
		emitViewers: vi.fn(),
		// 默认不轮换(adapter 未注入语义);轮换用例自行覆写为计数选择器。
		pickBackground: vi.fn(() => undefined),
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

	it("仅收集弹幕(下播开着、词云开着)不推 SC → recordDanmaku 调用但不广播", async () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(
			ctx,
			makeSub({ liveEnd: true, liveEndExtras: { wordcloud: true, liveSummary: false } }),
		) as AnySession;
		await s.onIncomeSuperChat(scBody);
		expect(m.recordDanmaku).toHaveBeenCalledTimes(1);
		expect(m.broadcastToTargets).not.toHaveBeenCalled();
	});

	it("订阅 SC 但 price < minScPrice → 不广播", async () => {
		const { ctx, m } = makeCtx();
		m.isSubscribed.mockImplementation((_s: unknown, feat: string) => feat === "superchat");
		const s = new RoomSession(ctx, makeSub({ superchat: true, minScPrice: 30 })) as AnySession;
		await s.onIncomeSuperChat({ ...scBody, price: 10 });
		expect(m.broadcastToTargets).not.toHaveBeenCalled();
	});

	it("订阅 SC + 图片生成成功 → broadcastToTargets(Superchat)", async () => {
		const { ctx, m } = makeCtx();
		m.isSubscribed.mockImplementation((_s: unknown, feat: string) => feat === "superchat");
		const s = new RoomSession(ctx, makeSub({ superchat: true, minScPrice: 30 })) as AnySession;
		await s.onIncomeSuperChat(scBody);
		expect(m.generateSCCard).toHaveBeenCalledTimes(1);
		expect(m.broadcastToTargets).toHaveBeenCalledTimes(1);
		expect(m.broadcastToTargets.mock.calls[0]?.[2]).toBe(LivePushType.Superchat);
	});

	it("订阅 SC + getUserInfoInLive code!=0 → 文字 fallback 广播(Superchat)", async () => {
		const { ctx, m } = makeCtx();
		m.isSubscribed.mockImplementation((_s: unknown, feat: string) => feat === "superchat");
		m.getUserInfoInLive.mockResolvedValueOnce({ code: -1, data: {} });
		const s = new RoomSession(ctx, makeSub({ superchat: true, minScPrice: 30 })) as AnySession;
		await s.onIncomeSuperChat(scBody);
		expect(m.generateSCCard).not.toHaveBeenCalled();
		expect(m.broadcastToTargets).toHaveBeenCalledTimes(1);
		expect(m.broadcastToTargets.mock.calls[0]?.[2]).toBe(LivePushType.Superchat);
	});

	it("有 per-kind sc 样式 → generateSCCard 收到 sc 专属 colorOptions(而非基准)", async () => {
		const { ctx, m } = makeCtx();
		m.isSubscribed.mockImplementation((_s: unknown, feat: string) => feat === "superchat");
		const s = new RoomSession(
			ctx,
			makeSub({
				superchat: true,
				minScPrice: 30,
				customCardStyle: { enable: true, backgroundImage: "base-bg" },
				customCardStyleByKind: {
					sc: { enable: true, backgroundImage: "sc-bg", glassOpacity: 0.5 },
				},
			}),
		) as AnySession;
		await s.onIncomeSuperChat(scBody);
		expect(m.generateSCCard).toHaveBeenCalledTimes(1);
		// 第二参 = colorOptions(sc 专属覆盖基准)。
		expect(m.generateSCCard.mock.calls[0]?.[1]).toMatchObject({
			backgroundImage: "sc-bg",
			glassOpacity: 0.5,
		});
	});

	it("无 per-kind sc 覆盖 → generateSCCard 回退到基准 customCardStyle", async () => {
		const { ctx, m } = makeCtx();
		m.isSubscribed.mockImplementation((_s: unknown, feat: string) => feat === "superchat");
		const s = new RoomSession(
			ctx,
			makeSub({
				superchat: true,
				minScPrice: 30,
				customCardStyle: { enable: true, backgroundImage: "base-bg" },
			}),
		) as AnySession;
		await s.onIncomeSuperChat(scBody);
		expect(m.generateSCCard.mock.calls[0]?.[1]).toMatchObject({ backgroundImage: "base-bg" });
	});

	it("基准与 per-kind 都未启用 → generateSCCard 第二参为 undefined(走渲染器全局兜底)", async () => {
		const { ctx, m } = makeCtx();
		m.isSubscribed.mockImplementation((_s: unknown, feat: string) => feat === "superchat");
		const s = new RoomSession(ctx, makeSub({ superchat: true, minScPrice: 30 })) as AnySession;
		await s.onIncomeSuperChat(scBody);
		expect(m.generateSCCard.mock.calls[0]?.[1]).toBeUndefined();
	});

	it("per-kind sc 配多图 → 连续 SC 推送经 pickBackground 逐张轮换背景", async () => {
		const { ctx, m } = makeCtx();
		m.isSubscribed.mockImplementation((_s: unknown, feat: string) => feat === "superchat");
		// 注入按 scopeKey 计数的选择器,模拟「每次推送轮换」。
		const cursors: Record<string, number> = {};
		// biome-ignore lint/suspicious/noExplicitAny: 覆写 mock ctx 的可选回调
		(ctx as any).pickBackground = (key: string, images: string[]): string => {
			const i = cursors[key] ?? 0;
			cursors[key] = i + 1;
			return images[i % images.length] as string;
		};
		const s = new RoomSession(
			ctx,
			makeSub({
				superchat: true,
				minScPrice: 30,
				customCardStyleByKind: { sc: { enable: true, backgroundImages: ["a", "b", "c"] } },
			}),
		) as AnySession;
		await s.onIncomeSuperChat(scBody);
		await s.onIncomeSuperChat(scBody);
		await s.onIncomeSuperChat(scBody);
		await s.onIncomeSuperChat(scBody);
		const bgs = m.generateSCCard.mock.calls.map(
			(c) => (c[1] as { backgroundImage?: string } | undefined)?.backgroundImage,
		);
		expect(bgs).toEqual(["a", "b", "c", "a"]);
	});

	it("per-kind sc 单图 → 不调 pickBackground,沿用该单图(engines 已填 backgroundImage)", async () => {
		const { ctx, m } = makeCtx();
		m.isSubscribed.mockImplementation((_s: unknown, feat: string) => feat === "superchat");
		const s = new RoomSession(
			ctx,
			makeSub({
				superchat: true,
				minScPrice: 30,
				// engines 的 cardStyleToColorOptions 同时填单 backgroundImage 与列表。
				customCardStyleByKind: {
					sc: { enable: true, backgroundImage: "solo", backgroundImages: ["solo"] },
				},
			}),
		) as AnySession;
		await s.onIncomeSuperChat(scBody);
		expect(ctx.pickBackground).not.toHaveBeenCalled();
		expect(m.generateSCCard.mock.calls[0]?.[1]).toMatchObject({ backgroundImage: "solo" });
	});

	it("回归:基准与 per-kind 都无覆盖,但全局默认配了多图 → 仍按 defaultBackgroundImages 轮换(而非静默回退单图)", async () => {
		const { ctx, m } = makeCtx();
		m.isSubscribed.mockImplementation((_s: unknown, feat: string) => feat === "superchat");
		const cursors: Record<string, number> = {};
		// biome-ignore lint/suspicious/noExplicitAny: 覆写 mock ctx 的可选回调
		(ctx as any).pickBackground = (key: string, images: string[]): string => {
			const i = cursors[key] ?? 0;
			cursors[key] = i + 1;
			return images[i % images.length] as string;
		};
		// biome-ignore lint/suspicious/noExplicitAny: 测试注入引擎级全局默认多图
		(ctx as any).config.defaultBackgroundImages = ["x", "y"];
		const s = new RoomSession(ctx, makeSub({ superchat: true, minScPrice: 30 })) as AnySession;
		await s.onIncomeSuperChat(scBody);
		await s.onIncomeSuperChat(scBody);
		const bgs = m.generateSCCard.mock.calls.map(
			(c) => (c[1] as { backgroundImage?: string } | undefined)?.backgroundImage,
		);
		expect(bgs).toEqual(["x", "y"]);
	});
});

// ---------------------------------------------------------------------------
// onGuardBuy
// ---------------------------------------------------------------------------

describe("RoomSession.onGuardBuy", () => {
	const guardBody = {
		guard_level: GuardLevel.Captain,
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
		// sub.minGuardLevel=1(总督);Captain(3) > 1 → return
		const { ctx, m } = makeCtx();
		m.isSubscribed.mockImplementation((_s: unknown, feat: string) => feat === "liveGuardBuy");
		const s = new RoomSession(ctx, makeSub({ liveGuardBuy: true, minGuardLevel: 1 })) as AnySession;
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

	it("有 per-kind guard 样式 → generateGuardCard 收到 guard 专属 colorOptions", async () => {
		const { ctx, m } = makeCtx();
		m.isSubscribed.mockImplementation((_s: unknown, feat: string) => feat === "liveGuardBuy");
		m.getUserInfoInLive.mockResolvedValueOnce({
			code: 0,
			data: { uname: "船员", face: "f", is_admin: false },
		});
		const s = new RoomSession(
			ctx,
			makeSub({
				liveGuardBuy: true,
				customCardStyle: { enable: true, backgroundImage: "base-bg" },
				customCardStyleByKind: {
					guard: { enable: true, backgroundImage: "guard-bg", glassClear: true },
				},
			}),
		) as AnySession;
		await s.onGuardBuy(guardBody);
		// 第三参 = colorOptions(guard 专属);第四参为版式。
		expect(m.generateGuardCard.mock.calls[0]?.[2]).toMatchObject({
			backgroundImage: "guard-bg",
			glassClear: true,
		});
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

	it("有 per-kind live 样式 → sendLiveNotifyCard 收到 live 专属 cardStyle(而非基准)", async () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(
			ctx,
			makeSub({
				customCardStyle: { enable: true, backgroundImage: "base-bg" },
				customCardStyleByKind: { live: { enable: true, backgroundImage: "live-bg" } },
			}),
		) as AnySession;
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
		await s.onLiveStart();
		expect(m.sendLiveNotifyCard.mock.calls[0]?.[0]?.cardStyle).toMatchObject({
			backgroundImage: "live-bg",
		});
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

	it("sub 带 messageLayout → sendLiveNotifyCard 收到版式与房间链接", async () => {
		const { ctx, m } = makeCtx();
		const layout = {
			blocks: [{ id: "card", type: "card", visible: true }],
			separator: "\n",
		};
		const s = new RoomSession(ctx, makeSub({ messageLayout: layout })) as AnySession;
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
		await s.onLiveStart();
		const params = m.sendLiveNotifyCard.mock.calls[0]?.[0];
		expect(params?.messageLayout).toEqual(layout);
		expect(params?.roomLink).toBe("https://live.bilibili.com/12345");
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

// ---------------------------------------------------------------------------
// tickPushAtTime(直播中周期复推)/ handleLiveEnd(下播)—— 消息版式接线
//
// 回归:消息版式此前误实现成「仅作用于开播」,直播中 / 下播的默认模板又同批移除
// 了 {link} 变量,两者叠加导致这两类推送的房间链接彻底丢失且无替代机制。现在
// messageLayout 覆盖开播 / 直播中 / 下播三类,以下钉住 tickPushAtTime / handleLiveEnd
// 与 onLiveStart 同款接线(sub.messageLayout,roomLink 透传)。
// ---------------------------------------------------------------------------

describe("RoomSession.tickPushAtTime — 消息版式", () => {
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
			s.masterInfo = { username: "主播", userface: "", roomId: "r1", liveOpenFollowerNum: 100 };
			return true;
		});
	}

	it("sub 带 messageLayout → renderLiveOngoing 后 sendLiveNotifyCard 收到版式与房间链接", async () => {
		const { ctx, m } = makeCtx();
		const layout = { blocks: [{ id: "card", type: "card", visible: true }], separator: "\n" };
		const s = new RoomSession(ctx, makeSub({ messageLayout: layout })) as AnySession;
		primeLiveRoom(s);
		await s.tickPushAtTime();
		const params = m.sendLiveNotifyCard.mock.calls[0]?.[0];
		expect(params?.messageLayout).toEqual(layout);
		expect(params?.roomLink).toBe("https://live.bilibili.com/12345");
	});
});

describe("RoomSession.handleLiveEnd — 消息版式", () => {
	function primeStopBroadcast(s: AnySession): void {
		s.liveStatus = true;
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
				liveEndFollowerNum: 100,
				liveFollowerChange: 0,
			};
			return true;
		});
		s.dispatchWordCloudAndSummary = vi.fn(async () => {});
	}

	it("sub 带 messageLayout → renderLiveEnd 后 sendLiveNotifyCard 收到版式与房间链接", async () => {
		const { ctx, m } = makeCtx();
		m.isSubscribed.mockReturnValue(true);
		const layout = { blocks: [{ id: "text", type: "text", visible: true }], separator: "\n" };
		const s = new RoomSession(ctx, makeSub({ messageLayout: layout })) as AnySession;
		primeStopBroadcast(s);
		await s.handleLiveEnd("ws");
		const params = m.sendLiveNotifyCard.mock.calls[0]?.[0];
		expect(params?.messageLayout).toEqual(layout);
		expect(params?.roomLink).toBe("https://live.bilibili.com/12345");
	});
});

// ---------------------------------------------------------------------------
// onUserAction —— 特别关注用户进房
//
// 数据源是 @bilibili-notify/blive 解析出的 user-action 事件({action, user}),
// 且只由 INTERACT_WORD_V2 一帧独供 —— ENTRY_EFFECT / v1 INTERACT_WORD 在 parser
// 层就走 raw,不会产出 user-action(舰长进房重复推的旧 bug 由 parser 测试钉住)。
// ---------------------------------------------------------------------------

function makeSpecialUserSub() {
	return makeSub({
		customSpecialUsersEnterTheRoom: {
			enable: true,
			specialUsersEnterTheRoom: ["42"],
			msgTemplate: "进房模板",
		},
		target: { specialUserEnter: ["target-1"] },
	});
}

function enterEvent(uid: number, uname = "特别用户") {
	return { action: "enter" as const, user: { uid, uname } };
}

describe("RoomSession.onUserAction", () => {
	it("特别关注用户进房 → 用 internal feature key specialUserEnter 检查目标并推送", async () => {
		const { ctx, m } = makeCtx();
		m.hasTargets.mockImplementation(
			(_sub: unknown, feature: string) => feature === "specialUserEnter",
		);
		const s = new RoomSession(ctx, makeSpecialUserSub()) as AnySession;

		await s.onUserAction(enterEvent(42));

		expect(m.hasTargets).toHaveBeenCalledWith(expect.anything(), "specialUserEnter");
		expect(m.renderSpecialUserEnter).toHaveBeenCalledTimes(1);
		expect(m.renderSpecialUserEnter.mock.calls[0]?.[0]?.uname).toBe("特别用户");
		expect(m.safeBroadcast).toHaveBeenCalledTimes(1);
		expect(m.safeBroadcast.mock.calls[0]?.[2]).toBe(LivePushType.UserActions);
	});

	it("uid 是数字 → 与字符串白名单比对时不因类型不符而漏推", async () => {
		const { ctx, m } = makeCtx();
		m.hasTargets.mockReturnValue(true);
		const s = new RoomSession(ctx, makeSpecialUserSub()) as AnySession;

		await s.onUserAction(enterEvent(42));

		expect(m.safeBroadcast).toHaveBeenCalledTimes(1);
	});

	it("非进房动作(关注 / 分享 / 未知)→ 不推送", async () => {
		const { ctx, m } = makeCtx();
		m.hasTargets.mockReturnValue(true);
		const s = new RoomSession(ctx, makeSpecialUserSub()) as AnySession;

		for (const action of ["follow", "share", "unknown"] as const) {
			await s.onUserAction({ ...enterEvent(42), action });
		}

		expect(m.safeBroadcast).not.toHaveBeenCalled();
	});

	it("非特别关注的用户进房 → 不推送", async () => {
		const { ctx, m } = makeCtx();
		m.hasTargets.mockReturnValue(true);
		const s = new RoomSession(ctx, makeSpecialUserSub()) as AnySession;

		await s.onUserAction(enterEvent(999, "路人"));

		expect(m.safeBroadcast).not.toHaveBeenCalled();
	});

	it("没有 specialUserEnter 推送目标 → 不渲染也不推送", async () => {
		const { ctx, m } = makeCtx();
		m.hasTargets.mockReturnValue(false);
		const s = new RoomSession(ctx, makeSpecialUserSub()) as AnySession;

		await s.onUserAction(enterEvent(42));

		expect(m.renderSpecialUserEnter).not.toHaveBeenCalled();
		expect(m.safeBroadcast).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// RoomContext.sendLiveNotifyCard — LiveType → LivePushType 映射
//
// 这是 @全体 bug 修复正确性链条上唯一被验证缺失的一环:liveTypeAllowsAtAll /
// liveTypeToFeature 的入参是这里产出的 LivePushType,不是 LiveType。若此映射写错
// (例如把 ongoing/StopBroadcast 也映射成 StartBroadcasting=3),adapter 侧
// liveTypeAllowsAtAll 会误判,周期复推 / 下播又会 @全体——单测两端 adapter 表都
// 测不出来。这里用真实 RoomContext(其余依赖 stub)锁死整张映射表。
//
// 关键不变量:
//   - 仅 LiveType.StartBroadcasting(真开播)→ LivePushType.StartBroadcasting(3)
//     (= liveTypeAllowsAtAll 唯一返回 true 的入参 → 唯一允许 @全体)
//   - LiveType.LiveBroadcast(周期「正在直播」复推 / bootstrap「已在直播中」补推)
//     → LivePushType.Live(0) → liveTypeAllowsAtAll(0)=false → 不 @全体
//   - LiveType.FirstLiveBroadcast → LivePushType.Live(0)(注:实际从不传给本方法,
//     bootstrap 补推走的是 LiveBroadcast;此处仅守护 else 分支的稳健性)
//   - LiveType.StopBroadcast(下播)→ LivePushType.LiveEnd(9) → feature "liveEnd",
//     压根不进 atAll 分支(且 9 !== LiveType.StopBroadcast 数值 3 的巧合不影响,
//     因为入参契约是 LivePushType 不是 LiveType)
// ---------------------------------------------------------------------------

describe("RoomContext.sendLiveNotifyCard — LiveType → LivePushType 映射", () => {
	function makeRoomCtx(): {
		ctx: RoomContext;
		broadcastToTargets: ReturnType<typeof vi.fn>;
	} {
		const fakeServiceCtx: ServiceContext = {
			logger: { debug() {}, info() {}, warn() {}, error() {} },
			setInterval: () => ({ dispose() {} }),
			setTimeout: () => ({ dispose() {} }),
			onDispose: () => {},
		};
		const broadcastToTargets = vi.fn(async () => {});
		const ctx = new RoomContext({
			serviceCtx: fakeServiceCtx,
			// 其余依赖在 sendLiveNotifyCard 路径上不触达,给最小 stub。
			api: {} as never,
			push: {
				broadcastToTargets,
				broadcastSequenceToTargets: vi.fn(async () => {}),
				sendPrivateMsg: vi.fn(async () => {}),
			},
			contentBuilder: {
				text: (t: string) => ({ kind: "text", text: t }) as never,
				image: () => ({ kind: "image" }) as never,
				message: (segs: unknown[]) => segs as never,
				atAll: () => ({ kind: "at-all" }) as never,
			},
			templateRenderer: {} as never,
			wordcloudGenerator: {} as never,
			liveSummaryRequester: {} as never,
			danmakuCollector: {} as never,
			// imageRenderer=null → 没有 card 部件(buffer undefined),版式路径只剩文本,依旧调
			// push.broadcastToTargets(uid, msg, pushType),pushType 即被测的映射结果。
			getImageRenderer: () => null,
			config: {
				customGuardBuy: { enable: false },
				customLiveMsg: { enable: false },
				liveSummaryDefault: "",
			},
			emitEngineError: vi.fn(),
			emitLiveState: vi.fn(),
			emitViewers: vi.fn(),
			pickCardBackground: () => undefined,
			onRoomIdResolved: vi.fn(),
		});
		return { ctx, broadcastToTargets };
	}

	const liveRoomInfo = {
		live_time: "2026-01-01 00:00:00",
		short_id: 0,
		room_id: 12345,
		title: "标题",
		user_cover: "",
	} as never;
	const master = {
		username: "主播",
		userface: "",
		roomId: 12345,
		liveOpenFollowerNum: 100,
		liveEndFollowerNum: 100,
		liveFollowerChange: 0,
		medalName: "",
	};

	async function pushTypeFor(liveType: LiveType): Promise<LivePushType> {
		const { ctx, broadcastToTargets } = makeRoomCtx();
		await ctx.sendLiveNotifyCard({
			liveType,
			liveData: {},
			liveRoomInfo,
			master,
			cardStyle: { enable: false },
			uid: "u1",
			notifyMsg: "msg",
			messageLayout: defaultMessageKindLayout("live"),
		});
		expect(broadcastToTargets).toHaveBeenCalledTimes(1);
		return broadcastToTargets.mock.calls[0]?.[2] as LivePushType;
	}

	it("StartBroadcasting(真开播)→ LivePushType.StartBroadcasting(3) — 唯一 @全体-eligible", async () => {
		expect(await pushTypeFor(LiveType.StartBroadcasting)).toBe(LivePushType.StartBroadcasting);
		expect(LivePushType.StartBroadcasting).toBe(3); // liveTypeAllowsAtAll 唯一 true 入参
	});

	it("LiveBroadcast(周期「正在直播」复推 / bootstrap 补推)→ LivePushType.Live(0) — 不 @全体", async () => {
		expect(await pushTypeFor(LiveType.LiveBroadcast)).toBe(LivePushType.Live);
		expect(LivePushType.Live).toBe(0);
	});

	it("FirstLiveBroadcast → LivePushType.Live(0)(else 分支稳健性,实际不经此路径)", async () => {
		expect(await pushTypeFor(LiveType.FirstLiveBroadcast)).toBe(LivePushType.Live);
	});

	it("StopBroadcast(下播)→ LivePushType.LiveEnd(9) — 走 liveEnd feature,不进 atAll 分支", async () => {
		expect(await pushTypeFor(LiveType.StopBroadcast)).toBe(LivePushType.LiveEnd);
		expect(LivePushType.LiveEnd).toBe(9);
		// 防御 LiveType.StopBroadcast 数值(3)与 LivePushType.StartBroadcasting(3)
		// 的巧合:这里产出的是 9,liveTypeAllowsAtAll 入参契约是 LivePushType 不是
		// LiveType,所以下播绝不会被误判成 @全体-eligible 的开播。
		expect(LiveType.StopBroadcast as number).toBe(3);
		expect((LivePushType.LiveEnd as number) === 3).toBe(false);
	});

	it("NotLiveBroadcast → LivePushType.Live(0)(兜底 else,也不 @全体)", async () => {
		expect(await pushTypeFor(LiveType.NotLiveBroadcast)).toBe(LivePushType.Live);
	});
});

// ---------------------------------------------------------------------------
// resolvedCardStyle — live 卡自定义封面轮换(liveCoverImages)
// ---------------------------------------------------------------------------

describe("resolvedCardStyle live 封面轮换", () => {
	function countingPicker() {
		const cursors: Record<string, number> = {};
		const keys: string[] = [];
		const pick = (key: string, images: string[]): string => {
			keys.push(key);
			const i = cursors[key] ?? 0;
			cursors[key] = i + 1;
			return images[i % images.length] as string;
		};
		return { pick, keys };
	}

	it("多张封面 → 每次解析逐张轮换,游标 key 为 uid:live-cover", () => {
		const { ctx } = makeCtx();
		const { pick, keys } = countingPicker();
		// biome-ignore lint/suspicious/noExplicitAny: 覆写 mock ctx 的可选回调
		(ctx as any).pickBackground = pick;
		const s = new RoomSession(
			ctx,
			makeSub({ customCardStyle: { enable: true, liveCoverImages: ["c1", "c2"] } }),
		) as AnySession;
		expect(s.resolvedCardStyle("live").liveCoverImage).toBe("c1");
		expect(s.resolvedCardStyle("live").liveCoverImage).toBe("c2");
		expect(s.resolvedCardStyle("live").liveCoverImage).toBe("c1");
		expect(keys).toEqual(["u1:live-cover", "u1:live-cover", "u1:live-cover"]);
	});

	it("单张封面 → 不调选择器,沿用 engines 预填的 liveCoverImage", () => {
		const { ctx } = makeCtx();
		const s = new RoomSession(
			ctx,
			makeSub({
				customCardStyle: { enable: true, liveCoverImage: "solo", liveCoverImages: ["solo"] },
			}),
		) as AnySession;
		expect(s.resolvedCardStyle("live").liveCoverImage).toBe("solo");
		expect(ctx.pickBackground).not.toHaveBeenCalled();
	});

	it("无覆盖但引擎级全局默认配了多张 → 按 defaultLiveCoverImages 轮换", () => {
		const { ctx } = makeCtx();
		const { pick } = countingPicker();
		// biome-ignore lint/suspicious/noExplicitAny: 覆写 mock ctx 的可选回调
		(ctx as any).pickBackground = pick;
		// biome-ignore lint/suspicious/noExplicitAny: 测试注入引擎级全局默认
		(ctx as any).config.defaultLiveCoverImages = ["x", "y"];
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		expect(s.resolvedCardStyle("live").liveCoverImage).toBe("x");
		expect(s.resolvedCardStyle("live").liveCoverImage).toBe("y");
	});

	it("非 live kind 不做封面轮换(sc 解析不产生 liveCoverImage)", () => {
		const { ctx } = makeCtx();
		const { pick, keys } = countingPicker();
		// biome-ignore lint/suspicious/noExplicitAny: 覆写 mock ctx 的可选回调
		(ctx as any).pickBackground = pick;
		const s = new RoomSession(
			ctx,
			makeSub({ customCardStyle: { enable: true, liveCoverImages: ["c1", "c2"] } }),
		) as AnySession;
		expect(s.resolvedCardStyle("sc").liveCoverImage).toBeUndefined();
		expect(keys).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// bootstrap —— 服务器在 UP 已开播时启动
//
// 回归:统计侧的「直播时长」按 `now − startedAt` 现算,而 startedAt 全靠这条
// 事件带出来。bootstrap 里 setLiveStatus(true) 必须排在 useLiveRoomInfo 之后,
// 否则 liveRoomInfo 还是空的,事件退回「我们发现的时刻」—— 已经播掉的那几个
// 小时被整段吞掉,而构建与类型检查全绿,只有线上数字不对。
// ---------------------------------------------------------------------------

describe("RoomSession.bootstrap — 已在播时启动", () => {
	/** 让 bootstrap 能走到 live_status 判定那一步。 */
	function primeBootstrap(s: AnySession, ctx: RoomContext, liveTime: unknown): void {
		(ctx as unknown as Record<string, unknown>).startLiveRoomListener = vi.fn(async () => true);
		(ctx as unknown as Record<string, unknown>).closeListener = vi.fn();
		s.buildHandler = vi.fn(() => ({}));
		s.useLiveRoomInfo = vi.fn(async () => {
			s.liveRoomInfo = {
				live_time: liveTime,
				live_status: 1,
				short_id: 0,
				room_id: 12345,
				title: "标题",
				user_cover: "",
			};
			return true;
		});
		s.useMasterInfo = vi.fn(async () => {
			s.masterInfo = { username: "主播", userface: "", roomId: "r1", liveOpenFollowerNum: 1 };
			return true;
		});
	}

	it("带出 B 站的真实开播时刻,而不是我们发现的时刻", async () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		// live_time 恒为北京时间字符串,换算后应是当日 12:00Z。
		primeBootstrap(s, ctx, "2026-05-16 20:00:00");
		await s.bootstrap();
		expect(m.emitLiveState).toHaveBeenCalledWith("u1", "live", "2026-05-16T12:00:00.000Z");
	});

	it("按 UTC+8 解析 —— 服务器时区不影响换算结果", async () => {
		// 这一条单独立着是因为踩过:交给消费方 Date.parse 会当本地时间读,
		// 非北京时区的宿主上平白差 8 小时,而北京时区的开发机上测不出来。
		const { ctx, m } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		primeBootstrap(s, ctx, "2026-01-01 00:00:00");
		await s.bootstrap();
		expect(m.emitLiveState).toHaveBeenCalledWith("u1", "live", "2025-12-31T16:00:00.000Z");
	});

	it("live_time 缺失 / 解析不出 → 不带 startedAt,由消费方回退,不伪造时刻", async () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		primeBootstrap(s, ctx, "不是时间");
		await s.bootstrap();
		expect(m.emitLiveState).toHaveBeenCalledWith("u1", "live", undefined);
	});
});

// ---------------------------------------------------------------------------
// onLiveStart —— 第二场直播不能继承上一场的开播时刻
//
// 回归:`useLiveRoomInfo` 的非 Start 分支**刻意冻结** `live_time`(下播卡要靠它
// 算已播时长),而下播走的正是那条分支 —— 于是第一场结束后 `live_time` 永久停在
// 第一场的开播时刻。onLiveStart 里 setLiveStatus(true) 排在刷新之前,读到的就是
// 这个陈旧值:第二场带着昨天的时间落盘,统计侧按 `startedAt` 认场次,两场合并成
// 一场几十小时的直播。
//
// 上面 bootstrap 那组测试守的是同一个不变式,但只覆盖了 bootstrap 路径;WS 路径
// 的顺序恰好是反的,所以全绿也照样错。
// ---------------------------------------------------------------------------

describe("RoomSession.onLiveStart — 第二场直播的开播时刻", () => {
	/** 造出「第一场已结束、liveRoomInfo 里还留着它的 live_time」这个现场。 */
	function primeSecondSession(s: AnySession, nextLiveTime: string): void {
		s.liveRoomInfo = {
			live_time: "2026-05-16 20:00:00", // 上一场,已经过去了
			live_status: 0,
			short_id: 0,
			room_id: 12345,
			title: "标题",
			user_cover: "",
		};
		s.liveStatus = false;
		s.lastLiveStart = 0; // 早已过冷却
		s.armPeriodicTimer = vi.fn();
		s.useLiveRoomInfo = vi.fn(async () => {
			s.liveRoomInfo = {
				live_time: nextLiveTime,
				live_status: 1,
				short_id: 0,
				room_id: 12345,
				title: "标题",
				user_cover: "",
			};
			return true;
		});
		s.useMasterInfo = vi.fn(async () => {
			s.masterInfo = { username: "主播", userface: "", roomId: "r1", liveOpenFollowerNum: 1 };
			return true;
		});
	}

	it("绝不把上一场的开播时刻当成这一场的", async () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		primeSecondSession(s, "2026-05-17 20:00:00");
		await s.onLiveStart();
		const startedAt = m.emitLiveState.mock.calls.find((c) => c[1] === "live")?.[2];
		expect(startedAt).not.toBe("2026-05-16T12:00:00.000Z");
	});

	it("带出本场的真实开播时刻 —— 与 bootstrap / 重连核对用同一把尺子", async () => {
		// **场次身份就是这个字符串**。统计侧按 startedAt 认场次(store 精确相等匹配),
		// 而同一场会被观测到不止一次:WS 首帧、断线重连后的核对、重启后的 bootstrap。
		// 后两条走 useLiveRoomInfo 拿 B 站的 live_time,所以首帧也必须用同一把尺子 ——
		// 用「我们发现的时刻」的话两个 ts 差着几秒,byStart 认不出,同一场被记成两条
		// 且时间区间重叠:场次数、总时长、场均、热力图、场均峰值全部虚高,而且错误
		// 写进 append-only 文件后事后无法修。
		const { ctx, m } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		primeSecondSession(s, "2026-05-17 20:00:00");
		await s.onLiveStart();
		expect(m.emitLiveState).toHaveBeenCalledWith("u1", "live", "2026-05-17T12:00:00.000Z");
	});

	it("live_time 解析不出 → 不带 startedAt,由消费方回退,不伪造时刻", async () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		primeSecondSession(s, "不是时间");
		await s.onLiveStart();
		expect(m.emitLiveState).toHaveBeenCalledWith("u1", "live", undefined);
	});

	it("准备期间直播就结束了 —— 不翻成在播,免得永远卡在「直播中」", async () => {
		// 为了带出真实 live_time,setLiveStatus(true) 必须排在刷新之后,于是整段 await
		// 期间 liveStatus 都是 false。而重连成功后新 WS 已经在派发事件了,这时到达的
		// END 会撞上 handleLiveEnd 的 `!liveStatus` 守卫被**静默丢弃**(grace 也拦不住:
		// 它同样要求 liveStatus 为真)。若 await 结束后仍无条件翻成在播,这一场就再也
		// 等不到第二条 END —— 面板恒显「直播中」,统计侧按 now−startedAt 计时长,
		// 每天自增 24 小时且无上限,而默认 pushTime=0 连轮询兜底都没有。
		const { ctx } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		primeSecondSession(s, "2026-05-17 20:00:00");
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const refresh = s.useLiveRoomInfo;
		// 只闸开播那次刷新。连下播那条一起闸住的话,handleLiveEnd 也会停在这里,
		// 而我们正 await 着它 —— 测试自己把自己锁死。
		s.useLiveRoomInfo = vi.fn(async (t: unknown) => {
			if (t === LiveType.StartBroadcasting) await gate;
			return refresh(t);
		});
		const starting = s.onLiveStart();
		await s.onLiveEnd(); // 准备期间 UP 真下播
		release();
		await starting;
		expect(s.liveStatus).toBe(false);
	});
});
