/**
 * 下播 = 卡片本体,词云 / AI 总结是它的附加项(像开播的 @全体)。
 *
 * 锁住:
 *   - 下播是**一次推送**:卡片是本体,词云 / 总结是排在它后面的附加项锚点(各带自己的键、内容是约定),
 *     一起交出去
 *   - 下播开关关着 → 卡、词云、总结一个都不发,子项开着也不发
 *   - 子项各自门控:只开总结就只有总结那个锚点;两个都关就只有卡,词云不算、AI 不问
 *   - 串行闸只包到本体发完:附加项还在做,下播那一步已经走完;弹幕快照取在清空收集器之前
 *   - `sendLiveNotifyCard` 把本体与附加项作为同一次推送交给推送层(单条 / 分条 / 本体全藏)
 *   - 弹幕采集只在「下播开着且有子项开着」时进行
 */

import { defaultMessageKindLayout, type ServiceContext } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { LivePushType } from "../../../../live/live-types";
import {
	type LivePush,
	type LivePushAnchor,
	type SubItemView,
	wantsLiveEndExtras,
} from "../../push-like";
import { LiveType } from "../../types";
import { RoomContext } from "../room-helpers";
import { RoomSession } from "../room-session";

// biome-ignore lint/suspicious/noExplicitAny: 测试需访问 private/protected
type AnySession = any;

function makeSub(over: Partial<SubItemView> = {}): SubItemView {
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
		viewerChat: false,
		viewerEnter: false,
		extras: { atAllPost: false, atAllLiveStart: true, wordcloud: true, liveSummary: true },
		target: {},
		customCardStyle: { enable: false },
		customLiveMsg: { enable: false },
		guardTemplate: { enabled: false, default: { template: "", imageUrl: "" }, tiers: {} },
		customLiveSummary: { enable: false },
		customSpecialDanmakuUsers: { specialViewers: [], template: "" },
		customSpecialUsersEnterTheRoom: { specialViewers: [], template: "" },
		liveStreaming: false,
		streamingIntervalHours: 1,
		catchUpOnBoot: false,
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
		signal: new AbortController().signal,
		track: () => {},
	};
	const sendLiveNotifyCard = vi.fn(
		async (_params: { extras?: LivePushAnchor[]; liveType: LiveType; cardSkin?: string }) => {},
	);
	const push = vi.fn(async (_push: LivePush) => {});
	const clear = vi.fn();
	const snapshot = vi.fn(() => ({ sortedWords: [["精彩", 5]], senderRecord: {} }));
	const wordcloud = vi.fn(async (..._args: unknown[]) => Buffer.from("wc"));
	const avatarOf = vi.fn((_subscriptionId: string): string | undefined => undefined);
	const summary = vi.fn((): { template: string; ai?: Promise<string | undefined> } => ({
		template: "总结文本",
	}));
	const ctx = {
		serviceCtx,
		logger: serviceCtx.logger,
		isDisposed: () => false,
		config: { customLiveMsg: { enable: false }, liveSummaryDefault: "默认总结" },
		danmakuCollector: { clear, register: vi.fn(), snapshot },
		templateRenderer: { renderLiveEnd: () => "下播了" },
		contentBuilder: {
			text: (t: string) => ({ kind: "text", text: t }),
			image: (buf: Buffer, mime: string) => ({ kind: "image", buf, mime }),
			message: (segs: unknown[]) => segs,
		},
		push: { push },
		isSubscribed: (sub: SubItemView, feat: keyof SubItemView) => sub[feat],
		sendLiveNotifyCard,
		wordcloudGenerator: { generate: wordcloud },
		liveSummaryRequester: { generate: summary },
		avatarOf,
		stopMonitoring: vi.fn(),
		emitLiveState: vi.fn(),
	} as unknown as RoomContext;
	return { ctx, sendLiveNotifyCard, push, wordcloud, summary, avatarOf, clear, snapshot };
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

/** 下播卡带出去的附加项锚点:`[角色, 附加项键]`。 */
const extrasOf = (card: { extras?: LivePushAnchor[] } | undefined) =>
	(card?.extras ?? []).map((a) => [a.role, a.extra]);

describe("handleLiveEnd — 下播卡 + 附加项是同一次推送", () => {
	it("卡是本体;词云 / 总结作为附加项锚点跟着这张卡一起交出去,各带各的键、按「词云 → 总结」排", async () => {
		const { ctx, sendLiveNotifyCard, push } = makeCtx();
		await liveSession(ctx, makeSub()).handleLiveEnd("ws");

		expect(sendLiveNotifyCard).toHaveBeenCalledTimes(1);
		const card = sendLiveNotifyCard.mock.calls[0]?.[0];
		expect(card?.liveType).toBe(LiveType.StopBroadcast);
		expect(extrasOf(card)).toEqual([
			["extra", "wordcloud"],
			["extra", "liveSummary"],
		]);
		expect(await card?.extras?.[0]?.messages).toEqual([
			{ kind: "image", buf: Buffer.from("wc"), mime: "image/jpeg" },
		]);
		expect(await card?.extras?.[1]?.messages).toEqual([{ kind: "text", text: "总结文本" }]);
		// 附加项不另发:下播这条路自己不直接碰推送层,全经那一张卡交出去。
		expect(push).not.toHaveBeenCalled();
	});

	// 串行闸只包到本体发完:AI 总结可能要写很久,这期间这个房间的下一次推送(比如秒级重开的开播卡)不该被它堵住。
	it("附加项还没做好,下播那一步已经走完(不占着串行闸)", async () => {
		const { ctx, sendLiveNotifyCard, summary } = makeCtx();
		let finish: (text: string) => void = () => {};
		summary.mockImplementation(() => ({
			template: "总结文本",
			ai: new Promise<string | undefined>((r) => (finish = r)),
		}));
		await liveSession(ctx, makeSub()).handleLiveEnd("ws");

		const card = sendLiveNotifyCard.mock.calls[0]?.[0];
		let done = false;
		void Promise.resolve(card?.extras?.[1]?.aiMessages).then(() => {
			done = true;
		});
		await new Promise((r) => setTimeout(r, 0));
		expect(done).toBe(false);
		// 模板那份不等 AI。
		expect(await card?.extras?.[1]?.messages).toEqual([{ kind: "text", text: "总结文本" }]);
		finish("迟到的总结");
		expect(await card?.extras?.[1]?.aiMessages).toEqual([{ kind: "text", text: "迟到的总结" }]);
	});

	// 清空收集器在 `finally` 里:快照要是取晚了,词云与总结就是空的。
	it("弹幕快照取在清空收集器之前", async () => {
		const { ctx, snapshot, clear } = makeCtx();
		await liveSession(ctx, makeSub()).handleLiveEnd("ws");
		expect(snapshot).toHaveBeenCalledTimes(1);
		expect(clear).toHaveBeenCalled();
		expect(snapshot.mock.invocationCallOrder[0] as number).toBeLessThan(
			clear.mock.invocationCallOrder[0] as number,
		);
	});

	// 3a-35:词云卡的主播头像是订阅资料里的图库引用,做词云那一刻按订阅 id 现读;直播间接口给的远端地址不再往出图器送。
	// 验红:把 room-session-base.ts 里交给 `wordcloudGenerator.generate` 的第三个实参换回 `this.masterInfo?.userface`,这条红。
	it("词云的主播头像按订阅 id 现读订阅资料里的引用,不用直播间接口给的地址", async () => {
		const { ctx, wordcloud, avatarOf } = makeCtx();
		avatarOf.mockReturnValue("0123abcd.webp");
		const session = liveSession(ctx, makeSub());
		session.masterInfo = { ...MASTER, userface: "https://i0.hdslb.com/bfs/face/x.jpg" };
		await session.handleLiveEnd("ws");

		expect(avatarOf).toHaveBeenCalledWith("sub-1");
		expect(wordcloud.mock.calls[0]?.[2]).toBe("0123abcd.webp");
	});

	it("订阅资料里还没有头像 → 词云不带头像", async () => {
		const { ctx, wordcloud } = makeCtx();
		const session = liveSession(ctx, makeSub());
		session.masterInfo = { ...MASTER, userface: "https://i0.hdslb.com/bfs/face/x.jpg" };
		await session.handleLiveEnd("ws");

		expect(wordcloud).toHaveBeenCalledTimes(1);
		expect(wordcloud.mock.calls[0]?.[2]).toBeUndefined();
	});

	// 三处 sendLiveNotifyCard(开播 / 直播中 / 下播)都得把 sub 的皮肤递出去;漏一处的
	// 症状是「那一类推送不跟着皮肤走」,而且全绿(那个参数是可选的)。
	it("下播卡把 per-UP 皮肤 id 一起交给 sendLiveNotifyCard", async () => {
		const { ctx, sendLiveNotifyCard } = makeCtx();
		const sub = makeSub();
		(sub as SubItemView).cardSkin = "k4ddd-0ddba11";
		await liveSession(ctx, sub).handleLiveEnd("ws");
		// 验红:把 room-session-base.ts 下播那一处的 `...this.skinChoice()` 删掉,这条红。
		const card = sendLiveNotifyCard.mock.calls[0]?.[0] as { cardSkin?: string } | undefined;
		expect(card?.cardSkin).toBe("k4ddd-0ddba11");
	});

	// per-UP 旋钮覆盖(ADR-0014 决策 17 的 🔗)与皮肤 id 同路。
	// 验红:把 room-session-base.ts 下播那一处的皮肤选项换回只带 `cardSkin`,这条红。
	it("下播卡把 per-UP 旋钮覆盖一起交给 sendLiveNotifyCard", async () => {
		const { ctx, sendLiveNotifyCard } = makeCtx();
		const sub = makeSub();
		const cardSkinKnobs = { "k4ddd-0ddba11": { accent: "#aaaaaa" } };
		(sub as SubItemView).cardSkin = "k4ddd-0ddba11";
		(sub as SubItemView).cardSkinKnobs = cardSkinKnobs;
		await liveSession(ctx, sub).handleLiveEnd("ws");
		const card = sendLiveNotifyCard.mock.calls[0]?.[0] as { cardSkinKnobs?: unknown } | undefined;
		expect(card?.cardSkinKnobs).toEqual(cardSkinKnobs);
	});

	it("两场下播各交各的:各自一张卡、各自一组附加项锚点", async () => {
		const { ctx, sendLiveNotifyCard } = makeCtx();
		await liveSession(ctx, makeSub()).handleLiveEnd("ws");
		await liveSession(ctx, makeSub()).handleLiveEnd("ws");
		const [first, second] = sendLiveNotifyCard.mock.calls.map((c) => c[0].extras);
		expect(first).toHaveLength(2);
		expect(second).toHaveLength(2);
		expect(second?.[0]).not.toBe(first?.[0]);
	});

	it("下播关着 → 卡、词云、总结一个都不发,子项开着也不发;弹幕缓冲照清", async () => {
		const { ctx, sendLiveNotifyCard, push, wordcloud, summary } = makeCtx();
		await liveSession(ctx, makeSub({ liveEnd: false })).handleLiveEnd("ws");
		expect(sendLiveNotifyCard).not.toHaveBeenCalled();
		expect(push).not.toHaveBeenCalled();
		expect(wordcloud).not.toHaveBeenCalled();
		expect(summary).not.toHaveBeenCalled();
		expect(
			(ctx as unknown as { danmakuCollector: { clear: ReturnType<typeof vi.fn> } }).danmakuCollector
				.clear,
		).toHaveBeenCalled();
	});

	it("只开总结 → 卡 + 总结,不算词云", async () => {
		const { ctx, sendLiveNotifyCard, wordcloud } = makeCtx();
		await liveSession(
			ctx,
			makeSub({
				extras: { atAllPost: false, atAllLiveStart: true, wordcloud: false, liveSummary: true },
			}),
		).handleLiveEnd("ws");
		expect(wordcloud).not.toHaveBeenCalled();
		expect(extrasOf(sendLiveNotifyCard.mock.calls[0]?.[0])).toEqual([["extra", "liveSummary"]]);
	});

	it("两个子项都关 → 只有卡;不算词云、不问 AI", async () => {
		const { ctx, sendLiveNotifyCard, wordcloud, summary } = makeCtx();
		await liveSession(
			ctx,
			makeSub({
				extras: { atAllPost: false, atAllLiveStart: true, wordcloud: false, liveSummary: false },
			}),
		).handleLiveEnd("ws");
		expect(sendLiveNotifyCard).toHaveBeenCalledTimes(1);
		expect(sendLiveNotifyCard.mock.calls[0]?.[0].extras).toEqual([]);
		expect(wordcloud).not.toHaveBeenCalled();
		expect(summary).not.toHaveBeenCalled();
	});
});

describe("sendLiveNotifyCard — 本体与附加项作为同一次推送交给推送层", () => {
	function layoutCtx() {
		const push = vi.fn(async (_push: LivePush) => {});
		const ctx = {
			logger: { debug() {}, info() {}, warn() {}, error() {} },
			isDisposed: () => false,
			imageRenderer: null,
			avatarOf: () => undefined,
			contentBuilder: {
				text: (t: string) => ({ kind: "text", text: t }),
				image: () => ({ kind: "image" }),
				message: (segs: unknown[]) => ({ kind: "message", segs }),
			},
			push: { push },
		} as unknown as RoomContext;
		Object.setPrototypeOf(ctx, RoomContext.prototype);
		return { ctx, push };
	}
	const WORDCLOUD: LivePushAnchor = {
		role: "extra",
		extra: "wordcloud",
		messages: Promise.resolve([{ kind: "image" }]),
	};
	const SUMMARY: LivePushAnchor = {
		role: "extra",
		extra: "liveSummary",
		messages: Promise.resolve([{ kind: "text", text: "总结" }]),
	};
	const params = (
		blocks: Array<{ id: string; type: string; visible: boolean }>,
		extras?: LivePushAnchor[],
	) => ({
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
		messageLayout: { blocks, separator: "\n" },
		extras,
	});
	const send = (ctx: RoomContext, p: ReturnType<typeof params>) =>
		RoomContext.prototype.sendLiveNotifyCard.call(ctx, p as never);

	it("一条:只交一次,本体那个锚点里一条消息,附加项原样排在后面", async () => {
		const { ctx, push } = layoutCtx();
		await send(
			ctx,
			params(
				[
					{ id: "text", type: "text", visible: true },
					{ id: "link", type: "link", visible: true },
				],
				[WORDCLOUD, SUMMARY],
			),
		);
		expect(push).toHaveBeenCalledTimes(1);
		const sent = push.mock.calls[0]?.[0];
		expect(sent).toMatchObject({ uid: "u1", type: LivePushType.LiveEnd });
		expect(sent?.anchors.map((a) => [a.role, a.extra])).toEqual([
			["main", undefined],
			["extra", "wordcloud"],
			["extra", "liveSummary"],
		]);
		expect(sent?.anchors[0]?.messages).toHaveLength(1);
		// 附加项的约定原样递过去(不在这里等它)。
		expect(sent?.anchors[1]).toBe(WORDCLOUD);
		expect(sent?.anchors[2]).toBe(SUMMARY);
	});

	it("分条:几条消息是本体那一个锚点里的一串,附加项照旧排在后面", async () => {
		const { ctx, push } = layoutCtx();
		await send(
			ctx,
			params(
				[
					{ id: "text", type: "text", visible: true },
					{ id: "split-1", type: "split", visible: true },
					{ id: "link", type: "link", visible: true },
				],
				[SUMMARY],
			),
		);
		expect(push).toHaveBeenCalledTimes(1);
		const sent = push.mock.calls[0]?.[0];
		expect(sent?.anchors.map((a) => a.role)).toEqual(["main", "extra"]);
		expect(sent?.anchors[0]?.messages).toHaveLength(2);
	});

	it("没有附加项:只有本体那一个锚点", async () => {
		const { ctx, push } = layoutCtx();
		await send(ctx, params([{ id: "text", type: "text", visible: true }]));
		expect(push.mock.calls[0]?.[0].anchors.map((a) => a.role)).toEqual(["main"]);
	});

	it("版式把部件全藏了(本体不发):附加项照样交出去,只有附加项的锚点", async () => {
		const { ctx, push } = layoutCtx();
		const hidden = [
			{ id: "card", type: "card", visible: false },
			{ id: "text", type: "text", visible: false },
			{ id: "link", type: "link", visible: false },
		];
		await send(ctx, params(hidden, [WORDCLOUD, SUMMARY]));
		expect(push).toHaveBeenCalledTimes(1);
		expect(push.mock.calls[0]?.[0]).toMatchObject({ uid: "u1", type: LivePushType.LiveEnd });
		expect(push.mock.calls[0]?.[0].anchors).toEqual([WORDCLOUD, SUMMARY]);

		// 本体不发、也没有附加项:一次都不交。
		const bare = layoutCtx();
		await send(bare.ctx, params(hidden));
		expect(bare.push).not.toHaveBeenCalled();
	});

	it("出卡途中引擎被拆了:不交给推送层,附加项里做不出来的约定也有人接着", async () => {
		const { ctx, push } = layoutCtx();
		(ctx as unknown as { isDisposed: () => boolean }).isDisposed = () => true;
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => void unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		await send(
			ctx,
			params(
				[{ id: "text", type: "text", visible: true }],
				[{ role: "extra", extra: "liveSummary", messages: Promise.reject(new Error("没写出来")) }],
			),
		);
		await new Promise((r) => setTimeout(r, 0));
		await new Promise((r) => setTimeout(r, 0));
		process.off("unhandledRejection", onUnhandled);
		expect(push).not.toHaveBeenCalled();
		expect(unhandled).toEqual([]);
	});
});

describe("wantsLiveEndExtras — 弹幕采集的门", () => {
	it.each<[string, Partial<SubItemView>, boolean]>([
		[
			"下播开、词云开",
			{ extras: { atAllPost: false, atAllLiveStart: true, wordcloud: true, liveSummary: false } },
			true,
		],
		[
			"下播开、只开总结",
			{ extras: { atAllPost: false, atAllLiveStart: true, wordcloud: false, liveSummary: true } },
			true,
		],
		[
			"下播开、子项全关",
			{ extras: { atAllPost: false, atAllLiveStart: true, wordcloud: false, liveSummary: false } },
			false,
		],
		[
			"下播关、子项开着",
			{
				liveEnd: false,
				extras: { atAllPost: false, atAllLiveStart: true, wordcloud: true, liveSummary: true },
			},
			false,
		],
	])("%s", (_name, over, expected) => {
		expect(wantsLiveEndExtras(makeSub(over))).toBe(expected);
	});
});
