/**
 * 单元测试 — 同房间推送的送达次序(per-session 串行闸)。
 *
 * 真实事故(2026-08-14 用户反馈):主播下播后几秒内重开,下播卡与新场开播卡在两个
 * 互不排队的异步流程里并发渲染发送,开播卡先送达 —— QQ 与 history 都呈现
 * 「开播 → 下播 → 总结」的倒序,用户把一小时后新场的周期复推当成了误报。
 *
 * 锁两件事:
 *   1. 下播卡在途时发起的开播卡,必须等下播卡送达完成后才开始发 —— 送达序 = 发起序;
 *   2. 一条推送失败不能断链:后续推送照常排队送出,失败照样抛回发起方。
 */

import type { ServiceContext } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import type { SubItemView } from "../push-like";
import type { RoomContext } from "../room-helpers";
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeCtx(events: string[]) {
	const fakeServiceCtx: ServiceContext = {
		logger: { debug() {}, info() {}, warn() {}, error() {} },
		setInterval: () => ({ dispose() {} }),
		setTimeout: () => ({ dispose() {} }),
		onDispose: () => {},
	};
	// 下播卡送达一开始就放出信号 —— 测试用它精确卡在「下播卡在途」的窗口里触发重开,
	// 轮询式等待(vi.waitFor)会晚几十毫秒,窗口早关了。
	let endBegan!: () => void;
	const endBeganP = new Promise<void>((r) => {
		endBegan = r;
	});
	// 下播卡慢(30ms,模拟大图渲染 / 慢送达),开播卡快 —— 正是事故里的时序。
	const sendLiveNotifyCard = vi.fn(async (params: { liveType: LiveType }) => {
		if (params.liveType === LiveType.StopBroadcast) {
			events.push("end:begin");
			endBegan();
			await sleep(30);
			events.push("end:done");
			return;
		}
		events.push("start:begin");
		await sleep(1);
		events.push("start:done");
	});
	const ctx = {
		serviceCtx: fakeServiceCtx,
		logger: fakeServiceCtx.logger,
		isDisposed: () => false,
		config: { customLiveMsg: { enable: false }, customGuardBuy: { enable: false } },
		danmakuCollector: { clear: vi.fn(), registerRoom: vi.fn(), recordDanmaku: vi.fn() },
		templateRenderer: {
			renderLiveStart: () => "开播啦",
			renderLiveOngoing: () => "直播中",
			renderLiveEnd: () => "下播了",
		},
		contentBuilder: {
			text: (t: string) => ({ kind: "text", text: t }),
			image: () => ({ kind: "image" }),
			message: (segs: unknown[]) => segs,
		},
		push: { broadcastToTargets: vi.fn(async () => {}) },
		getTimeDifference: vi.fn(async () => "2小时36分16秒"),
		isSubscribed: vi.fn((_s: unknown, feat: string) => feat === "liveEnd"),
		sendLiveNotifyCard,
		stopMonitoring: vi.fn(),
		emitLiveState: vi.fn(),
		pickBackground: vi.fn(() => undefined),
	} as unknown as RoomContext;
	return { ctx, sendLiveNotifyCard, endBeganP };
}

const roomInfo = {
	uid: 1,
	room_id: 1,
	short_id: 0,
	live_status: 1,
	live_time: "2026-01-01 10:00:00",
	title: "t",
};
const master = {
	username: "U1",
	userface: "",
	roomId: "r1",
	liveOpenFollowerNum: 100,
	liveEndFollowerNum: 100,
	liveFollowerChange: 0,
};

/** 造一个「在播中」的 session,网络刷新打桩、房间/主播信息预置。 */
function liveSession(ctx: RoomContext): AnySession {
	const s = new RoomSession(ctx, makeSub()) as AnySession;
	s.liveStatus = true;
	s.liveTime = roomInfo.live_time;
	s.liveRoomInfo = { ...roomInfo };
	s.masterInfo = { ...master };
	s.useLiveRoomInfo = vi.fn(async () => true);
	s.useMasterInfo = vi.fn(async () => true);
	return s;
}

describe("RoomSession — 同房间推送串行化", () => {
	it("下播卡在途时重开:开播卡等下播卡送达完成后才发(送达序 = 发起序)", async () => {
		const events: string[] = [];
		const { ctx, sendLiveNotifyCard, endBeganP } = makeCtx(events);
		const s = liveSession(ctx);

		// 下播流程先发起(不 await,让下播卡停在慢送达里)。
		const endP = s.handleLiveEnd("ws");
		await endBeganP;
		// 下播卡在途的瞬间主播重开 —— 此刻 liveStatus 已翻 false,onLiveStart 全速跑。
		const startP = s.onLiveStart();
		await Promise.all([endP, startP]);

		expect(sendLiveNotifyCard).toHaveBeenCalledTimes(2);
		expect(events).toEqual(["end:begin", "end:done", "start:begin", "start:done"]);
	});

	it("一条推送失败不断链:后续照常送出,失败照样抛回发起方", async () => {
		const events: string[] = [];
		const { ctx } = makeCtx(events);
		const s = new RoomSession(ctx, makeSub()) as AnySession;

		const order: string[] = [];
		const p1: Promise<void> = s
			.enqueuePush(async () => {
				throw new Error("boom");
			})
			.then(
				() => order.push("p1:resolved"),
				() => order.push("p1:rejected"),
			);
		const p2: Promise<void> = s
			.enqueuePush(async () => {
				order.push("p2:ran");
			})
			.then(() => order.push("p2:resolved"));
		await Promise.all([p1, p2]);
		expect(order).toEqual(["p1:rejected", "p2:ran", "p2:resolved"]);
	});
});
