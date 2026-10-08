/**
 * 拓展作品的消费者(`bindExtensionPosts`,ADR-0019 决策 62 / 67)—— **同一条订阅的作品按到达顺序串行**。
 *
 * 拓展一口气报两条时,两条是两个互不排队的异步上下文,各自出卡、各自发送:第一条出卡慢(图多、
 * 渲染器在排队),第二条就会先送到群里,主人看到的顺序和发布顺序反过来。每条订阅一道串行闸治的就是
 * 这个。闸拿掉,别的测试一条都不会红(e2e 的渲染本来就经浏览器那道全局的闸串着),所以单独钉一条。
 */

import type { ImageRenderer } from "@bilibili-notify/image";
import {
	checkSubscriptionReport,
	DEFAULT_CONTENT_FILTERS,
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
import {
	type BoundWorkPush,
	createCardFailureTracker,
	type PushSegment,
} from "../../bilibili/dynamic/index.js";
import { imageRefOf } from "../../images/image-store.js";
import { bindExtensionPosts } from "../extension-posts.js";
import { createNodeMessageBus } from "../message-bus.js";

const SUB = makeExtensionSubscription({ externalId: "sec-uid-1" });
const logger = { debug() {}, info() {}, warn() {}, error() {} };
/** 图库的口:回图库起的那个名字(内容哈希)。写盘推迟到出卡,翻译时算的引用必须与它一致。 */
const postImages = {
	put: async (bytes: Uint8Array) => {
		const ref = imageRefOf(bytes);
		if (!ref) return { ok: false as const, code: "invalid" as const, message: "不是图" };
		return { ok: true as const, ref };
	},
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
				const text = segments.find((s) => s.kind === "text");
				sent.push(text?.kind === "text" ? (text.text.split("\n").pop() ?? "") : "");
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
				filter: DEFAULT_CONTENT_FILTERS,
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
				filter: { ...DEFAULT_CONTENT_FILTERS, blockKeywords: ["海边"] },
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
				filter: DEFAULT_CONTENT_FILTERS,
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
				filter: { ...DEFAULT_CONTENT_FILTERS, blockKeywords: ["海边"], notify: true },
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
		expect(sent[0]).toEqual([{ kind: "text", text: "资料名发布了一条含有屏蔽关键字的视频" }]);
		handle.dispose();
	});
});

/**
 * 过滤吃翻好的 `Post`,**类型开关对拓展作品同样生效**(㉑e,ADR-0021 决策 43):从前拓展只过文字那一半
 * (ADR-0019 决策 70「抖音几乎全是视频」的豁免),现在豁免删了,是主人拍板的行为变化。
 *
 * 翻译排在过滤之前(过滤要看有没有图集 / 视频),所以图的写盘推迟到出卡那一刻(`deferImageWrites`):被屏蔽的、
 * 关了出图的作品**一张图都不往图库写**。这里走真的 `bindExtensionPosts`,经 bus 报一条作品,看卡有没有出、
 * 消息有没有发、图库的口有没有被调。验红:把 `extension-posts.ts` 里的 `filterPost(...)` 去掉,各条拦截红。
 */
describe("bindExtensionPosts — 过滤吃翻好的 Post,类型开关对拓展作品生效", () => {
	const PNG = new Uint8Array([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1,
		0, 0, 0, 1, 8, 6, 0, 0, 0,
	]);

	function bind(
		filter: Partial<typeof DEFAULT_CONTENT_FILTERS> & { notify?: boolean },
		deliveryConfig: { imageEnabled?: boolean } = {},
	) {
		const bus = createNodeMessageBus();
		const events: string[] = [];
		const render = vi.fn(async () => {
			events.push("card");
			return Buffer.from("card");
		});
		const image = { generatePostCard: render } as unknown as ImageRenderer;
		const sent: PushSegment[][] = [];
		const push: BoundWorkPush = {
			broadcast: async (segments: PushSegment[]) => {
				sent.push(segments);
			},
			broadcastSequence: async () => {},
		};
		const put = vi.fn(async (bytes: Uint8Array) => {
			events.push("put");
			return postImages.put(bytes);
		});
		const handle = bindExtensionPosts({
			bus,
			logger,
			serviceCtx: makeTrackingContext(),
			subscription: (id) => (id === SUB.id ? SUB : undefined),
			profileName: () => "资料名",
			avatarRef: () => undefined,
			postImages: { put },
			settings: () => ({
				messageLayout: defaultMessageKindLayout("post"),
				filter: { ...DEFAULT_CONTENT_FILTERS, ...filter },
				post: true,
			}),
			sources: { running: () => true, postNoun: () => "作品", events: () => ["post"] },
			pushFor: () => push,
			deliveryConfig: () => ({ imageGroup: { enable: false, forward: false }, ...deliveryConfig }),
			deliveryDeps: () => ({
				logger,
				image,
				cardFailures: createCardFailureTracker(),
				sendErrorMsg: async () => {},
				emitEngineError: () => {},
			}),
		});
		const emit = (value: SubscriptionReportValue<"post">) =>
			bus.emit("subscription-reported", {
				extensionId: SUB.identity.sourceKey,
				externalId: SUB.identity.externalId,
				subscriptionIds: [SUB.id],
				report: { kind: "post", value },
			});
		/** 等这一条走完(推出去了,或被挡下后闸里没有后续)。 */
		const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
		return { handle, emit, settle, render, sent, put, events };
	}

	const withImages = (): SubscriptionReportValue<"post"> => ({ ...post(1), images: [PNG] });
	const withVideo = (): SubscriptionReportValue<"post"> => ({
		...post(2),
		video: { title: "一期视频" },
	});

	it("blockImages:带配图的作品被挡 —— 不出卡、不推、一张图都没写进图库", async () => {
		const t = bind({ blockImages: true });
		t.emit(withImages());
		await t.settle();
		expect(t.render).not.toHaveBeenCalled();
		expect(t.sent).toEqual([]);
		expect(t.put).not.toHaveBeenCalled();
		t.handle.dispose();
	});

	it("blockVideos:带视频的作品被挡(抖音号开着「屏蔽视频」就是这个效果,主人拍板)", async () => {
		const t = bind({ blockVideos: true });
		t.emit(withVideo());
		await t.settle();
		expect(t.render).not.toHaveBeenCalled();
		expect(t.sent).toEqual([]);
		t.handle.dispose();
	});

	it("没带图 / 没带视频的作品不受对应开关牵连", async () => {
		const t = bind({ blockImages: true, blockVideos: true });
		t.emit(post(3));
		await vi.waitFor(() => expect(t.sent).toHaveLength(1));
		t.handle.dispose();
	});

	it("blockReposts / blockArticles 对拓展作品没有可挡的(上报里没有转发与文章),开着照推", async () => {
		const t = bind({ blockReposts: true, blockArticles: true });
		t.emit(withImages());
		t.emit(withVideo());
		await vi.waitFor(() => expect(t.sent).toHaveLength(2));
		t.handle.dispose();
	});

	it("开关都关着:带图的作品照推,图在出卡前写进图库(先 put、后出卡)", async () => {
		const t = bind({});
		t.emit(withImages());
		await vi.waitFor(() => expect(t.sent).toHaveLength(1));
		expect(t.events).toEqual(["put", "card"]);
		expect(t.put).toHaveBeenCalledTimes(1);
		t.handle.dispose();
	});

	it("关了出图:作品照推,但图一张都不往图库写(写盘跟着出卡走)", async () => {
		const t = bind({}, { imageEnabled: false });
		t.emit(withImages());
		await vi.waitFor(() => expect(t.sent).toHaveLength(1));
		expect(t.render).not.toHaveBeenCalled();
		expect(t.put).not.toHaveBeenCalled();
		t.handle.dispose();
	});

	it("关键词 / 白名单看的是 postText:视频标题里的字也算(取段只此一份,从前拓展自己拼的那份同样取得到)", async () => {
		const blocked = bind({ blockKeywords: ["一期"] });
		blocked.emit(withVideo());
		await blocked.settle();
		expect(blocked.sent).toEqual([]);
		blocked.handle.dispose();

		const allowed = bind({ allowKeywords: ["一期"] });
		allowed.emit(withVideo());
		await vi.waitFor(() => expect(allowed.sent).toHaveLength(1));
		allowed.handle.dispose();
	});

	it("屏蔽提醒(notify 开着):类型开关挡下的作品也提醒,措辞中立、叫法用平台的", async () => {
		const t = bind({ blockVideos: true, notify: true });
		t.emit(withVideo());
		await vi.waitFor(() => expect(t.sent).toHaveLength(1));
		expect(t.sent[0]).toEqual([{ kind: "text", text: "资料名发布了一条带视频的作品，已屏蔽" }]);
		expect(t.render).not.toHaveBeenCalled();
		t.handle.dispose();
	});
});
