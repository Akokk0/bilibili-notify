/**
 * 拓展作品的消费者(`bindExtensionPosts`,ADR-0019 决策 62 / 67)—— **同一条订阅的作品按到达顺序串行**。
 *
 * 拓展一口气报两条时,两条是两个互不排队的异步上下文,各自出卡、各自发送:第一条出卡慢(图多、
 * 渲染器在排队),第二条就会先送到群里,主人看到的顺序和发布顺序反过来。每条订阅一道串行闸治的就是
 * 这个。闸拿掉,别的测试一条都不会红(e2e 的渲染本来就经浏览器那道全局的闸串着),所以单独钉一条。
 */

import {
	type BoundWorkPush,
	createCardFailureTracker,
	type PushSegment,
} from "@bilibili-notify/dynamic";
import type { ImageRenderer } from "@bilibili-notify/image";
import {
	checkSubscriptionReport,
	defaultMessageKindLayout,
	SUBSCRIPTION_REPORT_TEXT_MAX,
	type SubscriptionReportValue,
} from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import {
	deferred,
	makeTrackingContext,
	stillPending,
} from "../../__tests__/support/track-context.js";
import { bindExtensionPosts } from "../extension-posts.js";
import { createNodeMessageBus } from "../message-bus.js";

const SUB = makeExtensionSubscription({ externalId: "sec-uid-1" });
const logger = { debug() {}, info() {}, warn() {}, error() {} };
/** 这批用例的作品都不带图,图库的口不会被调到。 */
const postImages = {
	put: async () => ({ ok: false as const, code: "invalid" as const, message: "测试不存图" }),
};

function post(n: number): SubscriptionReportValue<"post"> {
	return {
		id: `p${n}`,
		url: `https://www.douyin.com/video/p${n}`,
		publishedAt: Date.UTC(2026, 8, 24, 12, n),
		text: `第 ${n} 条`,
	};
}

describe("bindExtensionPosts — 同一条订阅的作品按到达顺序发", () => {
	it("第一条出卡慢、第二条紧跟着到:发出去仍是先一后二", async () => {
		const bus = createNodeMessageBus();
		/** 第一次出卡卡在这儿,由测试放行;之后的都立刻出。 */
		let releaseFirst: () => void = () => {};
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let renders = 0;
		const image = {
			generatePostCard: vi.fn(async () => {
				if (renders++ === 0) await firstGate;
				return Buffer.from("card");
			}),
		} as unknown as ImageRenderer;
		/** 发出去的每条消息里的链接(卡 + 文案 + 链接合成一条,链接在文字段的末行)。 */
		const sent: string[] = [];
		const push: BoundWorkPush = {
			broadcast: async (segments: PushSegment[]) => {
				const text = segments.find((s) => s.type === "text");
				sent.push(text?.type === "text" ? (text.text.split("\n").pop() ?? "") : "");
			},
			broadcastSequence: async () => {},
		};

		const handle = bindExtensionPosts({
			bus,
			logger,
			serviceCtx: makeTrackingContext(),
			subscription: (id) => (id === SUB.id ? SUB : undefined),
			profileName: () => "资料名",
			avatarRef: () => undefined,
			postImages,
			settings: () => ({
				messageLayout: defaultMessageKindLayout("post"),
				filter: {},
				post: true,
			}),
			sources: {
				running: () => true,
				postNoun: () => "作品",
				events: () => ["post"],
			},
			pushFor: () => push,
			deliveryConfig: () => ({ imageGroup: { enable: false, forward: false } }),
			deliveryDeps: () => ({
				logger,
				image,
				cardFailures: createCardFailureTracker(),
				sendErrorMsg: async () => {},
				emitEngineError: () => {},
			}),
		});

		for (const n of [1, 2]) {
			bus.emit("subscription-reported", {
				extensionId: SUB.identity.sourceKey,
				externalId: SUB.identity.externalId,
				subscriptionIds: [SUB.id],
				report: { kind: "post", value: post(n) },
			});
		}

		// 第一条已经在出卡、卡住了;第二条得在闸后面等着 —— 它这会儿既不该出卡,更不该发出去。
		await vi.waitFor(() => expect(renders).toBe(1));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(sent).toEqual([]);
		expect(renders).toBe(1);

		releaseFirst();
		await vi.waitFor(() => expect(sent).toHaveLength(2));
		expect(sent).toEqual([post(1).url, post(2).url]);
		handle.dispose();
	});
});

/**
 * 正文超过上限的作品(ADR-0019 决策 59 的 09-24 🔗):收下时截到上限,**屏蔽看的是截下来的那一段**。从前
 * 超长的正文整格丢掉,屏蔽看到的是空串 —— 前一万字里写着屏蔽词的长文照推。
 *
 * 走的是宿主收下作品的那一道(`checkSubscriptionReport`,ctx 原样交它的结果)→ bus → 作品的消费者 → 过滤。
 */
describe("bindExtensionPosts — 超长正文截断后照样过屏蔽", () => {
	it("前一万字里有屏蔽词、整段超长:挡下,不出卡不推", async () => {
		const bus = createNodeMessageBus();
		const render = vi.fn(async () => Buffer.from("card"));
		const image = { generatePostCard: render } as unknown as ImageRenderer;
		const sent: PushSegment[][] = [];
		const push: BoundWorkPush = {
			broadcast: async (segments: PushSegment[]) => {
				sent.push(segments);
			},
			broadcastSequence: async () => {},
		};
		const handle = bindExtensionPosts({
			bus,
			logger,
			serviceCtx: makeTrackingContext(),
			subscription: (id) => (id === SUB.id ? SUB : undefined),
			profileName: () => "资料名",
			avatarRef: () => undefined,
			postImages,
			settings: () => ({
				messageLayout: defaultMessageKindLayout("post"),
				filter: { enable: true, keywords: ["海边"] },
				post: true,
			}),
			sources: {
				running: () => true,
				postNoun: () => "作品",
				events: () => ["post"],
			},
			pushFor: () => push,
			deliveryConfig: () => ({ imageGroup: { enable: false, forward: false } }),
			deliveryDeps: () => ({
				logger,
				image,
				cardFailures: createCardFailureTracker(),
				sendErrorMsg: async () => {},
				emitEngineError: () => {},
			}),
		});

		const text = `今天去海边${"浪".repeat(SUBSCRIPTION_REPORT_TEXT_MAX)}`;
		const checked = checkSubscriptionReport("post", { ...post(1), text });
		if (!checked.ok) throw new Error(checked.reason);
		bus.emit("subscription-reported", {
			extensionId: SUB.identity.sourceKey,
			externalId: SUB.identity.externalId,
			subscriptionIds: [SUB.id],
			report: { kind: "post", value: checked.value },
		});

		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(render).not.toHaveBeenCalled();
		expect(sent).toEqual([]);
		handle.dispose();
	});
});

/**
 * 关停(切片 ③)。每条作品的出卡与推送是发出去不等的后台活;登记进 `ctx.track()` 之后关停等它推完 ——
 * 推送落历史的那一笔得赶在各写道关门之前交进去。
 */
describe("bindExtensionPosts — 登记进 track", () => {
	function bind(overrides: { broadcast: () => Promise<void> }) {
		const ctx = makeTrackingContext();
		const bus = createNodeMessageBus();
		const image = {
			generatePostCard: vi.fn(async () => Buffer.from("card")),
		} as unknown as ImageRenderer;
		const push: BoundWorkPush = {
			broadcast: overrides.broadcast,
			broadcastSequence: async () => {},
		};
		const errors: string[] = [];
		const handle = bindExtensionPosts({
			bus,
			logger: { ...logger, error: (msg: string) => errors.push(msg) },
			serviceCtx: ctx,
			subscription: (id) => (id === SUB.id ? SUB : undefined),
			profileName: () => "资料名",
			avatarRef: () => undefined,
			postImages,
			settings: () => ({
				messageLayout: defaultMessageKindLayout("post"),
				filter: {},
				post: true,
			}),
			sources: {
				running: () => true,
				postNoun: () => "作品",
				events: () => ["post"],
			},
			pushFor: () => push,
			deliveryConfig: () => ({ imageGroup: { enable: false, forward: false } }),
			deliveryDeps: () => ({
				logger,
				image,
				cardFailures: createCardFailureTracker(),
				sendErrorMsg: async () => {},
				emitEngineError: () => {},
			}),
		});
		const emit = (n: number) =>
			bus.emit("subscription-reported", {
				extensionId: SUB.identity.sourceKey,
				externalId: SUB.identity.externalId,
				subscriptionIds: [SUB.id],
				report: { kind: "post", value: post(n) },
			});
		return { ctx, handle, emit, errors };
	}

	it("一条作品的推送登记进 track:发送落定它才落定", async () => {
		const sending = deferred();
		const broadcast = vi.fn(() => sending.promise);
		const { ctx, handle, emit } = bind({ broadcast });

		emit(1);

		expect(ctx.tracked).toHaveLength(1);
		await vi.waitFor(() => expect(broadcast).toHaveBeenCalledTimes(1)); // 卡出好了,发送停在半路
		expect(await stillPending(ctx.settled())).toBe(true);
		sending.resolve(undefined);
		await ctx.settled();
		handle.dispose();
	});

	it("推送途中出错:登记进去的这件事不拒,记一条 error(决策 77:不重试)", async () => {
		const broadcast = vi.fn(async () => {
			throw new Error("boom");
		});
		const { ctx, handle, emit, errors } = bind({ broadcast });

		emit(1);

		await expect(ctx.tracked[0]).resolves.toBeUndefined();
		expect(errors.some((msg) => msg.includes("boom"))).toBe(true);
		handle.dispose();
	});
});

/**
 * 屏蔽提醒里平台对作品的叫法(ADR-0019 决策 70):按**这条订阅所属的拓展**去取,不是随便哪个。
 * 别的测试里 `postNoun` 都是不看参数的桩,取错拓展也一样绿 —— 这里让它只认这条订阅的拓展。
 */
describe("bindExtensionPosts — 平台的作品叫法按订阅所属的拓展取", () => {
	it("屏蔽提醒里写的是这个拓展的叫法(别的拓展没有叫法、会落回「作品」)", async () => {
		const bus = createNodeMessageBus();
		const image = {
			generatePostCard: vi.fn(async () => Buffer.from("card")),
		} as unknown as ImageRenderer;
		const sent: PushSegment[][] = [];
		const push: BoundWorkPush = {
			broadcast: async (segments: PushSegment[]) => {
				sent.push(segments);
			},
			broadcastSequence: async () => {},
		};
		const asked: string[] = [];
		const handle = bindExtensionPosts({
			bus,
			logger,
			serviceCtx: makeTrackingContext(),
			subscription: (id) => (id === SUB.id ? SUB : undefined),
			profileName: () => "资料名",
			avatarRef: () => undefined,
			postImages,
			settings: () => ({
				messageLayout: defaultMessageKindLayout("post"),
				filter: { enable: true, keywords: ["海边"], notify: true },
				post: true,
			}),
			sources: {
				running: () => true,
				postNoun: (extensionId) => {
					asked.push(extensionId);
					return extensionId === SUB.identity.sourceKey ? "视频" : undefined;
				},
				events: () => ["post"],
			},
			pushFor: () => push,
			deliveryConfig: () => ({ imageGroup: { enable: false, forward: false } }),
			deliveryDeps: () => ({
				logger,
				image,
				cardFailures: createCardFailureTracker(),
				sendErrorMsg: async () => {},
				emitEngineError: () => {},
			}),
		});

		bus.emit("subscription-reported", {
			extensionId: SUB.identity.sourceKey,
			externalId: SUB.identity.externalId,
			subscriptionIds: [SUB.id],
			report: { kind: "post", value: { ...post(1), text: "今天去海边" } },
		});

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(asked).toEqual([SUB.identity.sourceKey]);
		expect(sent[0]).toEqual([{ type: "text", text: "资料名发布了一条含有屏蔽关键字的视频" }]);
		handle.dispose();
	});
});
