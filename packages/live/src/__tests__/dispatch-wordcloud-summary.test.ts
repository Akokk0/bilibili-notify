/**
 * 回归守护 — P0-1 fix(live): route live-summary independently from wordcloud。
 *
 * dispatchWordCloudAndSummary 此前把词云+总结合包成一次 broadcast 用
 * LivePushType.WordCloudAndLiveSummary=5 发出去,两端 adapter 都把 type=5 映射到
 * "wordcloud" 单一 FeatureKey。当用户关词云开总结时,总结被按 wordcloud 路由查
 * target 列表 → target 列表为空 → 推送丢弃。
 *
 * 修复后:wordcloud 走 WordCloudAndLiveSummary=5,总结走 LiveSummary=10,各自映射
 * 到对应 FeatureKey,路由独立。本测试锁住 dispatch 时的"两次独立 broadcast"事实。
 */

import type { MsgHandler } from "blive-message-listener";
import { describe, expect, it, vi } from "vite-plus/test";
import { LivePushType, type SubItemView } from "../push-like";
import type { RoomContext } from "../room-helpers";
import { RoomSessionBase } from "../room-session-base";

// RoomSessionBase 是 abstract;给一个最小子类把 protected dispatchWordCloudAndSummary
// 暴露给测试。同时给 masterInfo 塞个值,wordcloudGenerator 才会拿到 username。
class TestSession extends RoomSessionBase {
	protected buildHandler(): MsgHandler {
		return {} as MsgHandler;
	}
	async runDispatch(custom = ""): Promise<void> {
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
		return this.dispatchWordCloudAndSummary(custom);
	}
}

function makeSub(): SubItemView {
	return {
		uid: "u1",
		uname: "U1",
		roomId: "r1",
		dynamic: false,
		live: true,
		liveEnd: true,
		liveGuardBuy: false,
		superchat: false,
		wordcloud: true,
		liveSummary: true,
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
	};
}

interface CtxOpts {
	wantWordcloud: boolean;
	wantSummary: boolean;
	wcImage?: Buffer;
	summaryText?: string;
}

function makeCtx(opts: CtxOpts): {
	ctx: RoomContext;
	calls: Array<{ uid: string; content: unknown; type: LivePushType }>;
} {
	const calls: Array<{ uid: string; content: unknown; type: LivePushType }> = [];
	const stub = {
		logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		isSubscribed: vi.fn((_sub: SubItemView, type: string) => {
			if (type === "wordcloud") return opts.wantWordcloud;
			if (type === "liveSummary") return opts.wantSummary;
			return false;
		}),
		isDisposed: () => false,
		danmakuCollector: {
			// P2(dim7):真实 snapshot().senderRecord 是 Record<string,number>,
			// 此前 fixture 用 new Map() 与契约不符,掩盖消费方按对象遍历的潜在 bug。
			snapshot: () => ({ sortedWords: [], senderRecord: {} }),
		},
		wordcloudGenerator: { generate: vi.fn(async () => opts.wcImage) },
		liveSummaryRequester: { generate: vi.fn(async () => opts.summaryText) },
		contentBuilder: {
			image: (buf: Buffer, mime: string) => ({ kind: "image", buffer: buf, mime }),
			text: (t: string) => ({ kind: "text", text: t }),
		},
		push: {
			broadcastToTargets: async (uid: string, content: unknown, type: LivePushType) => {
				calls.push({ uid, content, type });
			},
			sendPrivateMsg: async () => {},
		},
	};
	return { ctx: stub as unknown as RoomContext, calls };
}

describe("dispatchWordCloudAndSummary — P0-1 路由拆分", () => {
	it("wordcloud=on summary=on:两次独立 broadcast,各用各的 LivePushType", async () => {
		const { ctx, calls } = makeCtx({
			wantWordcloud: true,
			wantSummary: true,
			wcImage: Buffer.from("img"),
			summaryText: "总结文本",
		});
		const session = new TestSession(ctx, makeSub());
		await session.runDispatch();

		expect(calls).toHaveLength(2);
		// 词云走 WordCloudAndLiveSummary=5(adapter 映射 wordcloud feature)
		expect(calls[0].type).toBe(LivePushType.WordCloudAndLiveSummary);
		// 总结走 LiveSummary=10(adapter 映射 liveSummary feature)
		expect(calls[1].type).toBe(LivePushType.LiveSummary);
	});

	it("wordcloud=off summary=on:只发总结,走 LiveSummary(不会被合包到 wordcloud)", async () => {
		const { ctx, calls } = makeCtx({
			wantWordcloud: false,
			wantSummary: true,
			summaryText: "只有总结",
		});
		const session = new TestSession(ctx, makeSub());
		await session.runDispatch();

		expect(calls).toHaveLength(1);
		expect(calls[0].type).toBe(LivePushType.LiveSummary);
	});

	it("wordcloud=on summary=off:只发词云,走 WordCloudAndLiveSummary", async () => {
		const { ctx, calls } = makeCtx({
			wantWordcloud: true,
			wantSummary: false,
			wcImage: Buffer.from("only-wc"),
		});
		const session = new TestSession(ctx, makeSub());
		await session.runDispatch();

		expect(calls).toHaveLength(1);
		expect(calls[0].type).toBe(LivePushType.WordCloudAndLiveSummary);
	});
});
