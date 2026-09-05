/**
 * 下播 = 卡片本体,词云 / AI 总结是它的附加项(像开播的 @全体)。
 *
 * 锁住:
 *   - 下播卡先发、带一个新的 pushId;词云 / 总结算好后用**同一个 pushId**、标 `role: "extra"` 追加
 *   - 下播开关关着 → 卡、词云、总结一个都不发,子项开着也不发
 *   - 子项各自门控:只开总结就只追加总结;两个都关就只有卡,词云不算、AI 不问
 *   - `sendLiveNotifyCard` 把 pushId 透传给推送层(单条 / 分条都带)
 *   - 弹幕采集只在「下播开着且有子项开着」时进行
 */

import { defaultMessageKindLayout, type ServiceContext } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { LivePushType, type SubItemView, wantsLiveEndExtras } from "../push-like";
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
		liveEndExtras: { wordcloud: true, liveSummary: true },
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
		messageLayout: defaultMessageKindLayout("live"),
		...over,
	};
}

function makeCtx() {
	const serviceCtx: ServiceContext = {
		logger: { debug() {}, info() {}, warn() {}, error() {} },
		setInterval: () => ({ dispose() {} }),
		setTimeout: () => ({ dispose() {} }),
		onDispose: () => {},
	};
	const sendLiveNotifyCard = vi.fn(async (_params: { pushId?: string; liveType: LiveType }) => {});
	const broadcastToTargets = vi.fn(
		async (_uid: string, _content: unknown, _type: LivePushType, _opts?: unknown) => {},
	);
	const wordcloud = vi.fn(async () => Buffer.from("wc"));
	const summary = vi.fn(async () => "总结文本");
	const ctx = {
		serviceCtx,
		logger: serviceCtx.logger,
		isDisposed: () => false,
		config: { customLiveMsg: { enable: false }, liveSummaryDefault: "默认总结" },
		danmakuCollector: {
			clear: vi.fn(),
			registerRoom: vi.fn(),
			snapshot: () => ({ sortedWords: [["精彩", 5]], senderRecord: {} }),
		},
		templateRenderer: { renderLiveEnd: () => "下播了" },
		contentBuilder: {
			text: (t: string) => ({ kind: "text", text: t }),
			image: (buf: Buffer, mime: string) => ({ kind: "image", buf, mime }),
			message: (segs: unknown[]) => segs,
		},
		push: { broadcastToTargets, sendPrivateMsg: vi.fn(async () => {}) },
		getTimeDifference: vi.fn(async () => "1小时"),
		isSubscribed: (sub: SubItemView, feat: keyof SubItemView) => sub[feat],
		sendLiveNotifyCard,
		wordcloudGenerator: { generate: wordcloud },
		liveSummaryRequester: { generate: summary },
		stopMonitoring: vi.fn(),
		emitLiveState: vi.fn(),
	} as unknown as RoomContext;
	return { ctx, sendLiveNotifyCard, broadcastToTargets, wordcloud, summary };
}

const ROOM = {
	uid: 1,
	room_id: 1,
	short_id: 0,
	live_status: 1,
	live_time: "2026-01-01 10:00:00",
	title: "t",
};
const MASTER = {
	username: "U1",
	userface: "",
	roomId: "r1",
	liveOpenFollowerNum: 100,
	liveEndFollowerNum: 100,
	liveFollowerChange: 0,
};

function liveSession(ctx: RoomContext, sub: SubItemView): AnySession {
	const s = new RoomSession(ctx, sub) as AnySession;
	s.liveStatus = true;
	s.liveTime = ROOM.live_time;
	s.liveRoomInfo = { ...ROOM };
	s.masterInfo = { ...MASTER };
	s.useLiveRoomInfo = vi.fn(async () => true);
	s.useMasterInfo = vi.fn(async () => true);
	return s;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("handleLiveEnd — 下播卡 + 附加项共用 pushId", () => {
	it("卡先发、带新的 pushId;词云 / 总结用同一个 pushId、标 extra 追加", async () => {
		const { ctx, sendLiveNotifyCard, broadcastToTargets } = makeCtx();
		await liveSession(ctx, makeSub()).handleLiveEnd("ws");

		expect(sendLiveNotifyCard).toHaveBeenCalledTimes(1);
		const card = sendLiveNotifyCard.mock.calls[0]?.[0];
		expect(card?.liveType).toBe(LiveType.StopBroadcast);
		expect(card?.pushId).toMatch(UUID);
		expect(broadcastToTargets.mock.calls.map((c) => [c[2], c[3]])).toEqual([
			[LivePushType.WordCloudAndLiveSummary, { pushId: card?.pushId, role: "extra" }],
			[LivePushType.LiveSummary, { pushId: card?.pushId, role: "extra" }],
		]);
	});

	it("两场下播各自一个 pushId", async () => {
		const { ctx, sendLiveNotifyCard } = makeCtx();
		await liveSession(ctx, makeSub()).handleLiveEnd("ws");
		await liveSession(ctx, makeSub()).handleLiveEnd("ws");
		const ids = sendLiveNotifyCard.mock.calls.map((c) => c[0].pushId);
		expect(ids[0]).not.toBe(ids[1]);
	});

	it("下播关着 → 卡、词云、总结一个都不发,子项开着也不发;弹幕缓冲照清", async () => {
		const { ctx, sendLiveNotifyCard, broadcastToTargets, wordcloud, summary } = makeCtx();
		await liveSession(ctx, makeSub({ liveEnd: false })).handleLiveEnd("ws");
		expect(sendLiveNotifyCard).not.toHaveBeenCalled();
		expect(broadcastToTargets).not.toHaveBeenCalled();
		expect(wordcloud).not.toHaveBeenCalled();
		expect(summary).not.toHaveBeenCalled();
		expect(
			(ctx as unknown as { danmakuCollector: { clear: ReturnType<typeof vi.fn> } }).danmakuCollector
				.clear,
		).toHaveBeenCalled();
	});

	it("只开总结 → 卡 + 总结,不算词云", async () => {
		const { ctx, broadcastToTargets, wordcloud } = makeCtx();
		await liveSession(
			ctx,
			makeSub({ liveEndExtras: { wordcloud: false, liveSummary: true } }),
		).handleLiveEnd("ws");
		expect(wordcloud).not.toHaveBeenCalled();
		expect(broadcastToTargets.mock.calls.map((c) => c[2])).toEqual([LivePushType.LiveSummary]);
	});

	it("两个子项都关 → 只有卡;不算词云、不问 AI", async () => {
		const { ctx, sendLiveNotifyCard, broadcastToTargets, wordcloud, summary } = makeCtx();
		await liveSession(
			ctx,
			makeSub({ liveEndExtras: { wordcloud: false, liveSummary: false } }),
		).handleLiveEnd("ws");
		expect(sendLiveNotifyCard).toHaveBeenCalledTimes(1);
		expect(broadcastToTargets).not.toHaveBeenCalled();
		expect(wordcloud).not.toHaveBeenCalled();
		expect(summary).not.toHaveBeenCalled();
	});
});

describe("sendLiveNotifyCard — pushId 透传给推送层", () => {
	function layoutCtx() {
		const broadcastToTargets = vi.fn(
			async (_uid: string, _content: unknown, _type: LivePushType, _opts?: unknown) => {},
		);
		const broadcastSequenceToTargets = vi.fn(
			async (_uid: string, _contents: unknown[], _type: LivePushType, _opts?: unknown) => {},
		);
		const ctx = {
			logger: { debug() {}, info() {}, warn() {}, error() {} },
			isDisposed: () => false,
			imageRenderer: null,
			contentBuilder: {
				text: (t: string) => ({ kind: "text", text: t }),
				image: () => ({ kind: "image" }),
				message: (segs: unknown[]) => ({ kind: "message", segs }),
			},
			push: { broadcastToTargets, broadcastSequenceToTargets },
		} as unknown as RoomContext;
		Object.setPrototypeOf(ctx, RoomContext.prototype);
		return { ctx, broadcastToTargets, broadcastSequenceToTargets };
	}
	const params = (layout: {
		blocks: Array<{ id: string; type: string; visible: boolean }>;
		separator: string;
	}) => ({
		liveType: LiveType.StopBroadcast,
		liveData: {} as never,
		liveRoomInfo: {
			live_time: "2026-01-01 00:00:00",
			short_id: 0,
			room_id: 1,
			title: "t",
		} as never,
		master: { username: "主播", userface: "", roomId: "1" } as never,
		cardStyle: { enable: false } as SubItemView["customCardStyle"],
		uid: "u1",
		notifyMsg: "下播了",
		roomLink: "https://live.bilibili.com/1",
		messageLayout: layout,
		pushId: "11111111-1111-4111-8111-111111111111",
	});

	it("一条 → broadcastToTargets 第四个参数带 pushId", async () => {
		const { ctx, broadcastToTargets } = layoutCtx();
		await RoomContext.prototype.sendLiveNotifyCard.call(
			ctx,
			params({
				blocks: [
					{ id: "text", type: "text", visible: true },
					{ id: "link", type: "link", visible: true },
				],
				separator: "\n",
			}) as never,
		);
		expect(broadcastToTargets.mock.calls[0]?.[2]).toBe(LivePushType.LiveEnd);
		expect(broadcastToTargets.mock.calls[0]?.[3]).toEqual({
			pushId: "11111111-1111-4111-8111-111111111111",
		});
	});

	it("分条 → broadcastSequenceToTargets 同样带 pushId", async () => {
		const { ctx, broadcastSequenceToTargets } = layoutCtx();
		await RoomContext.prototype.sendLiveNotifyCard.call(
			ctx,
			params({
				blocks: [
					{ id: "text", type: "text", visible: true },
					{ id: "split-1", type: "split", visible: true },
					{ id: "link", type: "link", visible: true },
				],
				separator: "\n",
			}) as never,
		);
		expect(broadcastSequenceToTargets.mock.calls[0]?.[3]).toEqual({
			pushId: "11111111-1111-4111-8111-111111111111",
		});
	});
});

describe("wantsLiveEndExtras — 弹幕采集的门", () => {
	it.each<[string, Partial<SubItemView>, boolean]>([
		["下播开、词云开", { liveEndExtras: { wordcloud: true, liveSummary: false } }, true],
		["下播开、只开总结", { liveEndExtras: { wordcloud: false, liveSummary: true } }, true],
		["下播开、子项全关", { liveEndExtras: { wordcloud: false, liveSummary: false } }, false],
		[
			"下播关、子项开着",
			{ liveEnd: false, liveEndExtras: { wordcloud: true, liveSummary: true } },
			false,
		],
	])("%s", (_name, over, expected) => {
		expect(wantsLiveEndExtras(makeSub(over))).toBe(expected);
	});
});
