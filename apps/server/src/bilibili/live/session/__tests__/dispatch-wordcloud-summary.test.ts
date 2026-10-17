/**
 * 下播的两个附加项(词云 / AI 总结)各自门控、各是下播那次推送里的一个锚点。
 *
 * 历史:词云+总结曾合包成一次 broadcast(type=5),关词云开总结时总结跟着丢;后来拆成两种推送
 * 类型各发一次。现在两者是下播那次推送里排在卡片后面的附加项锚点(`recapAnchors`),由 `sub.extras`
 * 那两把门控、各带自己的附加项键,内容是各自的约定 —— 并行做,由推送层按「词云 → 总结」的先后发。
 */

import { defaultMessageKindLayout } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import type { LiveEvent } from "../../protocol/events.js";
import type { LivePushAnchor, PushExtrasLike, SubItemView } from "../../push-like";
import type { RoomContext } from "../room-helpers";
import { RoomSessionBase } from "../room-session-base";

// RoomSessionBase 是 abstract;给一个最小子类把 protected recapAnchors
// 暴露给测试。同时给 masterInfo 塞个值,wordcloudGenerator 才会拿到 username。
class TestSession extends RoomSessionBase {
	protected buildEventHandler(): (ev: LiveEvent) => void {
		return () => {};
	}
	recap(custom = "", medalName = ""): LivePushAnchor[] {
		// biome-ignore lint/suspicious/noExplicitAny: protected 字段的测试 setup
		(this as any).masterInfo = {
			username: "U",
			userface: "F",
			roomId: 0,
			liveOpenFollowerNum: 0,
			liveEndFollowerNum: 0,
			liveFollowerChange: 0,
			medalName,
		};
		return this.recapAnchors(custom);
	}
}

function makeSub(
	extras: Pick<PushExtrasLike, "wordcloud" | "liveSummary"> = {
		wordcloud: true,
		liveSummary: true,
	},
): SubItemView {
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
		extras: { atAllPost: false, atAllLiveStart: true, ...extras },
		target: {},
		customLiveMsg: { enable: false },
		guardTemplate: { enabled: false, default: { template: "", imageUrl: "" }, tiers: {} },
		customLiveSummary: { enable: false },
		customSpecialDanmakuUsers: { specialViewers: [], template: "" },
		customSpecialUsersEnterTheRoom: { specialViewers: [], template: "" },
		liveStreaming: false,
		streamingIntervalHours: 1,
		catchUpOnBoot: false,
		// 宿主恒填版式。
		messageLayout: defaultMessageKindLayout("live"),
	};
}

interface CtxOpts {
	wantWordcloud: boolean;
	wantSummary: boolean;
	wcImage?: Buffer;
	summaryText?: string;
	/** AI 那份;不给 = 请求器没带 ai 这个键。 */
	summaryAi?: string;
	sortedWords?: Array<[string, number]>;
}

/** 一组锚点最后各交出什么:`[角色, 附加项键, 兑现后的消息]`。 */
async function settled(anchors: LivePushAnchor[]) {
	return Promise.all(anchors.map(async (a) => [a.role, a.extra, await a.messages]));
}

function makeCtx(opts: CtxOpts): {
	ctx: RoomContext;
	sub: SubItemView;
	snapshot: ReturnType<typeof vi.fn>;
	disposed: { value: boolean };
} {
	const disposed = { value: false };
	const snapshot = vi.fn(() => ({ sortedWords: opts.sortedWords ?? [], senderRecord: {} }));
	const sub = makeSub({ wordcloud: opts.wantWordcloud, liveSummary: opts.wantSummary });
	const stub = {
		logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		isDisposed: () => disposed.value,
		danmakuCollector: {
			// P2(dim7):真实 snapshot().senderRecord 是 Record<string,number>,
			// 此前 fixture 用 new Map() 与契约不符,掩盖消费方按对象遍历的潜在 bug。
			snapshot,
		},
		wordcloudGenerator: { generate: vi.fn(async () => opts.wcImage) },
		// 词云的主播头像出卡那一刻按订阅 id 现读(3a-35);这组用例不关心头像。
		avatarOf: () => undefined,
		liveSummaryRequester: {
			generate: vi.fn(() =>
				opts.summaryText === undefined
					? undefined
					: {
							template: opts.summaryText,
							...(opts.summaryAi === undefined ? {} : { ai: Promise.resolve(opts.summaryAi) }),
						},
			),
		},
		contentBuilder: {
			image: (buf: Buffer, mime: string) => ({ kind: "image", buffer: buf, mime }),
			text: (t: string) => ({ kind: "text", text: t }),
		},
	};
	return { ctx: stub as unknown as RoomContext, sub, snapshot, disposed };
}

describe("recapAnchors — 粉丝牌名在宿主边界折叠", () => {
	const generateOf = (ctx: RoomContext) =>
		(ctx.liveSummaryRequester as unknown as { generate: ReturnType<typeof vi.fn> }).generate;

	it("medalName 为空串 → 传给总结请求器的参数里缺 fanClubName 这个键", () => {
		const { ctx, sub } = makeCtx({ wantWordcloud: false, wantSummary: true, summaryText: "x" });
		new TestSession(ctx, sub).recap("", "");
		expect(generateOf(ctx).mock.calls[0]?.[0]).not.toHaveProperty("fanClubName");
	});

	it("medalName 有值 → 原样作为 fanClubName", () => {
		const { ctx, sub } = makeCtx({ wantWordcloud: false, wantSummary: true, summaryText: "x" });
		new TestSession(ctx, sub).recap("", "小晨");
		expect(generateOf(ctx).mock.calls[0]?.[0]).toHaveProperty("fanClubName", "小晨");
	});
});

describe("recapAnchors — 两个附加项各自门控、各一个锚点", () => {
	it("wordcloud=on summary=on:两个附加项锚点,按「词云 → 总结」排,各带各的键", async () => {
		const { ctx, sub } = makeCtx({
			wantWordcloud: true,
			wantSummary: true,
			wcImage: Buffer.from("img"),
			summaryText: "总结文本",
		});
		const anchors = new TestSession(ctx, sub).recap();
		expect(await settled(anchors)).toEqual([
			["extra", "wordcloud", [{ kind: "image", buffer: Buffer.from("img"), mime: "image/jpeg" }]],
			["extra", "liveSummary", [{ kind: "text", text: "总结文本" }]],
		]);
	});

	it("wordcloud=off summary=on:只有总结的锚点(不会被合包到词云里),词云不算", async () => {
		const { ctx, sub } = makeCtx({
			wantWordcloud: false,
			wantSummary: true,
			summaryText: "只有总结",
		});
		const anchors = new TestSession(ctx, sub).recap();
		expect(await settled(anchors)).toEqual([
			["extra", "liveSummary", [{ kind: "text", text: "只有总结" }]],
		]);
		expect(ctx.wordcloudGenerator.generate).not.toHaveBeenCalled();
	});

	it("wordcloud=on summary=off:只有词云的锚点,不问 AI", async () => {
		const { ctx, sub } = makeCtx({
			wantWordcloud: true,
			wantSummary: false,
			wcImage: Buffer.from("only-wc"),
		});
		const anchors = new TestSession(ctx, sub).recap();
		expect((await settled(anchors)).map((a) => a[1])).toEqual(["wordcloud"]);
		expect(ctx.liveSummaryRequester.generate).not.toHaveBeenCalled();
	});

	it("两个都关:没有锚点,连弹幕快照都不取", async () => {
		const { ctx, sub, snapshot } = makeCtx({ wantWordcloud: false, wantSummary: false });
		expect(new TestSession(ctx, sub).recap()).toEqual([]);
		expect(snapshot).not.toHaveBeenCalled();
	});

	it("弹幕快照在调用那一刻同步取,两样随即各自开始做(不等对方)", () => {
		const { ctx, sub, snapshot } = makeCtx({
			wantWordcloud: true,
			wantSummary: true,
			wcImage: Buffer.from("img"),
			summaryText: "总结",
		});
		const anchors = new TestSession(ctx, sub).recap();
		// 还没 await 任何东西:快照已经取了,两个生成器都已经被叫到。
		expect(snapshot).toHaveBeenCalledTimes(1);
		expect(ctx.wordcloudGenerator.generate).toHaveBeenCalledTimes(1);
		expect(ctx.liveSummaryRequester.generate).toHaveBeenCalledTimes(1);
		expect(anchors.every((a) => a.messages instanceof Promise)).toBe(true);
	});

	it("什么都没做出来(生成器回空)→ 约定给 undefined,由推送层跳过那个锚点", async () => {
		const { ctx, sub } = makeCtx({ wantWordcloud: true, wantSummary: true });
		expect(await settled(new TestSession(ctx, sub).recap())).toEqual([
			["extra", "wordcloud", undefined],
			["extra", "liveSummary", undefined],
		]);
	});

	it("做好之后引擎已经被拆了 → 约定给 undefined,不再往外交内容", async () => {
		const { ctx, sub, disposed } = makeCtx({
			wantWordcloud: true,
			wantSummary: true,
			wcImage: Buffer.from("img"),
			summaryText: "总结",
		});
		const anchors = new TestSession(ctx, sub).recap();
		disposed.value = true;
		expect((await settled(anchors)).map((a) => a[2])).toEqual([undefined, undefined]);
	});

	it("总结的 AI 那份:没拆时原样交出;拆了之后也给 undefined(同 messages)", async () => {
		const { ctx, sub, disposed } = makeCtx({
			wantWordcloud: false,
			wantSummary: true,
			summaryText: "模板总结",
			summaryAi: "AI 总结",
		});
		const [alive] = new TestSession(ctx, sub).recap();
		expect(await alive?.aiMessages).toEqual([{ kind: "text", text: "AI 总结" }]);
		const [late] = new TestSession(ctx, sub).recap();
		disposed.value = true;
		expect(await late?.messages).toBeUndefined();
		expect(await late?.aiMessages).toBeUndefined();
	});

	it("总结没有 AI 那份:锚点上没有 aiMessages 这个键", () => {
		const { ctx, sub } = makeCtx({ wantWordcloud: false, wantSummary: true, summaryText: "总结" });
		const [summary] = new TestSession(ctx, sub).recap();
		expect(summary && "aiMessages" in summary).toBe(false);
	});

	it("做的时候出错 → 那个锚点的约定被拒绝(由推送层记警告并跳过),另一个不受牵连", async () => {
		const { ctx, sub } = makeCtx({ wantWordcloud: true, wantSummary: true, summaryText: "总结" });
		(ctx.wordcloudGenerator.generate as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error("词云画不出来"),
		);
		const [wordcloud, summary] = new TestSession(ctx, sub).recap();
		await expect(wordcloud?.messages).rejects.toThrow("词云画不出来");
		expect(await summary?.messages).toEqual([{ kind: "text", text: "总结" }]);
	});
});

describe("recapAnchors — per-UP 弹幕词云停用词过滤", () => {
	it("过滤掉 per-UP wordcloudStopWords 命中的词后再喂词云与总结", async () => {
		const { ctx } = makeCtx({
			wantWordcloud: true,
			wantSummary: true,
			wcImage: Buffer.from("img"),
			summaryText: "总结",
			sortedWords: [
				["刷屏", 10],
				["精彩", 5],
				["哈哈", 3],
			],
		});
		const sub = makeSub();
		sub.wordcloudStopWords = "刷屏, 哈哈";
		const session = new TestSession(ctx, sub);
		await settled(session.recap());

		const wcArg = (ctx.wordcloudGenerator.generate as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
		expect(wcArg).toEqual([["精彩", 5]]);
		const sumArg = (ctx.liveSummaryRequester.generate as ReturnType<typeof vi.fn>).mock
			.calls[0]?.[0].sortedWords;
		expect(sumArg).toEqual([["精彩", 5]]);
	});

	// 「接线要有自己的守卫」:WordcloudGenerator 自己那条 cardSkin 的测试证明不了
	// room-session-base 真的把 sub 的皮肤递了进去 —— 那个参数是可选的,漏掉照样全绿。
	it("per-UP 皮肤 id 递给词云生成器(第四参)", async () => {
		const { ctx } = makeCtx({
			wantWordcloud: true,
			wantSummary: true,
			sortedWords: [["精彩", 5]],
		});
		const sub = makeSub();
		sub.cardSkin = "k6eee-cafed00d";
		await settled(new TestSession(ctx, sub).recap());
		const call = (ctx.wordcloudGenerator.generate as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(call?.[3]).toBe("k6eee-cafed00d");
	});

	// 词云卡也吃这位 UP 那份旋钮(不分卡种,ADR-0014 决策 17 的 🔗)。
	// 验红:把 room-session-base.ts 里交给 recapAnchors 的 `cardSkinKnobs` 删掉(或 live/recap/recap-anchors.ts 里递给词云生成器的第五参),这条红。
	it("per-UP 旋钮覆盖递给词云生成器(第五参)", async () => {
		const { ctx } = makeCtx({
			wantWordcloud: true,
			wantSummary: true,
			sortedWords: [["精彩", 5]],
		});
		const sub = makeSub();
		const cardSkinKnobs = { "k6eee-cafed00d": { accent: "#aaaaaa" } };
		sub.cardSkinKnobs = cardSkinKnobs;
		await settled(new TestSession(ctx, sub).recap());
		const call = (ctx.wordcloudGenerator.generate as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(call?.[4]).toEqual(cardSkinKnobs);
	});

	it("无 per-UP 停用词时 sortedWords 原样透传", async () => {
		const { ctx } = makeCtx({
			wantWordcloud: true,
			wantSummary: false,
			wcImage: Buffer.from("img"),
			sortedWords: [
				["精彩", 5],
				["哈哈", 3],
			],
		});
		const session = new TestSession(ctx, makeSub());
		await settled(session.recap());

		const wcArg = (ctx.wordcloudGenerator.generate as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
		expect(wcArg).toEqual([
			["精彩", 5],
			["哈哈", 3],
		]);
	});
});
