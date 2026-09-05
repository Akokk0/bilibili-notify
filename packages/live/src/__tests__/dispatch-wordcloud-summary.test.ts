/**
 * 下播的两个附加项(词云 / AI 总结)各自门控、各自一次 broadcast。
 *
 * 历史:词云+总结曾合包成一次 broadcast(type=5),关词云开总结时总结跟着丢;拆开后
 * 词云走 WordCloudAndLiveSummary=5、总结走 LiveSummary=10。现在两者都是下播的附加项,
 * 由 `sub.liveEndExtras` 门控,用同一个 pushId、标 `role: "extra"` 追加。
 */

import type { LiveEvent } from "@bilibili-notify/blive";
import { defaultMessageKindLayout } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { LivePushType, type SubItemView } from "../push-like";
import type { RoomContext } from "../room-helpers";
import { RoomSessionBase } from "../room-session-base";

// RoomSessionBase 是 abstract;给一个最小子类把 protected dispatchWordCloudAndSummary
// 暴露给测试。同时给 masterInfo 塞个值,wordcloudGenerator 才会拿到 username。
class TestSession extends RoomSessionBase {
	protected buildEventHandler(): (ev: LiveEvent) => void {
		return () => {};
	}
	async runDispatch(custom = "", pushId = "11111111-1111-4111-8111-111111111111"): Promise<void> {
		// biome-ignore lint/suspicious/noExplicitAny: protected 字段的测试 setup
		(this as any).masterInfo = {
			username: "U",
			userface: "F",
			roomId: 0,
			liveOpenFollowerNum: 0,
			liveEndFollowerNum: 0,
			liveFollowerChange: 0,
			medalName: "",
		};
		return this.dispatchWordCloudAndSummary(custom, pushId);
	}
}

function makeSub(extras = { wordcloud: true, liveSummary: true }): SubItemView {
	return {
		uid: "u1",
		uname: "U1",
		roomId: "r1",
		dynamic: false,
		live: true,
		liveEnd: true,
		liveGuardBuy: false,
		superchat: false,
		liveEndExtras: extras,
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
		// 宿主恒填版式。
		messageLayout: defaultMessageKindLayout("live"),
	};
}

interface CtxOpts {
	wantWordcloud: boolean;
	wantSummary: boolean;
	wcImage?: Buffer;
	summaryText?: string;
	sortedWords?: Array<[string, number]>;
}

interface Call {
	uid: string;
	content: unknown;
	type: LivePushType;
	opts?: unknown;
}

function makeCtx(opts: CtxOpts): { ctx: RoomContext; calls: Call[]; sub: SubItemView } {
	const calls: Call[] = [];
	const sub = makeSub({ wordcloud: opts.wantWordcloud, liveSummary: opts.wantSummary });
	const stub = {
		logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		isDisposed: () => false,
		danmakuCollector: {
			// P2(dim7):真实 snapshot().senderRecord 是 Record<string,number>,
			// 此前 fixture 用 new Map() 与契约不符,掩盖消费方按对象遍历的潜在 bug。
			snapshot: () => ({ sortedWords: opts.sortedWords ?? [], senderRecord: {} }),
		},
		wordcloudGenerator: { generate: vi.fn(async () => opts.wcImage) },
		liveSummaryRequester: { generate: vi.fn(async () => opts.summaryText) },
		contentBuilder: {
			image: (buf: Buffer, mime: string) => ({ kind: "image", buffer: buf, mime }),
			text: (t: string) => ({ kind: "text", text: t }),
		},
		push: {
			broadcastToTargets: async (
				uid: string,
				content: unknown,
				type: LivePushType,
				o?: unknown,
			) => {
				calls.push({ uid, content, type, opts: o });
			},
			sendPrivateMsg: async () => {},
		},
	};
	return { ctx: stub as unknown as RoomContext, calls, sub };
}

describe("dispatchWordCloudAndSummary — 两个附加项各自门控", () => {
	it("wordcloud=on summary=on:两次独立 broadcast,各用各的 LivePushType,同 pushId、标 extra", async () => {
		const { ctx, calls, sub } = makeCtx({
			wantWordcloud: true,
			wantSummary: true,
			wcImage: Buffer.from("img"),
			summaryText: "总结文本",
		});
		const session = new TestSession(ctx, sub);
		await session.runDispatch("", "22222222-2222-4222-8222-222222222222");

		expect(calls.map((c) => [c.type, c.opts])).toEqual([
			[
				LivePushType.WordCloudAndLiveSummary,
				{ pushId: "22222222-2222-4222-8222-222222222222", role: "extra" },
			],
			[LivePushType.LiveSummary, { pushId: "22222222-2222-4222-8222-222222222222", role: "extra" }],
		]);
	});

	it("wordcloud=off summary=on:只发总结,走 LiveSummary(不会被合包到 wordcloud)", async () => {
		const { ctx, calls, sub } = makeCtx({
			wantWordcloud: false,
			wantSummary: true,
			summaryText: "只有总结",
		});
		const session = new TestSession(ctx, sub);
		await session.runDispatch();

		expect(calls).toHaveLength(1);
		expect(calls[0]?.type).toBe(LivePushType.LiveSummary);
	});

	it("wordcloud=on summary=off:只发词云,走 WordCloudAndLiveSummary", async () => {
		const { ctx, calls, sub } = makeCtx({
			wantWordcloud: true,
			wantSummary: false,
			wcImage: Buffer.from("only-wc"),
		});
		const session = new TestSession(ctx, sub);
		await session.runDispatch();

		expect(calls).toHaveLength(1);
		expect(calls[0]?.type).toBe(LivePushType.WordCloudAndLiveSummary);
	});
});

describe("dispatchWordCloudAndSummary — per-UP 弹幕词云停用词过滤", () => {
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
		await session.runDispatch();

		const wcArg = (ctx.wordcloudGenerator.generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(wcArg).toEqual([["精彩", 5]]);
		const sumArg = (ctx.liveSummaryRequester.generate as ReturnType<typeof vi.fn>).mock.calls[0][0]
			.sortedWords;
		expect(sumArg).toEqual([["精彩", 5]]);
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
		await session.runDispatch();

		const wcArg = (ctx.wordcloudGenerator.generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(wcArg).toEqual([
			["精彩", 5],
			["哈哈", 3],
		]);
	});
});
