/**
 * 拓展作品的绑定(`bindExtensionPosts`,ADR-0019 决策 62 / 67):听 `subscription-reported` 里的 `post`,
 * 逐条订阅**翻成中立的 `PostEvent`(图已写进图库)后交给核心入口** —— 它只负责生产,过滤、出卡、点评、推送是核心的事。
 *
 * 两层用例:
 *
 * - 「绑定」:`enqueue` 是个记录用的假口,只验「翻译 → 入队」(信封里每一格、写图在入队之前、同一道闸排次序、
 *   翻译抛错只记日志);
 * - 「整条链」:绑定 → **真的 `PostQueue` → 真的 `deliverPost`**,只假渲染器 / AI / 推送 / 留痕,断言到推送口的入参。
 *   那几条「被挡 / 关了出图」的用例也钉着决策 3:**图提前写进图库**(被过滤的、关了出图的作品也写),与从前「写盘跟着出卡走」相反。
 *
 * 凡断言「没推」的,都先等登记进 `track` 的活全部落定,旁边有对照(同样的铺垫,条件反过来就推了)。
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageRenderer } from "@bilibili-notify/image";
import {
	checkSubscriptionReport,
	DEFAULT_CONTENT_FILTERS,
	defaultMessageKindLayout,
	type ImageRef,
	type PostEvent,
	type Result,
	SUBSCRIPTION_REPORT_TEXT_MAX,
	type SubscriptionReportValue,
} from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import { png } from "../../__tests__/support/report-images.js";
import {
	deferred,
	makeTrackingContext,
	stillPending,
} from "../../__tests__/support/track-context.js";
import { createImageStore, imageRefOf } from "../../images/image-store.js";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import {
	createCardFailureTracker,
	type DeliverPostDeps,
	type PostSettings,
} from "../deliver-post.js";
import { bindExtensionPosts } from "../extension-post.js";
import type { PostPushAnchor, PushSegment } from "../post-push.js";
import { createPostQueue } from "../post-queue.js";

const SUB = makeExtensionSubscription({ externalId: "sec-uid-1" });
const OTHER = makeExtensionSubscription({
	id: "e0000000-0000-4000-8000-000000000002",
	externalId: "sec-uid-2",
});
const silent = { debug() {}, info() {}, warn() {}, error() {} };

/** 图库的口:回图库起的那个名字(内容哈希)。 */
const storingPut = async (bytes: Uint8Array) => {
	const ref = imageRefOf(bytes);
	if (!ref) return { ok: false as const, code: "invalid" as const, message: "不是图" };
	return { ok: true as const, ref };
};

function post(n: number): SubscriptionReportValue<"post"> {
	return {
		id: `p${n}`,
		url: `https://www.douyin.com/video/p${n}`,
		publishedAt: Date.UTC(2026, 8, 24, 12, n),
		text: `第 ${n} 条`,
	};
}

function settingsOf(over: Partial<PostSettings> = {}): PostSettings {
	return {
		filter: DEFAULT_CONTENT_FILTERS,
		messageLayout: defaultMessageKindLayout("post"),
		cardEnabled: true,
		aiEnabled: true,
		aiWebSearch: false,
		template: "{name}发布了一条动态",
		videoTemplate: "{name}发布了新视频",
		imageGroup: { enabled: false, mergeForward: false },
		...over,
	};
}

type Put = (bytes: Uint8Array) => Promise<Result<{ ref: ImageRef }>>;

function setup(
	over: {
		put?: Put;
		subscriptions?: Record<string, typeof SUB>;
		profileName?: (id: string) => string | undefined;
		postNoun?: (extensionId: string) => string | undefined;
	} = {},
) {
	const bus = createNodeMessageBus();
	const ctx = makeTrackingContext();
	const errors: string[] = [];
	const warns: string[] = [];
	const logger = {
		...silent,
		error: (msg: string) => errors.push(msg),
		warn: (msg: string) => warns.push(msg),
	};
	const put = vi.fn(over.put ?? storingPut);
	const enqueued: PostEvent[] = [];
	const subs = over.subscriptions ?? { [SUB.id]: SUB };
	const handle = bindExtensionPosts({
		bus,
		logger,
		serviceCtx: ctx,
		subscription: (id) => subs[id],
		profileName: over.profileName ?? (() => "资料名"),
		postNoun: over.postNoun ?? (() => "作品"),
		postImages: { put },
		enqueue: (event) => {
			enqueued.push(event);
		},
	});
	const emit = (
		value: SubscriptionReportValue<"post">,
		subscriptionIds: string[] = [SUB.id],
		kind: "post" | "liveStart" = "post",
	) =>
		bus.emit("subscription-reported", {
			extensionId: SUB.identity.sourceKey,
			externalId: SUB.identity.externalId,
			subscriptionIds,
			report: (kind === "post"
				? { kind: "post", value }
				: { kind: "liveStart", value: { title: "开播了" } }) as never,
		});
	return { bus, ctx, handle, put, enqueued, errors, warns, emit };
}

/** 登记的活全部落定(包括落定途中又登记的)。 */
async function settleAll(ctx: ReturnType<typeof makeTrackingContext>): Promise<void> {
	let seen: number;
	do {
		seen = ctx.tracked.length;
		await ctx.settled();
	} while (ctx.tracked.length !== seen);
}

describe("bindExtensionPosts — 上报翻成信封交给核心入口", () => {
	it("信封:订阅 id、订阅身份、作品 id、地址、平台叫法、翻好的作品(作者名按名字链取)", async () => {
		const t = setup();
		t.emit({ ...post(1), text: "正文", author: { name: "事件里的名字" } });
		await settleAll(t.ctx);
		expect(t.enqueued).toHaveLength(1);
		expect(t.enqueued[0]).toMatchObject({
			subscriptionId: SUB.id,
			identity: { sourceKey: "douyin", externalId: "sec-uid-1" },
			postId: "p1",
			url: "https://www.douyin.com/video/p1",
			postNoun: "作品",
			post: { creator: { name: "事件里的名字" }, text: "正文" },
		});
		t.handle.dispose();
	});

	it("作者名:事件里的 → 订阅资料里的 → 外部 id", async () => {
		const withProfile = setup({ profileName: () => "资料名" });
		withProfile.emit(post(1));
		await settleAll(withProfile.ctx);
		expect(withProfile.enqueued[0]?.post.creator.name).toBe("资料名");

		const bare = setup({ profileName: () => undefined });
		bare.emit(post(1));
		await settleAll(bare.ctx);
		expect(bare.enqueued[0]?.post.creator.name).toBe("sec-uid-1");
	});

	it("平台叫法按这条订阅所属的拓展取,只问它;清单没写就不带", async () => {
		const asked: string[] = [];
		const t = setup({
			postNoun: (extensionId) => {
				asked.push(extensionId);
				return extensionId === "douyin" ? "视频" : undefined;
			},
		});
		t.emit(post(1));
		await settleAll(t.ctx);
		expect(asked).toEqual(["douyin"]);
		expect(t.enqueued[0]?.postNoun).toBe("视频");

		const none = setup({ postNoun: () => undefined });
		none.emit(post(1));
		await settleAll(none.ctx);
		expect(none.enqueued[0]?.postNoun).toBeUndefined();
	});

	it("图在入队之前就写进图库:交出去的作品里是图库引用(决策 3:交给核心之前图已经写进图库)", async () => {
		const order: string[] = [];
		const t = setup({
			put: async (bytes) => {
				order.push("put");
				return storingPut(bytes);
			},
		});
		const bytes = png(10, 10);
		const cover = png(12, 12, 1);
		const avatar = png(8, 8, 2);
		const original = t.enqueued.push.bind(t.enqueued);
		t.enqueued.push = (...events: PostEvent[]) => {
			order.push("enqueue");
			return original(...events);
		};
		t.emit({ ...post(1), images: [bytes], video: { cover }, author: { avatar } });
		await settleAll(t.ctx);
		expect(order.slice(-1)).toEqual(["enqueue"]);
		expect(order.filter((o) => o === "put")).toHaveLength(3);
		const event = t.enqueued[0] as PostEvent;
		expect(event.post.images?.[0]?.ref).toBe(imageRefOf(bytes));
		expect(event.post.video?.cover.ref).toBe(imageRefOf(cover));
		expect(event.post.creator.avatar).toBe(imageRefOf(avatar));
		t.handle.dispose();
	});

	it("图存不进图库(磁盘写失败回 unavailable):那张图缺着、记一条 warn,整条作品照样入队;对照:存得进就有 ref", async () => {
		const bytes = png(10, 10);
		const broken = setup({
			put: async () => ({ ok: false as const, code: "unavailable" as const, message: "盘满了" }),
		});
		broken.emit({ ...post(1), images: [bytes] });
		await settleAll(broken.ctx);
		expect(broken.enqueued).toHaveLength(1);
		const image = broken.enqueued[0]?.post.images?.[0];
		expect(image?.ref).toBeUndefined();
		expect(image?.width).toBe(10); // 宽高是字节自己的事,照样带
		expect(broken.warns.some((m) => m.includes("盘满了"))).toBe(true);
		expect(broken.errors).toEqual([]);

		const fine = setup();
		fine.emit({ ...post(1), images: [bytes] });
		await settleAll(fine.ctx);
		expect(fine.enqueued[0]?.post.images?.[0]?.ref).toBe(imageRefOf(bytes));
	});

	it("真图库写盘失败(图库目录是个普通文件,写必挂):同样是那张图缺着、作品照入队", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bn-ext-post-"));
		try {
			const blocked = join(dir, "挡路");
			await writeFile(blocked, "x");
			const real = createImageStore({ dir: blocked }).register({
				name: "作品配图",
				listRefs: async () => [],
			});
			const t = setup({ put: (bytes) => real.put(bytes) });
			t.emit({ ...post(1), images: [png(10, 10)] });
			await settleAll(t.ctx);
			expect(t.enqueued).toHaveLength(1);
			expect(t.enqueued[0]?.post.images?.[0]?.ref).toBeUndefined();
			expect(t.warns.some((m) => /ENOTDIR/.test(m))).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("事件没带头像 → 信封里的作品没有头像(外层头像由核心出卡时按订阅资料补,不在这里)", async () => {
		const t = setup();
		t.emit(post(1));
		await settleAll(t.ctx);
		expect(t.enqueued[0]?.post.creator.avatar).toBeUndefined();
		t.handle.dispose();
	});

	it("一条上报对着几条订阅:每条订阅各一份信封,各按自己的订阅取名", async () => {
		const t = setup({
			subscriptions: { [SUB.id]: SUB, [OTHER.id]: OTHER },
			profileName: (id) => (id === SUB.id ? "甲" : "乙"),
		});
		t.emit(post(1), [SUB.id, OTHER.id]);
		await settleAll(t.ctx);
		expect(t.enqueued.map((e) => [e.subscriptionId, e.post.creator.name])).toEqual([
			[SUB.id, "甲"],
			[OTHER.id, "乙"],
		]);
		t.handle.dispose();
	});

	it("查不到的订阅(刚删)跳过,别的订阅照入;对照:查得到就入", async () => {
		const t = setup({ subscriptions: { [OTHER.id]: OTHER } });
		t.emit(post(1), [SUB.id, OTHER.id]);
		await settleAll(t.ctx);
		expect(t.enqueued.map((e) => e.subscriptionId)).toEqual([OTHER.id]);
		t.handle.dispose();
	});

	it("不是作品的上报(开播之类)不管;对照:作品的上报会入队", async () => {
		const t = setup();
		t.emit(post(1), [SUB.id], "liveStart");
		await settleAll(t.ctx);
		expect(t.enqueued).toEqual([]);
		expect(t.ctx.tracked).toHaveLength(0);
		t.emit(post(1));
		await settleAll(t.ctx);
		expect(t.enqueued).toHaveLength(1);
		t.handle.dispose();
	});
});

describe("bindExtensionPosts — 同一道闸排次序、登记进 track、翻译抛错", () => {
	it("第一条写图慢、第二条紧跟着到:入队仍是先一后二", async () => {
		const hold = deferred();
		let first = true;
		const t = setup({
			put: async (bytes) => {
				if (first) {
					first = false;
					await hold.promise;
				}
				return storingPut(bytes);
			},
		});
		t.emit({ ...post(1), images: [png(10, 10, 1)] });
		t.emit(post(2));
		await vi.waitFor(() => expect(t.put).toHaveBeenCalledTimes(1));
		await new Promise((r) => setTimeout(r, 20));
		expect(t.enqueued).toEqual([]); // 第二条得在闸后面等着,不能抢在第一条前面
		hold.resolve();
		await settleAll(t.ctx);
		expect(t.enqueued.map((e) => e.postId)).toEqual(["p1", "p2"]);
		t.handle.dispose();
	});

	it("翻译(写图)落定之前,登记进 track 的活不落定", async () => {
		const hold = deferred();
		const t = setup({
			put: async (bytes) => {
				await hold.promise;
				return storingPut(bytes);
			},
		});
		t.emit({ ...post(1), images: [png(10, 10)] });
		expect(t.ctx.tracked).toHaveLength(1);
		expect(await stillPending(t.ctx.settled())).toBe(true);
		hold.resolve();
		await settleAll(t.ctx);
		expect(t.enqueued).toHaveLength(1);
		t.handle.dispose();
	});

	it("翻译途中抛错(图库写盘失败):只记 error、不入队、不重试、登记的活不拒;后面的照入", async () => {
		let calls = 0;
		const t = setup({
			put: async (bytes) => {
				calls++;
				if (calls === 1) throw new Error("磁盘满了");
				return storingPut(bytes);
			},
		});
		t.emit({ ...post(1), images: [png(10, 10)] });
		t.emit({ ...post(2), images: [png(11, 11)] });
		const settled = (await t.ctx.settled()) as PromiseSettledResult<unknown>[];
		await settleAll(t.ctx);
		expect(settled.every((r) => r.status === "fulfilled")).toBe(true);
		expect(calls).toBe(2);
		expect(t.enqueued.map((e) => e.postId)).toEqual(["p2"]);
		expect(t.errors.some((m) => m.includes("磁盘满了") && m.includes(SUB.id))).toBe(true);
		t.handle.dispose();
	});

	it("dispose 之后:不再听上报;在途的翻译落定也不入队", async () => {
		const hold = deferred();
		const t = setup({
			put: async (bytes) => {
				await hold.promise;
				return storingPut(bytes);
			},
		});
		t.emit({ ...post(1), images: [png(10, 10)] });
		await vi.waitFor(() => expect(t.put).toHaveBeenCalledTimes(1));
		t.handle.dispose();
		hold.resolve();
		await settleAll(t.ctx);
		expect(t.enqueued).toEqual([]);
		t.emit(post(2));
		await settleAll(t.ctx);
		expect(t.enqueued).toEqual([]);
		expect(t.ctx.tracked).toHaveLength(1);
	});
});

/**
 * 整条链:绑定 → 真的 `PostQueue` → 真的 `deliverPost`。
 */
function chain(
	over: {
		filter?: Partial<typeof DEFAULT_CONTENT_FILTERS>;
		cardEnabled?: boolean;
		/** 回 undefined = 这条订阅此刻不该推(停用 / 拓展没在跑)。 */
		active?: () => boolean;
		renderGate?: Promise<void>;
		withAi?: boolean;
		postNoun?: string;
	} = {},
) {
	const bus = createNodeMessageBus();
	const ctx = makeTrackingContext();
	const errors: string[] = [];
	const logger = { ...silent, error: (msg: string) => errors.push(msg) };
	const events: string[] = [];
	const put = vi.fn(async (bytes: Uint8Array) => {
		events.push("put");
		return storingPut(bytes);
	});
	let renders = 0;
	const generatePostCard = vi.fn(async (..._args: unknown[]) => {
		events.push("card");
		if (over.renderGate && renders++ === 0) await over.renderGate;
		return Buffer.from("card");
	});
	const comment = vi.fn(async (..._args: unknown[]) => "点评");
	const sent: PushSegment[][] = [];
	const recordFiltered = vi.fn();
	const settings = settingsOf({
		filter: { ...DEFAULT_CONTENT_FILTERS, ...over.filter },
		cardEnabled: over.cardEnabled ?? true,
	});
	const deps: DeliverPostDeps = {
		logger,
		settings: () => (over.active && !over.active() ? undefined : settings),
		image: () => ({ generatePostCard }) as unknown as ImageRenderer,
		ai: () => (over.withAi ? ({ comment } as never) : undefined),
		cardFailures: createCardFailureTracker(),
		avatar: () => undefined,
		readImage: async () => undefined,
		push: async (_id: string, anchors: PostPushAnchor[]) => {
			const messages = (await anchors.find((a) => a.role === "main")?.messages) ?? [];
			for (const segments of messages) sent.push(segments);
		},
		recordFiltered,
		sendErrorMsg: async () => {},
		emitEngineError: () => {},
	};
	const queue = createPostQueue({ logger, bus, serviceCtx: ctx, deps });
	const handle = bindExtensionPosts({
		bus,
		logger,
		serviceCtx: ctx,
		subscription: (id) => (id === SUB.id ? SUB : undefined),
		profileName: () => "资料名",
		postNoun: () => over.postNoun ?? "作品",
		postImages: { put },
		enqueue: (event) => queue.enqueue(event),
	});
	const emit = (value: SubscriptionReportValue<"post">) =>
		bus.emit("subscription-reported", {
			extensionId: SUB.identity.sourceKey,
			externalId: SUB.identity.externalId,
			subscriptionIds: [SUB.id],
			report: { kind: "post", value },
		});
	const dispose = () => {
		handle.dispose();
		queue.dispose();
	};
	return {
		ctx,
		emit,
		put,
		generatePostCard,
		comment,
		sent,
		events,
		recordFiltered,
		errors,
		dispose,
	};
}

const PNG = png(10, 10);
const withImages = (): SubscriptionReportValue<"post"> => ({ ...post(1), images: [PNG] });
const withVideo = (): SubscriptionReportValue<"post"> => ({
	...post(2),
	video: { title: "一期视频" },
});

describe("整条链 — 同一条订阅的作品按到达顺序发", () => {
	it("第一条出卡慢、第二条紧跟着到:发出去仍是先一后二", async () => {
		const hold = deferred();
		const t = chain({ renderGate: hold.promise });
		t.emit(post(1));
		t.emit(post(2));
		// 第一条已经在出卡、卡住了;第二条得在闸后面等着 —— 它这会儿既不该出卡,更不该发出去。
		await vi.waitFor(() => expect(t.generatePostCard).toHaveBeenCalledTimes(1));
		await new Promise((r) => setTimeout(r, 20));
		expect(t.sent).toEqual([]);
		expect(t.generatePostCard).toHaveBeenCalledTimes(1);

		hold.resolve();
		await settleAll(t.ctx);
		const links = t.sent.map((segs) => {
			const text = segs.find((s) => s.kind === "text");
			return text?.kind === "text" ? (text.text.split("\n").pop() ?? "") : "";
		});
		expect(links).toEqual([post(1).url, post(2).url]);
		t.dispose();
	});
});

/**
 * 正文超过上限的作品(ADR-0019 决策 59 的 09-24 🔗):收下时截到上限,**屏蔽看的是截下来的那一段**。从前
 * 超长的正文整格丢掉,屏蔽看到的是空串 —— 前一万字里写着屏蔽词的长文照推。
 * 走的是宿主收下作品的那一道(`checkSubscriptionReport`)→ bus → 绑定 → 核心入口 → 过滤。
 */
describe("整条链 — 超长正文截断后照样过屏蔽", () => {
	const longText = `今天去海边${"浪".repeat(SUBSCRIPTION_REPORT_TEXT_MAX)}`;
	const emitChecked = (t: ReturnType<typeof chain>, text: string) => {
		const checked = checkSubscriptionReport("post", { ...post(1), text });
		if (!checked.ok) throw new Error(checked.reason);
		t.emit(checked.value);
	};

	it("前一万字里有屏蔽词、整段超长:挡下,不出卡不推;对照:没有屏蔽词就推", async () => {
		const blocked = chain({ filter: { blockKeywords: ["海边"] } });
		emitChecked(blocked, longText);
		await settleAll(blocked.ctx);
		expect(blocked.generatePostCard).not.toHaveBeenCalled();
		expect(blocked.sent).toEqual([]);
		expect(blocked.recordFiltered).toHaveBeenCalledTimes(1);
		blocked.dispose();

		const clean = chain({ filter: { blockKeywords: ["山里"] } });
		emitChecked(clean, longText);
		await settleAll(clean.ctx);
		expect(clean.sent).toHaveLength(1);
		clean.dispose();
	});
});

describe("整条链 — 过滤吃翻好的 Post,类型开关对拓展作品生效", () => {
	it("blockImages:带配图的作品被挡 —— 不出卡、不推;图已经写进图库(决策 3,与从前写盘跟着出卡相反)", async () => {
		const t = chain({ filter: { blockImages: true } });
		t.emit(withImages());
		await settleAll(t.ctx);
		expect(t.generatePostCard).not.toHaveBeenCalled();
		expect(t.sent).toEqual([]);
		expect(t.put).toHaveBeenCalledTimes(1);
		t.dispose();
	});

	it("blockVideos:带视频的作品被挡(抖音号开着「屏蔽视频」就是这个效果,主人拍板);对照:没带视频的照推", async () => {
		const t = chain({ filter: { blockVideos: true } });
		t.emit(withVideo());
		await settleAll(t.ctx);
		expect(t.generatePostCard).not.toHaveBeenCalled();
		expect(t.sent).toEqual([]);
		t.emit(post(3));
		await settleAll(t.ctx);
		expect(t.sent).toHaveLength(1);
		t.dispose();
	});

	it("没带图 / 没带视频的作品不受对应开关牵连", async () => {
		const t = chain({ filter: { blockImages: true, blockVideos: true } });
		t.emit(post(3));
		await settleAll(t.ctx);
		expect(t.sent).toHaveLength(1);
		t.dispose();
	});

	it("blockReposts / blockArticles 对拓展作品没有可挡的(上报里没有转发与文章),开着照推", async () => {
		const t = chain({ filter: { blockReposts: true, blockArticles: true } });
		t.emit(withImages());
		t.emit(withVideo());
		await settleAll(t.ctx);
		expect(t.sent).toHaveLength(2);
		t.dispose();
	});

	it("开关都关着:带图的作品照推,图先写进图库、后出卡", async () => {
		const t = chain();
		t.emit(withImages());
		await settleAll(t.ctx);
		expect(t.sent).toHaveLength(1);
		expect(t.events).toEqual(["put", "card"]);
		expect(t.put).toHaveBeenCalledTimes(1);
		t.dispose();
	});

	it("关了出图:作品照推、不出卡;图照样写进图库(决策 3:写图在交给核心之前,不跟着出卡走)", async () => {
		const t = chain({ cardEnabled: false });
		t.emit(withImages());
		await settleAll(t.ctx);
		expect(t.sent).toHaveLength(1);
		expect(t.generatePostCard).not.toHaveBeenCalled();
		expect(t.put).toHaveBeenCalledTimes(1);
		t.dispose();
	});

	it("关键词 / 白名单看的是 postText:视频标题里的字也算", async () => {
		const blocked = chain({ filter: { blockKeywords: ["一期"] } });
		blocked.emit(withVideo());
		await settleAll(blocked.ctx);
		expect(blocked.sent).toEqual([]);
		blocked.dispose();

		const allowed = chain({ filter: { allowKeywords: ["一期"] } });
		allowed.emit(withVideo());
		await settleAll(allowed.ctx);
		expect(allowed.sent).toHaveLength(1);
		allowed.dispose();
	});

	it("被挡的作品交给留痕:订阅 id、原因、文字、地址;不出卡、什么都不往外发", async () => {
		const t = chain({ filter: { blockVideos: true } });
		t.emit(withVideo());
		await settleAll(t.ctx);
		expect(t.recordFiltered).toHaveBeenCalledTimes(1);
		expect(t.recordFiltered).toHaveBeenCalledWith({
			subscriptionId: SUB.id,
			filteredBy: "blocked-videos",
			text: "第 2 条\n一期视频",
			url: "https://www.douyin.com/video/p2",
		});
		expect(t.generatePostCard).not.toHaveBeenCalled();
		expect(t.sent).toEqual([]);
		t.dispose();
	});

	it.each([
		["blocked-keyword", { blockKeywords: ["第 1 条"] }],
		["blocked-images", { blockImages: true }],
		["allowlist-unmatched", { allowKeywords: ["上新"] }],
	] as const)("原因 %s 原样带出去", async (filteredBy, filter) => {
		const t = chain({ filter: filter as Partial<typeof DEFAULT_CONTENT_FILTERS> });
		t.emit(withImages());
		await settleAll(t.ctx);
		expect(t.recordFiltered).toHaveBeenCalledTimes(1);
		expect(t.recordFiltered.mock.calls[0]?.[0]).toMatchObject({ filteredBy });
		t.dispose();
	});

	it("没被挡的作品不留痕", async () => {
		const t = chain({ filter: { blockVideos: true } });
		t.emit(post(3));
		await settleAll(t.ctx);
		expect(t.sent).toHaveLength(1);
		expect(t.recordFiltered).not.toHaveBeenCalled();
		t.dispose();
	});
});

describe("整条链 — 平台叫法与订阅状态", () => {
	it("清单里的叫法进 AI 提示词:「发布了一条视频」", async () => {
		const t = chain({ withAi: true, postNoun: "视频" });
		t.emit({ ...post(1), text: "今天去海边" });
		await settleAll(t.ctx);
		expect(t.comment).toHaveBeenCalledTimes(1);
		expect(t.comment.mock.calls[0]?.[0]).toBe("资料名发布了一条视频，内容如下：\n今天去海边");
		t.dispose();
	});

	it("订阅此刻不该推(停用 / 拓展没在跑):出卡与推送都不做;对照:该推就推", async () => {
		let active = false;
		const t = chain({ active: () => active });
		t.emit(post(1));
		await settleAll(t.ctx);
		expect(t.generatePostCard).not.toHaveBeenCalled();
		expect(t.sent).toEqual([]);
		active = true;
		t.emit(post(2));
		await settleAll(t.ctx);
		expect(t.sent).toHaveLength(1);
		t.dispose();
	});

	it("出卡途中订阅被停用:不发(回问);已经出过卡", async () => {
		let active = true;
		const hold = deferred();
		const t = chain({ active: () => active, renderGate: hold.promise });
		t.emit(post(1));
		await vi.waitFor(() => expect(t.generatePostCard).toHaveBeenCalledTimes(1));
		active = false;
		hold.resolve();
		await settleAll(t.ctx);
		expect(t.sent).toEqual([]);
		t.dispose();
	});
});
