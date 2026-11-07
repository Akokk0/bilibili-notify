/**
 * 单元测试 — **作品装配入口** `PostQueue`:来源把作品交进来,同步返回、没有返回值、永不抛;入口同步发
 * `post-detected`(旁路通知,在串行闸与过滤之前),再按订阅串行跑 `deliverPost`。
 *
 * 等一条「发了不等」的作品:每条作品的活都经 `serviceCtx.track` 登记,这里用 `makeTrackingContext`
 * 把登记的 promise 攒下来再等。**凡是断言「没推」的用例,都先等 `settled()` 再断言**,否则作品还没跑到,断言永远是绿的;
 * 每条这样的用例旁边都有一条对照(同样的铺垫,条件反过来就推了)。
 */

import {
	DEFAULT_CONTENT_FILTERS,
	defaultMessageKindLayout,
	type MessageBus,
	type PostEvent,
	type SubscriptionOp,
} from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { logMessage } from "../../__tests__/support/log-message.js";
import {
	deferred,
	makeTrackingContext,
	stillPending,
} from "../../__tests__/support/track-context.js";
import { i18n } from "../../i18n/index.js";
import { createCardFailureTracker, type DeliverPostDeps, type PostSettings } from "../deliver-post";
import { createPostQueue } from "../post-queue";

const SETTINGS: PostSettings = {
	filter: DEFAULT_CONTENT_FILTERS,
	messageLayout: defaultMessageKindLayout("post"),
	cardEnabled: false,
	aiEnabled: false,
	aiWebSearch: false,
	template: "{name}发布了一条动态",
	videoTemplate: "{name}发布了新视频",
	imageGroup: { enabled: false, mergeForward: false },
};

function eventOf(id: string, postId = "p1", text = ""): PostEvent {
	return {
		subscriptionId: id,
		identity: { sourceKey: "fake", externalId: `ext-${id}` },
		postId,
		url: `https://example.com/${postId}`,
		post: { creator: { name: "阿绫" }, publishedAt: "2026-09-24T04:00:05.000Z", text },
	};
}

const labelOf = (text: string): string => text.split("/").pop() ?? "";

function makeBus() {
	const emits: Array<{ event: string; payload: unknown }> = [];
	const handlers = new Map<string, Array<(payload: unknown) => void>>();
	const bus = {
		emit: vi.fn((event: string, payload?: unknown) => {
			emits.push({ event, payload });
		}),
		on: (event: string, handler: (payload: unknown) => void) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return {
				dispose: () => {
					handlers.set(
						event,
						(handlers.get(event) ?? []).filter((h) => h !== handler),
					);
				},
			};
		},
	} as unknown as MessageBus;
	return {
		bus,
		emits,
		detected: () => emits.filter((e) => e.event === "post-detected").map((e) => e.payload),
		trigger: (event: string, payload: unknown) => {
			for (const h of handlers.get(event) ?? []) h(payload);
		},
		handlerCount: () => [...handlers.values()].reduce((n, list) => n + list.length, 0),
	};
}

function makeQueue(
	over: {
		/** 回 undefined = 这条订阅不该推。 */
		settings?: (id: string) => PostSettings | undefined;
		push?: (id: string, text: string) => Promise<void>;
	} = {},
) {
	const b = makeBus();
	const ctx = makeTrackingContext();
	const logs: Array<{ level: string; msg: string; args: unknown[] }> = [];
	const rec =
		(level: string) =>
		(msg: string, ...args: unknown[]) => {
			logs.push({ level, msg, args });
		};
	const logger = { info: rec("info"), warn: rec("warn"), error: rec("error"), debug: rec("debug") };
	/** 推出去的每一条:订阅 id 与作品标签(装配出的文字以作品地址收尾,地址末段就是 postId)。 */
	const pushed: Array<{ id: string; label: string }> = [];
	const recordFiltered = vi.fn();
	const deps: DeliverPostDeps = {
		logger,
		settings: over.settings ?? (() => SETTINGS),
		image: () => undefined,
		ai: () => undefined,
		cardFailures: createCardFailureTracker(),
		avatar: () => undefined,
		readImage: async () => undefined,
		push: async (id, anchors) => {
			const messages = (await anchors[0]?.messages) ?? [];
			const first = messages[0]?.find((s) => s.kind === "text");
			const text = first?.kind === "text" ? first.text : "";
			await over.push?.(id, text);
			pushed.push({ id, label: text.split("/").pop() ?? "" });
		},
		recordFiltered,
		emitPipelineError: () => {},
	};
	const queue = createPostQueue({ logger, bus: b.bus, serviceCtx: ctx, deps });
	return { queue, ctx, logs, pushed, recordFiltered, ...b };
}

describe("PostQueue.enqueue — 同步发 post-detected", () => {
	it("入队即同步发一次,载荷就是这份信封;没有返回值", () => {
		const q = makeQueue();
		const event = eventOf("s1");
		const returned = q.queue.enqueue(event);
		expect(returned).toBeUndefined();
		// 此刻装配还没跑完(异步),事件已经在总线上了。
		expect(q.detected()).toEqual([event]);
		expect(q.emits[0]?.event).toBe("post-detected");
	});

	it("在过滤之前发:被过滤挡下的作品照样发事件(统计口径是 UP 的产出);对照:挡下的没推、没挡的推了", async () => {
		const blocking: PostSettings = {
			...SETTINGS,
			filter: { ...DEFAULT_CONTENT_FILTERS, blockKeywords: ["广告"] },
		};
		const q = makeQueue({ settings: () => blocking });
		q.queue.enqueue(eventOf("s1", "p1", "来看广告"));
		q.queue.enqueue(eventOf("s1", "p2", "正常内容"));
		expect(q.detected()).toHaveLength(2);
		await q.ctx.settled();
		expect(q.recordFiltered).toHaveBeenCalledTimes(1);
		expect(q.pushed).toHaveLength(1);
	});

	it("在串行闸之前发:前一条还卡在推送里,后一条的事件已经发出去了", async () => {
		const hold = deferred();
		const q = makeQueue({
			push: (_id, text) => (text.includes("慢") ? hold.promise : Promise.resolve()),
		});
		q.queue.enqueue(eventOf("s1", "慢"));
		await vi.waitFor(() => expect(q.ctx.tracked).toHaveLength(1));
		q.queue.enqueue(eventOf("s1", "快"));
		expect(q.detected()).toHaveLength(2);
		expect(q.pushed).toHaveLength(0);
		hold.resolve();
		await q.ctx.settled();
		expect(q.pushed).toHaveLength(2);
	});
});

describe("PostQueue.enqueue — 订阅不该推就丢", () => {
	it("读口回 undefined(不在 / 停用 / 开关关着 / 来源没在跑):不发事件、不装配;对照:有设置就发事件也推", async () => {
		const q = makeQueue({ settings: (id) => (id === "gone" ? undefined : SETTINGS) });
		q.queue.enqueue(eventOf("gone"));
		q.queue.enqueue(eventOf("here"));
		await q.ctx.settled();
		expect(q.detected().map((e) => (e as PostEvent).subscriptionId)).toEqual(["here"]);
		expect(q.pushed.map((p) => p.id)).toEqual(["here"]);
		expect(q.ctx.tracked).toHaveLength(1);
		expect(
			q.logs.some((l) => l.level === "debug" && logMessage(l.msg, l.args).includes("gone")),
		).toBe(true);
	});
});

describe("PostQueue — 同一订阅串行,不同订阅互不排队", () => {
	it("同一订阅:第一条卡着,第二条不开跑;放行后按入队次序发", async () => {
		const hold = deferred();
		const started: string[] = [];
		const q = makeQueue({
			push: async (_id, text) => {
				started.push(labelOf(text));
				if (text.includes("一")) await hold.promise;
			},
		});
		q.queue.enqueue(eventOf("s1", "一"));
		q.queue.enqueue(eventOf("s1", "二"));
		await vi.waitFor(() => expect(started).toEqual(["一"]));
		await Promise.resolve();
		expect(started).toEqual(["一"]);
		hold.resolve();
		await q.ctx.settled();
		expect(q.pushed.map((p) => p.label)).toEqual(["一", "二"]);
	});

	it("不同订阅互不排队:甲卡着,乙照常发", async () => {
		const hold = deferred();
		const q = makeQueue({ push: (id) => (id === "a" ? hold.promise : Promise.resolve()) });
		q.queue.enqueue(eventOf("a"));
		q.queue.enqueue(eventOf("b"));
		await vi.waitFor(() => expect(q.pushed.map((p) => p.id)).toEqual(["b"]));
		hold.resolve();
		await q.ctx.settled();
		expect(q.pushed.map((p) => p.id).sort()).toEqual(["a", "b"]);
	});

	it("订阅删了闸被清:删除之后的新作品不再排在卡着的旧作品后面;对照:没删就排在后面", async () => {
		const run = async (remove: boolean): Promise<string[]> => {
			const hold = deferred();
			const q = makeQueue({
				push: (_id, text) => (text.includes("旧") ? hold.promise : Promise.resolve()),
			});
			q.queue.enqueue(eventOf("s1", "旧"));
			await vi.waitFor(() => expect(q.ctx.tracked).toHaveLength(1));
			if (remove) {
				const ops = [{ kind: "remove", sub: { id: "s1" } }] as unknown as SubscriptionOp[];
				q.trigger("subscription-changed", { ops });
			}
			q.queue.enqueue(eventOf("s1", "新"));
			await new Promise((r) => setTimeout(r, 10));
			const whileHeld = q.pushed.map((p) => p.label);
			hold.resolve();
			await q.ctx.settled();
			return whileHeld;
		};
		expect(await run(true)).toEqual(["新"]);
		expect(await run(false)).toEqual([]);
	});

	it("别的订阅被删,不影响这条订阅的闸", async () => {
		const hold = deferred();
		const q = makeQueue({
			push: (_id, text) => (text.includes("旧") ? hold.promise : Promise.resolve()),
		});
		q.queue.enqueue(eventOf("s1", "旧"));
		await vi.waitFor(() => expect(q.ctx.tracked).toHaveLength(1));
		const ops = [{ kind: "remove", sub: { id: "other" } }] as unknown as SubscriptionOp[];
		q.trigger("subscription-changed", { ops });
		q.queue.enqueue(eventOf("s1", "新"));
		await new Promise((r) => setTimeout(r, 10));
		expect(q.pushed).toEqual([]);
		hold.resolve();
		await q.ctx.settled();
		expect(q.pushed.map((p) => p.label)).toEqual(["旧", "新"]);
	});
});

describe("PostQueue — 登记进 track 与失败", () => {
	it("每条作品的活登记进 track:推送落定它才落定", async () => {
		const hold = deferred();
		const q = makeQueue({ push: () => hold.promise });
		q.queue.enqueue(eventOf("s1"));
		expect(q.ctx.tracked).toHaveLength(1);
		expect(await stillPending(q.ctx.settled())).toBe(true);
		hold.resolve();
		await q.ctx.settled();
		expect(q.pushed).toHaveLength(1);
	});

	it("装配抛错(推送口抛):只记 error、登记的这件事不拒、不重试,后面的照跑", async () => {
		let calls = 0;
		const q = makeQueue({
			push: async () => {
				calls++;
				if (calls === 1) throw new Error("bot 掉线");
			},
		});
		q.queue.enqueue(eventOf("s1", "p1"));
		q.queue.enqueue(eventOf("s1", "p2"));
		const results = await q.ctx.settled();
		expect(results).toHaveLength(2);
		expect(calls).toBe(2); // 没有重试:两条各推一次
		expect(q.pushed).toHaveLength(1);
		expect(
			q.logs.some(
				(l) =>
					l.level === "error" &&
					logMessage(l.msg, l.args).includes("bot 掉线") &&
					logMessage(l.msg, l.args).includes("s1"),
			),
		).toBe(true);
	});

	it("总线上的监听者抛错也不连累入口:不抛、照常装配、记 error", async () => {
		const q = makeQueue();
		(q.bus.emit as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
			throw new Error("监听者坏了");
		});
		expect(() => q.queue.enqueue(eventOf("s1"))).not.toThrow();
		await q.ctx.settled();
		expect(q.pushed).toHaveLength(1);
		expect(
			q.logs.some((l) => l.level === "error" && logMessage(l.msg, l.args).includes("监听者坏了")),
		).toBe(true);
	});
});

describe("PostQueue.dispose", () => {
	it("关了之后再交的作品一律丢:不发事件、不装配;退订了总线;同步 dispose 之前交的那条已发过事件,但装配还没开跑就被关了(不会推)", async () => {
		const q = makeQueue();
		q.queue.enqueue(eventOf("s1", "before"));
		expect(q.handlerCount()).toBe(1);
		q.queue.dispose();
		expect(q.handlerCount()).toBe(0);
		q.queue.enqueue(eventOf("s1", "after"));
		await q.ctx.settled();
		expect(q.detected().map((e) => (e as PostEvent).postId)).toEqual(["before"]);
		expect(q.ctx.tracked).toHaveLength(1);
	});

	it("关的时候还排在闸里没开跑的:现折设置读口认「队列已关」,一步都不往下走", async () => {
		const hold = deferred();
		const q = makeQueue({
			push: (_id, text) => (text.includes("一") ? hold.promise : Promise.resolve()),
		});
		q.queue.enqueue(eventOf("s1", "一"));
		q.queue.enqueue(eventOf("s1", "二"));
		await vi.waitFor(() => expect(q.ctx.tracked).toHaveLength(2));
		q.queue.dispose();
		hold.resolve();
		await q.ctx.settled();
		expect(q.pushed.map((p) => p.label)).toEqual(["一"]);
	});
});

describe("作品队列诊断语言", () => {
	it("处理失败按当前四语平实记录原错误，不记录正文，也不自动重试", async () => {
		const previous = i18n.state();
		try {
			for (const [locale, message] of [
				["en", "Post processing failed; this post will not be retried"],
				["ja", "投稿の処理に失敗しました。この投稿の自動再試行は行いません"],
				["zh-TW", "作品處理失敗，不自動重試此作品"],
				["zh-CN", "作品处理失败，不自动重试此作品"],
			] as const) {
				i18n.set({ locale, voice: "maid" });
				const error = new Error("delivery failed", { cause: new Error("socket closed") });
				const push = vi.fn(async () => {
					throw error;
				});
				const q = makeQueue({ push });
				try {
					expect(() => q.queue.enqueue(eventOf("s1", "p1", "PRIVATE-POST-CONTENT"))).not.toThrow();
					await q.ctx.settled();
					expect(push).toHaveBeenCalledTimes(1);
					expect(q.logs.filter((l) => l.level === "error")).toEqual([
						{
							level: "error",
							msg: message,
							args: [
								{
									event: "post.processing_failed",
									subscriptionId: "s1",
									identity: { sourceKey: "fake", externalId: "ext-s1" },
									postId: "p1",
								},
								error,
							],
						},
					]);
					expect(q.logs.find((l) => l.level === "error")?.args[1]).toBe(error);
					expect(JSON.stringify(q.logs)).not.toContain("PRIVATE-POST-CONTENT");
					i18n.set({ locale: "zh-CN" });
					expect(q.logs.find((l) => l.level === "error")?.msg).toBe(message);
				} finally {
					q.queue.dispose();
				}
			}
		} finally {
			i18n.set(previous);
		}
	});
});
