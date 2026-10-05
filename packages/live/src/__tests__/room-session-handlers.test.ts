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
import { Settings } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { CustomGuardBuyLike, SubItemView } from "../push-like";
import { LivePushType, wantsLiveEndExtras } from "../push-like";
import { RoomContext } from "../room-helpers";
import { RoomSession } from "../room-session";
import { LiveTemplateRenderer } from "../template-renderer";
import { LiveType } from "../types";

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
		customGuardBuy: { enable: false },
		customLiveSummary: { enable: false },
		customSpecialDanmakuUsers: { enable: false, msgTemplate: "" },
		customSpecialUsersEnterTheRoom: { enable: false, msgTemplate: "" },
		minScPrice: 0,
		minGuardLevel: 3,
		liveStreaming: false,
		streamingIntervalHours: 1,
		catchUpOnBoot: false,
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
	renderLiveStreaming: ReturnType<typeof vi.fn>;
	renderLiveEnd: ReturnType<typeof vi.fn>;
	renderSpecialUserEnter: ReturnType<typeof vi.fn>;
	sendLiveNotifyCard: ReturnType<typeof vi.fn>;
	stopMonitoring: ReturnType<typeof vi.fn>;
	emitLiveState: ReturnType<typeof vi.fn>;
	isSubscribed: ReturnType<typeof vi.fn>;
	collectsDanmaku: ReturnType<typeof vi.fn>;
	safeBroadcast: ReturnType<typeof vi.fn>;
}

function makeCtx(opts?: { customGuardBuy?: CustomGuardBuyLike }): {
	ctx: RoomContext;
	m: CtxMocks;
} {
	const fakeServiceCtx: ServiceContext = {
		logger: { debug() {}, info() {}, warn() {}, error() {} },
		setInterval: () => ({ dispose() {} }),
		setTimeout: () => ({ dispose() {} }),
		onDispose: () => {},
		signal: new AbortController().signal,
		track: () => {},
	};
	const m: CtxMocks = {
		recordDanmaku: vi.fn(),
		broadcastToTargets: vi.fn(async () => {}),
		getUserInfoInLive: vi.fn(async () => ({ code: 0, data: { uname: "捧场人", face: "f" } })),
		generateSCCard: vi.fn(async () => Buffer.from("sc")),
		generateGuardCard: vi.fn(async () => Buffer.from("guard")),
		renderGuardBuy: vi.fn(() => "上舰文案"),
		renderLiveStart: vi.fn(() => "开播啦"),
		renderLiveStreaming: vi.fn(() => "直播中"),
		renderLiveEnd: vi.fn(() => "下播了"),
		renderSpecialUserEnter: vi.fn(() => "进房文案"),
		sendLiveNotifyCard: vi.fn(async () => {}),
		stopMonitoring: vi.fn(),
		emitLiveState: vi.fn(),
		isSubscribed: vi.fn(() => false),
		collectsDanmaku: vi.fn((sub: SubItemView) => wantsLiveEndExtras(sub)),
		safeBroadcast: vi.fn(),
	};
	const ctx = {
		serviceCtx: fakeServiceCtx,
		logger: fakeServiceCtx.logger,
		isDisposed: () => false,
		config: {
			customGuardBuy: opts?.customGuardBuy ?? { enable: false },
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
			renderLiveStreaming: m.renderLiveStreaming,
			renderLiveEnd: m.renderLiveEnd,
			renderSpecialDanmaku: () => "",
			renderSpecialUserEnter: m.renderSpecialUserEnter,
		},
		danmakuCollector: { recordDanmaku: m.recordDanmaku, clear: vi.fn(), registerRoom: vi.fn() },
		isSubscribed: m.isSubscribed,
		collectsDanmaku: m.collectsDanmaku,
		safeBroadcast: m.safeBroadcast,
		sendLiveNotifyCard: m.sendLiveNotifyCard,
		stopMonitoring: m.stopMonitoring,
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
			makeSub({
				liveEnd: true,
				extras: { atAllPost: false, atAllLiveStart: true, wordcloud: true, liveSummary: false },
			}),
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

	// per-UP 的皮肤 id 要一路走到 generate* —— 断在哪一跳都是「选得动、存得住、就是不生效」。
	it("per-UP 皮肤 id 透传给 generateSCCard(样式没启用也照带)", async () => {
		const { ctx, m } = makeCtx();
		m.isSubscribed.mockImplementation((_s: unknown, feat: string) => feat === "superchat");
		const s = new RoomSession(
			ctx,
			makeSub({ superchat: true, minScPrice: 30, cardSkin: "k7xxx-c0ffee" }),
		) as AnySession;
		await s.onIncomeSuperChat(scBody);
		// 验红:把 room-session.ts 里 SC 那一处的 `...this.skinChoice()` 删掉,这条红。
		expect(m.generateSCCard.mock.calls[0]?.[1]).toMatchObject({ cardSkin: "k7xxx-c0ffee" });
	});

	// per-UP 旋钮覆盖(ADR-0014 决策 17 的 🔗)不分卡种:SC 卡也吃这位 UP 那一份。
	// 验红:把 room-session.ts 里 SC 那一处的皮肤选项换回只带 `cardSkin`,这条红。
	it("per-UP 旋钮覆盖随皮肤 id 透传给 generateSCCard(样式没启用也照带)", async () => {
		const { ctx, m } = makeCtx();
		m.isSubscribed.mockImplementation((_s: unknown, feat: string) => feat === "superchat");
		const cardSkinKnobs = { "k7xxx-c0ffee": { accent: "#aaaaaa" } };
		const s = new RoomSession(
			ctx,
			makeSub({ superchat: true, minScPrice: 30, cardSkin: "k7xxx-c0ffee", cardSkinKnobs }),
		) as AnySession;
		await s.onIncomeSuperChat(scBody);
		expect(m.generateSCCard.mock.calls[0]?.[1]).toEqual({
			cardSkin: "k7xxx-c0ffee",
			cardSkinKnobs,
		});
	});

	it("有 per-kind sc 样式 → generateSCCard 收到 sc 专属 colorOptions(而非基准)", async () => {
		const { ctx, m } = makeCtx();
		m.isSubscribed.mockImplementation((_s: unknown, feat: string) => feat === "superchat");
		const s = new RoomSession(
			ctx,
			makeSub({
				superchat: true,
				minScPrice: 30,
				customCardStyle: { enable: true, font: "Base Sans" },
				customCardStyleByKind: {
					sc: { enable: true, font: "SC Sans" },
				},
			}),
		) as AnySession;
		await s.onIncomeSuperChat(scBody);
		expect(m.generateSCCard).toHaveBeenCalledTimes(1);
		// 第二参 = colorOptions(sc 专属覆盖基准)。
		expect(m.generateSCCard.mock.calls[0]?.[1]).toMatchObject({ font: "SC Sans" });
	});

	it("无 per-kind sc 覆盖 → generateSCCard 回退到基准 customCardStyle", async () => {
		const { ctx, m } = makeCtx();
		m.isSubscribed.mockImplementation((_s: unknown, feat: string) => feat === "superchat");
		const s = new RoomSession(
			ctx,
			makeSub({
				superchat: true,
				minScPrice: 30,
				customCardStyle: { enable: true, font: "Base Sans" },
			}),
		) as AnySession;
		await s.onIncomeSuperChat(scBody);
		expect(m.generateSCCard.mock.calls[0]?.[1]).toMatchObject({ font: "Base Sans" });
	});

	// 样式没启用 = 一个样式字段都不许递出去(渲染器按「缺省 → 吃全局 config」判,递一份
	// 禁用的样式过去就等于把它启用了)。皮肤 id 不是样式,它恒在 —— 出图总得知道画哪一套。
	it("基准与 per-kind 都未启用 → generateSCCard 只收到皮肤 id,一个样式字段都没有", async () => {
		const { ctx, m } = makeCtx();
		m.isSubscribed.mockImplementation((_s: unknown, feat: string) => feat === "superchat");
		const s = new RoomSession(ctx, makeSub({ superchat: true, minScPrice: 30 })) as AnySession;
		await s.onIncomeSuperChat(scBody);
		expect(m.generateSCCard.mock.calls[0]?.[1]).toEqual({ cardSkin: undefined });
	});

	// ── ㉓a:钉住门槛与兜底文字的现状 ──────────────────────────────────────────
	// ㉓ 要把门槛搬去 `defaults.superchat.minAmount`、把出卡改成不查发送者;这几条是搬家前的行为,
	// 搬家的那几步不许悄悄改它(要改的地方测试名写了「现状」,到时连测试一起改)。

	describe("minScPrice 门槛:等于放行、低于拦", () => {
		// 验红:把 room-session.ts 里 `body.price < this.sub.minScPrice` 改成 `<=`,「等于门槛」那条红;
		// 把这一行整句删掉,「低于门槛」几条红。
		it.each([
			// [门槛, 这条 SC 的价格(元), 放行?]
			[50, 49, false],
			[50, 50, true],
			[50, 51, true],
			[30, 29, false],
			[30, 30, true],
			[0, 1, true],
		] as const)("门槛 %s 元 × 这条 %s 元 → 放行=%s", async (min, price, pass) => {
			const { ctx, m } = makeCtx();
			m.isSubscribed.mockImplementation((_s: unknown, feat: string) => feat === "superchat");
			const s = new RoomSession(ctx, makeSub({ superchat: true, minScPrice: min })) as AnySession;
			await s.onIncomeSuperChat({ ...scBody, price });
			expect(m.broadcastToTargets).toHaveBeenCalledTimes(pass ? 1 : 0);
			if (pass) {
				expect(m.broadcastToTargets.mock.calls[0]?.[2]).toBe(LivePushType.Superchat);
			} else {
				// 门槛在查发送者之前:被拦掉的不该白打一次接口。
				expect(m.getUserInfoInLive).not.toHaveBeenCalled();
			}
		});

		// 现状:醒目留言的正文在判门槛**之前**就记进弹幕收集,被门槛挡掉的也算进词云。
		// 验红:把门槛那一句 `if (body.price < this.sub.minScPrice) return;` 挪到 `recordDanmaku` 之前,这条红。
		it("现状:被门槛挡掉的 SC,正文照样先记进弹幕收集", async () => {
			const { ctx, m } = makeCtx();
			m.isSubscribed.mockImplementation((_s: unknown, feat: string) => feat === "superchat");
			m.collectsDanmaku.mockReturnValue(true);
			const s = new RoomSession(ctx, makeSub({ superchat: true, minScPrice: 100 })) as AnySession;
			await s.onIncomeSuperChat({ ...scBody, price: 50 });
			expect(m.recordDanmaku).toHaveBeenCalledWith("r1", "加油", "粉丝");
			expect(m.broadcastToTargets).not.toHaveBeenCalled();
		});
	});

	/**
	 * 兜底文字原文(现状)。出不了卡的两条路各推一句文字,**用的名字不同**:查发送者失败时只有消息里
	 * 带的名字(「粉丝」),出卡失败时用的是查回来的名字(「捧场人」)。㉓c 起醒目留言出卡前不再查
	 * 发送者、总是出卡,这两句到时再改;改之前它们就是线上今天推出去的字。
	 */
	describe("出不了卡 → 文字兜底(现状)", () => {
		/** 让一条 50 元的 SC 经 `arrange` 布好局,返回推出去的那条消息与这一轮的替身。 */
		async function scPushOf(
			arrange: (m: CtxMocks, ctx: RoomContext) => void,
		): Promise<{ pushed: unknown; m: CtxMocks }> {
			const { ctx, m } = makeCtx();
			m.isSubscribed.mockImplementation((_s: unknown, feat: string) => feat === "superchat");
			arrange(m, ctx);
			const s = new RoomSession(ctx, makeSub({ superchat: true, minScPrice: 30 })) as AnySession;
			s.masterInfo = { username: "主播", userface: "", roomId: "r1", liveOpenFollowerNum: 0 };
			await s.onIncomeSuperChat(scBody);
			expect(m.broadcastToTargets).toHaveBeenCalledTimes(1);
			expect(m.broadcastToTargets.mock.calls[0]?.[2]).toBe(LivePushType.Superchat);
			return { pushed: m.broadcastToTargets.mock.calls[0]?.[1], m };
		}

		// 验红:改 room-session.ts 里 `if (data.code !== 0)` 那一支文字里任一个字(含全角括号),这条红。
		it("查发送者失败 → 用消息里带的名字,原文「【主播的直播间】粉丝的SC:加油（50元）」", async () => {
			const { pushed, m } = await scPushOf((mm) => {
				mm.getUserInfoInLive.mockResolvedValueOnce({ code: -1, data: {} });
			});
			expect(pushed).toEqual([{ kind: "text", text: "【主播的直播间】粉丝的SC:加油（50元）" }]);
			// 这一支根本没去出卡。
			expect(m.generateSCCard).not.toHaveBeenCalled();
		});

		// 验红:改 room-session.ts 末尾 `const fallback = …` 里任一个字,这条与下一条红。
		it("出卡抛错 → 用查回来的名字,原文「【主播的直播间】捧场人的SC:加油（50元）」", async () => {
			const { pushed } = await scPushOf((m) => {
				m.generateSCCard.mockRejectedValueOnce(new Error("boom"));
			});
			expect(pushed).toEqual([{ kind: "text", text: "【主播的直播间】捧场人的SC:加油（50元）" }]);
		});

		it("图片渲染没开(没有出图器)→ 同一句兜底", async () => {
			const { pushed } = await scPushOf((_m, ctx) => {
				(ctx as AnySession).imageRenderer = null;
			});
			expect(pushed).toEqual([{ kind: "text", text: "【主播的直播间】捧场人的SC:加油（50元）" }]);
		});
	});

	// 从前这里有三条「SC 卡背景图每次推送轮换」(per-kind 多图 / 单图不轮 / 落回全局默认
	// 图廊)。整条 `cardStyle.backgroundImages` 链 2026-09-20 删掉(背景图归皮肤的 `image`
	// 旋钮),同构的**直播封面**轮换仍由下面的「resolvedCardStyle live 封面轮换」钉着。
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

	it("未订阅 membership → 早 return", async () => {
		const { ctx, m } = makeCtx();
		m.isSubscribed.mockReturnValue(false);
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		await s.onGuardBuy(guardBody);
		expect(m.broadcastToTargets).not.toHaveBeenCalled();
	});

	it("guard_level 高于阈值(等级不够)→ 不推", async () => {
		// sub.minGuardLevel=1(总督);Captain(3) > 1 → return
		const { ctx, m } = makeCtx();
		m.isSubscribed.mockImplementation((_s: unknown, feat: string) => feat === "membership");
		const s = new RoomSession(ctx, makeSub({ membership: true, minGuardLevel: 1 })) as AnySession;
		await s.onGuardBuy(guardBody);
		expect(m.broadcastToTargets).not.toHaveBeenCalled();
	});

	// ── ㉓a:钉住门槛、兜底文字与官方图的现状 ──────────────────────────────────
	// ㉓b 起档位由翻译按档位表认、认不出的丢掉;这里先把今天怎么放行、怎么兜底钉死。

	/** 官方上舰图(按档位):总督 / 提督 / 舰长。逐字钉 —— 图链表合并时不许换。 */
	const OFFICIAL_GUARD_IMG = {
		[GuardLevel.Governor]:
			"https://s1.hdslb.com/bfs/static/blive/live-pay-mono/relation/relation/assets/governor-DpDXKEdA.png",
		[GuardLevel.Admiral]:
			"https://s1.hdslb.com/bfs/static/blive/live-pay-mono/relation/relation/assets/supervisor-u43ElIjU.png",
		[GuardLevel.Captain]:
			"https://s1.hdslb.com/bfs/static/blive/live-pay-mono/relation/relation/assets/captain-Bjw5Byb5.png",
	} as const;

	describe("minGuardLevel × 事件档位的放行表", () => {
		/** 一条 `guard_level` 经 `onGuardBuy`,返回推送替身(默认路径:custom 关、出图器在)。 */
		async function runWith(min: 1 | 2 | 3, level: number): Promise<CtxMocks> {
			const { ctx, m } = makeCtx();
			m.isSubscribed.mockImplementation((_s: unknown, feat: string) => feat === "membership");
			const s = new RoomSession(
				ctx,
				makeSub({ membership: true, minGuardLevel: min }),
			) as AnySession;
			await s.onGuardBuy({ ...guardBody, guard_level: level });
			return m;
		}

		// 规则:`guard_level > minGuardLevel` 就拦。门槛 1 = 只推总督,2 = 提督以上,3 = 全推。
		// 验红:把 room-session.ts 里 `body.guard_level > this.sub.minGuardLevel` 的 `>` 改成 `>=`,
		// 门槛等于档位的那三格(1×1、2×2、3×3)红;改成 `<`,整张表几乎全红。
		it.each([
			// [门槛, 事件档位(1 总督 / 2 提督 / 3 舰长), 放行?]
			[1, 1, true],
			[1, 2, false],
			[1, 3, false],
			[2, 1, true],
			[2, 2, true],
			[2, 3, false],
			[3, 1, true],
			[3, 2, true],
			[3, 3, true],
		] as const)("门槛 %s × 事件第 %s 档 → 放行=%s", async (min, level, pass) => {
			const m = await runWith(min, level);
			expect(m.broadcastToTargets).toHaveBeenCalledTimes(pass ? 1 : 0);
			if (pass) expect(m.broadcastToTargets.mock.calls[0]?.[2]).toBe(LivePushType.LiveGuardBuy);
		});

		// 现状:`guard_level` 是 0(没有这一档)时,`0 > 门槛` 恒假,三个门槛都放行,照常出一张 0 档的卡。
		// ㉓b 起认不出的档位会被丢掉并记一条警告,到时这条改成「丢」。
		// 验红:把 `body.guard_level > this.sub.minGuardLevel` 换成 `!(guard_level >= 1 && guard_level <= min)`
		// (按「档位在 1..门槛 之内」判有效),这三条红。
		it.each([1, 2, 3] as const)(
			"现状:guard_level 为 0 → 门槛 %s 都放行(没有按档位判有效)",
			async (min) => {
				const m = await runWith(min, 0);
				expect(m.broadcastToTargets).toHaveBeenCalledTimes(1);
				expect(m.generateGuardCard.mock.calls[0]?.[0]).toMatchObject({ guardLevel: 0 });
			},
		);

		// 现状:比 3 大的数反而被拦 —— 不是认出了「没有这一档」,只是 `>` 顺带拦的。
		it.each([1, 2, 3] as const)(
			"现状:guard_level 为 4 → 门槛 %s 都拦(`>` 顺带拦的)",
			async (min) => {
				const m = await runWith(min, 4);
				expect(m.broadcastToTargets).not.toHaveBeenCalled();
			},
		);
	});

	/**
	 * 兜底文字原文(现状):custom 关着时,出不了卡的三种情况(出图器没开 / 查用户失败 / 出卡抛错)推出去
	 * 的是同一条消息 —— 官方图 + 一句「加入了大航海」,括号里的档名取自事件自带的 `gift_name`。
	 */
	describe("出不了卡 → 官方图 + 文字兜底(现状)", () => {
		async function guardPushOf(
			level: GuardLevel,
			giftName: string,
			arrange: (m: CtxMocks, ctx: RoomContext) => void,
		): Promise<unknown> {
			const { ctx, m } = makeCtx();
			// 看得见图片地址。
			(ctx as AnySession).contentBuilder.image = (src: string) => ({ kind: "image", src });
			m.isSubscribed.mockImplementation((_s: unknown, feat: string) => feat === "membership");
			arrange(m, ctx);
			const s = new RoomSession(ctx, makeSub({ membership: true })) as AnySession;
			s.masterInfo = { username: "主播", userface: "", roomId: "r1", liveOpenFollowerNum: 0 };
			await s.onGuardBuy({
				guard_level: level,
				gift_name: giftName,
				user: { uname: "船员", uid: 7 },
			});
			expect(m.broadcastToTargets).toHaveBeenCalledTimes(1);
			expect(m.broadcastToTargets.mock.calls[0]?.[2]).toBe(LivePushType.LiveGuardBuy);
			return m.broadcastToTargets.mock.calls[0]?.[1];
		}

		// 验红:改 room-session.ts 末尾兜底里「加入了大航海（」那句的任一个字(含全角括号),这一组红;
		// 改 `room-context.ts` 里 `GUARD_LEVEL_IMG` 任一档的图链,对应那一档红。
		it.each([
			[GuardLevel.Governor, "总督"],
			[GuardLevel.Admiral, "提督"],
			[GuardLevel.Captain, "舰长"],
		] as const)(
			"查用户失败 · 上第 %s 档 → 该档官方图 + 「加入了大航海（%s）」",
			async (level, giftName) => {
				const pushed = await guardPushOf(level, giftName, (m) => {
					m.getUserInfoInLive.mockResolvedValueOnce({ code: -1, data: {} });
				});
				expect(pushed).toEqual([
					{ kind: "image", src: OFFICIAL_GUARD_IMG[level] },
					{ kind: "text", text: `【主播的直播间】船员加入了大航海（${giftName}）` },
				]);
			},
		);

		it("出卡抛错 → 同一条兜底", async () => {
			const pushed = await guardPushOf(GuardLevel.Captain, "舰长", (m) => {
				m.generateGuardCard.mockRejectedValueOnce(new Error("boom"));
			});
			expect(pushed).toEqual([
				{ kind: "image", src: OFFICIAL_GUARD_IMG[GuardLevel.Captain] },
				{ kind: "text", text: "【主播的直播间】船员加入了大航海（舰长）" },
			]);
		});

		it("图片渲染没开(没有出图器)→ 同一条兜底,而且不去查用户", async () => {
			let lookups: ReturnType<typeof vi.fn> | undefined;
			const pushed = await guardPushOf(GuardLevel.Captain, "舰长", (m, ctx) => {
				(ctx as AnySession).imageRenderer = null;
				lookups = m.getUserInfoInLive;
			});
			expect(pushed).toEqual([
				{ kind: "image", src: OFFICIAL_GUARD_IMG[GuardLevel.Captain] },
				{ kind: "text", text: "【主播的直播间】船员加入了大航海（舰长）" },
			]);
			expect(lookups).not.toHaveBeenCalled();
		});
	});

	it("customGuardBuy.enable → 走模板渲染分支,broadcastToTargets(LiveGuardBuy)", async () => {
		const { ctx, m } = makeCtx();
		m.isSubscribed.mockImplementation((_s: unknown, feat: string) => feat === "membership");
		const s = new RoomSession(
			ctx,
			makeSub({
				membership: true,
				customGuardBuy: {
					enable: true,
					captain: { template: "", imageUrl: "cap" },
					commander: { template: "", imageUrl: "sup" },
					governor: { template: "", imageUrl: "gov" },
				},
			}),
		) as AnySession;
		await s.onGuardBuy(guardBody);
		expect(m.renderGuardBuy).toHaveBeenCalledTimes(1);
		expect(m.broadcastToTargets).toHaveBeenCalledTimes(1);
		expect(m.broadcastToTargets.mock.calls[0]?.[2]).toBe(LivePushType.LiveGuardBuy);
	});

	/**
	 * 回归守卫 —— 自定义上舰的**文案**和图片一样按档位取。
	 *
	 * 此前宿主只把 `captain.template` 当成唯一一条文案往下传,图片却是按 guard_level
	 * 分三档取的:面板上给提督 / 总督写的专属文案运行时从来不读,有人上总督,推出去
	 * 的是舰长那句。这里用真的模板渲染器,钉「哪一档来,就用哪一档的文案和图」。
	 */
	describe("自定义开启 → 文案与图片按事件的档位取", () => {
		const tiers: CustomGuardBuyLike = {
			enable: true,
			governor: { template: "{uname} 成了 {mname} 的总督", imageUrl: "gov.png" },
			commander: { template: "{uname} 成了 {mname} 的提督", imageUrl: "com.png" },
			captain: { template: "{uname} 成了 {mname} 的舰长", imageUrl: "cap.png" },
		};
		const cases = [
			["总督", GuardLevel.Governor, "船员 成了 主播 的总督", "gov.png"],
			["提督", GuardLevel.Admiral, "船员 成了 主播 的提督", "com.png"],
			["舰长", GuardLevel.Captain, "船员 成了 主播 的舰长", "cap.png"],
		] as const;

		/** 用真渲染器 + 能看见图片地址的 contentBuilder 跑一次上舰,返回推出去的那条消息。 */
		async function pushOf(
			level: GuardLevel,
			where: { sub?: CustomGuardBuyLike; global?: CustomGuardBuyLike },
		): Promise<unknown> {
			const { ctx, m } = makeCtx(where.global ? { customGuardBuy: where.global } : undefined);
			const real = new LiveTemplateRenderer();
			m.renderGuardBuy.mockImplementation((p) => real.renderGuardBuy(p));
			(ctx as AnySession).contentBuilder.image = (src: string) => ({ kind: "image", src });
			m.isSubscribed.mockImplementation((_s: unknown, feat: string) => feat === "membership");
			const s = new RoomSession(
				ctx,
				makeSub({
					membership: true,
					minGuardLevel: 3,
					customGuardBuy: where.sub ?? { enable: false },
				}),
			) as AnySession;
			s.masterInfo = { username: "主播", userface: "", roomId: "r1", liveOpenFollowerNum: 0 };
			await s.onGuardBuy({
				guard_level: level,
				gift_name: "礼物",
				user: { uname: "船员", uid: 7 },
			});
			expect(m.broadcastToTargets).toHaveBeenCalledTimes(1);
			return m.broadcastToTargets.mock.calls[0]?.[1];
		}

		it.each(cases)("per-UP 开启:上%s → 推该档的文案与图片", async (_label, level, text, img) => {
			expect(await pushOf(level, { sub: tiers })).toEqual([
				{ kind: "image", src: img },
				{ kind: "text", text },
			]);
		});

		it.each(cases)(
			"per-UP 未开、全局开启:上%s → 推该档的文案与图片",
			async (_label, level, text, img) => {
				expect(await pushOf(level, { global: tiers })).toEqual([
					{ kind: "image", src: img },
					{ kind: "text", text },
				]);
			},
		);

		// 回归:开了自定义文案、那一档的图片没填 → 推官方图。默认值里每档 `imageUrl` 就是空串,所以
		// 「开了自定义文案但没填图」的人都会中;空串不是「缺」,`?? ` 兜不住,推出去的是一张地址为空的图。
		// 文案那一侧不动:`template` 空串仍然推空文案(「跟随体系默认」归 ㉓d)。
		// 验红:把 room-session.ts 里的 `tier?.imageUrl || guardImg` 改回 `tier?.imageUrl ?? guardImg`,
		// 「空串」那一组红,「缺键」那一组仍绿(它本来就对)。
		describe.each([
			["空串", ""],
			["缺键", undefined],
		] as const)("该档图片是%s", (_kind, imageUrl) => {
			const tierOf = (template: string): { template: string; imageUrl?: string } =>
				imageUrl === undefined ? { template } : { template, imageUrl };
			const noImage: CustomGuardBuyLike = {
				enable: true,
				governor: tierOf("{uname} 成了 {mname} 的总督"),
				commander: tierOf("{uname} 成了 {mname} 的提督"),
				captain: tierOf("{uname} 成了 {mname} 的舰长"),
			};

			it.each(cases)("上%s → 回落该档官方图,文案照出", async (_label, level, text) => {
				expect(await pushOf(level, { sub: noImage })).toEqual([
					{ kind: "image", src: OFFICIAL_GUARD_IMG[level as 1 | 2 | 3] },
					{ kind: "text", text },
				]);
			});

			it("文案也是空串 → 仍推空文案(现状,不跟着回落)", async () => {
				const bare: CustomGuardBuyLike = {
					enable: true,
					captain: tierOf(""),
				};
				expect(await pushOf(GuardLevel.Captain, { sub: bare })).toEqual([
					{ kind: "image", src: OFFICIAL_GUARD_IMG[GuardLevel.Captain] },
					{ kind: "text", text: "" },
				]);
			});
		});

		// 现状:认不出的档位(guard_level 为 0)+ 自定义开着 → 取不到那一档,带着一张地址为空的图和
		// 一句空文案照推。㉓b 起这种事件在翻译那一步被丢掉并记一条警告,到时这条改成「丢」。
		// 验红:让 `GUARD_LEVEL_TIER[0]` 指向某一档(比如 `governor`),这条红。
		it("现状:guard_level 为 0 → 空图 + 空文案照推", async () => {
			expect(await pushOf(GuardLevel.None, { sub: tiers })).toEqual([
				{ kind: "image", src: "" },
				{ kind: "text", text: "" },
			]);
		});
	});

	it("默认(custom 关)+ generateGuardCard + api code0 → 图片卡片(LiveGuardBuy)", async () => {
		const { ctx, m } = makeCtx();
		m.isSubscribed.mockImplementation((_s: unknown, feat: string) => feat === "membership");
		m.getUserInfoInLive.mockResolvedValueOnce({
			code: 0,
			data: { uname: "船员", face: "f", is_admin: false },
		});
		const s = new RoomSession(ctx, makeSub({ membership: true })) as AnySession;
		await s.onGuardBuy(guardBody);
		expect(m.generateGuardCard).toHaveBeenCalledTimes(1);
		expect(m.broadcastToTargets).toHaveBeenCalledTimes(1);
		expect(m.broadcastToTargets.mock.calls[0]?.[2]).toBe(LivePushType.LiveGuardBuy);
	});

	it("per-UP 皮肤 id 透传给 generateGuardCard", async () => {
		const { ctx, m } = makeCtx();
		m.isSubscribed.mockImplementation((_s: unknown, feat: string) => feat === "membership");
		const s = new RoomSession(
			ctx,
			makeSub({ membership: true, minGuardLevel: 3, cardSkin: "k8yyy-facade" }),
		) as AnySession;
		await s.onGuardBuy(guardBody);
		expect(m.generateGuardCard.mock.calls[0]?.[2]).toMatchObject({ cardSkin: "k8yyy-facade" });
	});

	// 验红:把 room-session.ts 里上舰那一处的皮肤选项换回只带 `cardSkin`,这条红。
	it("per-UP 旋钮覆盖随皮肤 id 透传给 generateGuardCard", async () => {
		const { ctx, m } = makeCtx();
		m.isSubscribed.mockImplementation((_s: unknown, feat: string) => feat === "membership");
		const cardSkinKnobs = { "k8yyy-facade": { accent: "#aaaaaa" } };
		const s = new RoomSession(
			ctx,
			makeSub({ membership: true, minGuardLevel: 3, cardSkin: "k8yyy-facade", cardSkinKnobs }),
		) as AnySession;
		await s.onGuardBuy(guardBody);
		expect(m.generateGuardCard.mock.calls[0]?.[2]).toEqual({
			cardSkin: "k8yyy-facade",
			cardSkinKnobs,
		});
	});

	it("有 per-kind guard 样式 → generateGuardCard 收到 guard 专属 colorOptions", async () => {
		const { ctx, m } = makeCtx();
		m.isSubscribed.mockImplementation((_s: unknown, feat: string) => feat === "membership");
		m.getUserInfoInLive.mockResolvedValueOnce({
			code: 0,
			data: { uname: "船员", face: "f", is_admin: false },
		});
		const s = new RoomSession(
			ctx,
			makeSub({
				membership: true,
				customCardStyle: { enable: true, font: "Base Sans" },
				customCardStyleByKind: {
					guard: { enable: true, font: "Guard Sans" },
				},
			}),
		) as AnySession;
		await s.onGuardBuy(guardBody);
		// 第三参 = colorOptions(guard 专属);第四参为版式。
		expect(m.generateGuardCard.mock.calls[0]?.[2]).toMatchObject({ font: "Guard Sans" });
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
				customCardStyle: { enable: true, font: "Base Sans" },
				customCardStyleByKind: { live: { enable: true, font: "Live Sans" } },
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
			font: "Live Sans",
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

	it("sub 带 messageLayout → renderLiveStreaming 后 sendLiveNotifyCard 收到版式与房间链接", async () => {
		const { ctx, m } = makeCtx();
		const layout = { blocks: [{ id: "card", type: "card", visible: true }], separator: "\n" };
		const s = new RoomSession(ctx, makeSub({ messageLayout: layout })) as AnySession;
		primeLiveRoom(s);
		await s.tickPushAtTime();
		const params = m.sendLiveNotifyCard.mock.calls[0]?.[0];
		expect(params?.messageLayout).toEqual(layout);
		expect(params?.roomLink).toBe("https://live.bilibili.com/12345");
	});

	it("周期「正在直播」发的是直播中的卡,且不是重启补报那一档(CatchUp 只属于启动补报)", async () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		primeLiveRoom(s);
		await s.tickPushAtTime();
		const params = m.sendLiveNotifyCard.mock.calls[0]?.[0];
		expect(params?.liveType).toBe(LiveType.LiveBroadcast);
		expect(params?.pushType).not.toBe(LivePushType.CatchUp);
	});
});

// ---------------------------------------------------------------------------
// bootstrapRoomState —— 重启补报(⑬d:`catchUpOnBoot`)
//
// 启动时发现正在播,补报一次**开播**:走 liveStart 的目标、推送类型是 CatchUp(历史记成开播、不 @全体),
// 文字与卡仍是「正在直播」那一套(renderLiveStreaming、LiveType.LiveBroadcast 的卡)。补报跟着开播推送
// 的开关与它自己的子项走,与周期「正在直播」(liveStreaming)互不相干。
// ---------------------------------------------------------------------------

describe("RoomSession.bootstrapRoomState — 重启补报", () => {
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
		s.onListenerStarted = vi.fn();
		s.armPeriodicTimer = vi.fn();
	}

	it("catchUpOnBoot 开、liveStart 开 → 补报一张:推送类型 CatchUp,文字是「正在直播」那句,卡是直播中的卡", async () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(ctx, makeSub({ liveStart: true, catchUpOnBoot: true })) as AnySession;
		primeLiveRoom(s);

		expect(await s.bootstrapRoomState()).toBe(true);

		expect(m.sendLiveNotifyCard).toHaveBeenCalledTimes(1);
		expect(m.sendLiveNotifyCard.mock.calls[0]?.[0]).toMatchObject({
			liveType: LiveType.LiveBroadcast,
			pushType: LivePushType.CatchUp,
			notifyMsg: "直播中",
		});
		expect(m.renderLiveStreaming).toHaveBeenCalledTimes(1);
		expect(m.renderLiveStart).not.toHaveBeenCalled();
	});

	it("catchUpOnBoot 关 → 不补报(出厂如此),但房间照样翻成在播", async () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(
			ctx,
			makeSub({ liveStart: true, catchUpOnBoot: false }),
		) as AnySession;
		primeLiveRoom(s);

		await s.bootstrapRoomState();

		expect(m.sendLiveNotifyCard).not.toHaveBeenCalled();
		expect(s.isLive).toBe(true);
	});

	it("catchUpOnBoot 开、liveStart 关 → 不补报:补的是开播,开播推送关着就没有什么可补", async () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(
			ctx,
			makeSub({ liveStart: false, catchUpOnBoot: true }),
		) as AnySession;
		primeLiveRoom(s);

		await s.bootstrapRoomState();

		expect(m.sendLiveNotifyCard).not.toHaveBeenCalled();
	});

	it("补报与周期互不相干:liveStreaming 开着也只补一张,周期计时另走 armPeriodicTimer", async () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(
			ctx,
			makeSub({ liveStart: true, catchUpOnBoot: true, liveStreaming: true }),
		) as AnySession;
		primeLiveRoom(s);

		await s.bootstrapRoomState();

		expect(m.sendLiveNotifyCard).toHaveBeenCalledTimes(1);
		expect(s.armPeriodicTimer).toHaveBeenCalledTimes(1);
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
// 文案里 {time} 那一句 —— 开播 / 正在直播 / 下播三路都从 live_time 现算
//
// 从前是 ctx 上的一个异步钩子(没配出图器时落进一个不带秒、不看时区的兜底),现在会话自己用
// `formatDuration(biliLiveTimeToIso(liveTime))` 算,不经 ctx —— 测试替身再也注入不了它,所以
// 给真的 live_time 与固定的钟,期望值写字面量。
// ---------------------------------------------------------------------------

describe("文案里的 {time}:按 live_time(北京时间)与当下的钟现算", () => {
	// live_time「2026-01-01 00:00:00」是北京时间 = 2025-12-31T16:00:00Z;钟停在 18:04:09Z,播了 2 小时 4 分 9 秒。
	const LIVE_TIME = "2026-01-01 00:00:00";

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2025-12-31T18:04:09.000Z"));
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	function prime(s: AnySession, liveTime: string, followers = 100): void {
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
			s.masterInfo = {
				username: "主播",
				userface: "",
				roomId: "r1",
				liveOpenFollowerNum: followers,
				liveEndFollowerNum: followers,
				liveFollowerChange: 0,
			};
			return true;
		});
		s.armPeriodicTimer = vi.fn();
		s.dispatchWordCloudAndSummary = vi.fn(async () => {});
	}

	it("开播:renderLiveStart 收到「2小时4分9秒」,粉丝数过万写成「1.2万」", async () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		prime(s, LIVE_TIME, 12_345);
		await s.onLiveStart();
		expect(m.renderLiveStart.mock.calls[0]?.[0]).toMatchObject({
			diffTime: "2小时4分9秒",
			followerNum: "1.2万",
		});
	});

	it("正在直播:renderLiveStreaming 收到「2小时4分9秒」", async () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		prime(s, LIVE_TIME);
		await s.tickPushAtTime();
		expect(m.renderLiveStreaming.mock.calls[0]?.[0]).toMatchObject({ diffTime: "2小时4分9秒" });
	});

	it("下播:renderLiveEnd 收到「2小时4分9秒」", async () => {
		const { ctx, m } = makeCtx();
		m.isSubscribed.mockReturnValue(true);
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		s.liveStatus = true;
		prime(s, LIVE_TIME);
		await s.handleLiveEnd("ws");
		expect(m.renderLiveEnd.mock.calls[0]?.[0]).toMatchObject({ diffTime: "2小时4分9秒" });
	});

	it("live_time 解析不出(B 站对没开播的房间给全零)→ 写「0秒」,不抛、不写 NaN", async () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(ctx, makeSub()) as AnySession;
		prime(s, "0000-00-00 00:00:00");
		await s.tickPushAtTime();
		expect(m.renderLiveStreaming.mock.calls[0]?.[0]).toMatchObject({ diffTime: "0秒" });
	});

	describe("live_time 为空 → 以此刻为开播时刻,按北京时间记,与服务跑在哪个时区无关", () => {
		// 兜底拼出来的字符串要和 B 站的 live_time 同一个时区(北京时间):按服务所在时区拼,
		// 读的时候又当北京时间读,跑在 UTC 的 Docker 里就凭空多出 8 小时。
		beforeEach(() => {
			Settings.defaultZone = "America/Los_Angeles";
		});
		afterEach(() => {
			Settings.defaultZone = "system";
		});

		it("开播:「0秒」", async () => {
			const { ctx, m } = makeCtx();
			const s = new RoomSession(ctx, makeSub()) as AnySession;
			prime(s, "");
			await s.onLiveStart();
			expect(m.renderLiveStart.mock.calls[0]?.[0]).toMatchObject({ diffTime: "0秒" });
		});

		it("下播:「0秒」", async () => {
			const { ctx, m } = makeCtx();
			m.isSubscribed.mockReturnValue(true);
			const s = new RoomSession(ctx, makeSub()) as AnySession;
			s.liveStatus = true;
			prime(s, "");
			await s.handleLiveEnd("ws");
			expect(m.renderLiveEnd.mock.calls[0]?.[0]).toMatchObject({ diffTime: "0秒" });
		});
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
	it("特别关注用户进房 → 渲染并推送(UserActions)", async () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(ctx, makeSpecialUserSub()) as AnySession;

		await s.onUserAction(enterEvent(42));

		expect(m.renderSpecialUserEnter).toHaveBeenCalledTimes(1);
		expect(m.renderSpecialUserEnter.mock.calls[0]?.[0]?.uname).toBe("特别用户");
		expect(m.safeBroadcast).toHaveBeenCalledTimes(1);
		expect(m.safeBroadcast.mock.calls[0]?.[2]).toBe(LivePushType.UserActions);
	});

	it("uid 是数字 → 与字符串白名单比对时不因类型不符而漏推", async () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(ctx, makeSpecialUserSub()) as AnySession;

		await s.onUserAction(enterEvent(42));

		expect(m.safeBroadcast).toHaveBeenCalledTimes(1);
	});

	it("非进房动作(关注 / 分享 / 未知)→ 不推送", async () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(ctx, makeSpecialUserSub()) as AnySession;

		for (const action of ["follow", "share", "unknown"] as const) {
			await s.onUserAction({ ...enterEvent(42), action });
		}

		expect(m.safeBroadcast).not.toHaveBeenCalled();
	});

	it("非特别关注的用户进房 → 不推送", async () => {
		const { ctx, m } = makeCtx();
		const s = new RoomSession(ctx, makeSpecialUserSub()) as AnySession;

		await s.onUserAction(enterEvent(999, "路人"));

		expect(m.safeBroadcast).not.toHaveBeenCalled();
	});

	it("没配 specialUserEnter 的推送目标 → 照样渲染并广播,「无目标」由推送层记账", async () => {
		const { ctx, m } = makeCtx();
		const sub = makeSpecialUserSub();
		sub.target = {};
		const s = new RoomSession(ctx, sub) as AnySession;

		await s.onUserAction(enterEvent(42));

		expect(m.renderSpecialUserEnter).toHaveBeenCalledTimes(1);
		expect(m.safeBroadcast).toHaveBeenCalledTimes(1);
	});
});

describe("RoomSession.onIncomeDanmu — 特别关注用户的弹幕", () => {
	it("没配 specialDanmaku 的推送目标 → 照样广播(UserDanmakuMsg),不在引擎里按目标挡", () => {
		const { ctx, m } = makeCtx();
		const sub = makeSub({
			customSpecialDanmakuUsers: {
				enable: true,
				specialDanmakuUsers: ["42"],
				msgTemplate: "弹幕模板",
			},
			target: {},
		});
		const s = new RoomSession(ctx, sub) as AnySession;

		s.onIncomeDanmu({ content: "你好", user: { uname: "特别用户", uid: 42 } });

		expect(m.safeBroadcast).toHaveBeenCalledTimes(1);
		expect(m.safeBroadcast.mock.calls[0]?.[2]).toBe(LivePushType.UserDanmakuMsg);
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
//   - LiveType.LiveBroadcast(周期「正在直播」复推)→ LivePushType.Live(0) → liveTypeAllowsAtAll(0)=false
//     → 不 @全体;bootstrap「已在直播中」补报同一张卡,但由调用方显式给 LivePushType.CatchUp(⑬d)
//   - LiveType.FirstLiveBroadcast → LivePushType.Live(0)(注:实际从不传给本方法,
//     bootstrap 补报走的是 LiveBroadcast + CatchUp;此处仅守护 else 分支的稳健性)
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
			signal: new AbortController().signal,
			track: () => {},
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

	it("LiveBroadcast(周期「正在直播」复推)→ LivePushType.Live(0) — 不 @全体", async () => {
		expect(await pushTypeFor(LiveType.LiveBroadcast)).toBe(LivePushType.Live);
		expect(LivePushType.Live).toBe(0);
	});

	it("重启补报:调用方显式给 CatchUp → 原样带到推送层(卡仍是「正在直播」那张,类型与周期那一档分开)", async () => {
		const { ctx, broadcastToTargets } = makeRoomCtx();
		await ctx.sendLiveNotifyCard({
			liveType: LiveType.LiveBroadcast,
			pushType: LivePushType.CatchUp,
			liveData: {},
			liveRoomInfo,
			master,
			cardStyle: { enable: false },
			uid: "u1",
			notifyMsg: "msg",
			messageLayout: defaultMessageKindLayout("live"),
		});
		expect(broadcastToTargets.mock.calls[0]?.[2]).toBe(LivePushType.CatchUp);
		// 与周期那一档不是同一个数 —— 翻译表据此把一个翻成 liveStart、一个翻成 liveStreaming。
		expect(LivePushType.CatchUp as number).not.toBe(LivePushType.Live as number);
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
		// 每天自增 24 小时且无上限,而默认的周期「正在直播」是关着的,连轮询兜底都没有。
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
