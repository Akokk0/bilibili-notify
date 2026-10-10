/**
 * 统计只听 `post-detected`(ADR-0028):B 站与拓展两支的作品行都由这一个中立的监听记。
 *
 * 走真总线(`createNodeMessageBus`)+ `createStatsRecorder`:监听的登记剪掉就红(接线用例)。
 * 两种形状各喂一条 —— 只喂一种的话,另一支没接上也绿:
 *   - B 站形状:`identity.sourceKey = "bilibili"`、带视频的作品、`postNoun = "动态"`;
 *   - 拓展形状:`identity.sourceKey = "ext"`、纯文字作品、`postNoun` 取清单值。
 */

import type { MessageBus, Post, PostEvent } from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { FollowersStore } from "../../followers/store.js";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import { createStatsRecorder } from "../recorder.js";
import type { StatsStore } from "../store.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function makeStore() {
	return {
		appendPost: vi.fn(async () => {}),
		listPosts: vi.fn(async () => []),
		listRecentPosts: vi.fn(async () => []),
		openLiveSession: vi.fn(async () => {}),
		closeLiveSession: vi.fn(async () => {}),
		listLiveSessions: vi.fn(async () => []),
		appendRecording: vi.fn(async () => {}),
		listRecording: vi.fn(async () => []),
		recordingKeys: vi.fn(async () => []),
		keys: vi.fn(async () => []),
		compactRecording: vi.fn(async () => ({
			rowsBefore: 0,
			rowsAfter: 0,
			badLines: 0,
			rewritten: false,
		})),
		drop: vi.fn(async () => {}),
	} satisfies Record<keyof StatsStore, unknown> as unknown as StatsStore & {
		appendPost: ReturnType<typeof vi.fn>;
	};
}

function makeFans() {
	return {
		append: vi.fn(async () => {}),
		findNearestBefore: vi.fn(async () => undefined),
		findEarliest: vi.fn(async () => undefined),
		listSamplesSince: vi.fn(async () => []),
		drop: vi.fn(async () => {}),
		keys: vi.fn(async () => []),
		clear: vi.fn(async () => {}),
		compact: vi.fn(async () => ({ rowsBefore: 0, rowsAfter: 0, badLines: 0, rewritten: false })),
		close: vi.fn(async () => {}),
	} satisfies Record<keyof FollowersStore, unknown> as unknown as FollowersStore;
}

function setup(enabled = true) {
	const bus: MessageBus = createNodeMessageBus();
	const store = makeStore();
	const handle = createStatsRecorder({
		bus,
		store,
		fans: makeFans(),
		fansCron: () => "*/10 * * * *",
		logger,
		isEnabled: () => enabled,
		// 订阅清单只给 B 站的 tick 与拓展的上报用;作品行不看它(判据在核心入口)。
		subscriptions: () => [],
	});
	return { bus, store, handle };
}

const post = (over: Partial<Post> = {}): Post => ({
	creator: { name: "某人" },
	publishedAt: "2026-05-16T09:00:00.000Z",
	text: "",
	...over,
});

/** B 站形状:订阅 id 与 uid 故意不同,键用错一眼就红。 */
const biliEvent: PostEvent = {
	subscriptionId: "sub-bili",
	identity: { sourceKey: "bilibili", externalId: "1001" },
	postId: "dyn-1",
	url: "https://www.bilibili.com/video/BV1xx",
	postNoun: "动态",
	post: post({
		text: "新视频来了",
		topic: "日常",
		video: { cover: {}, title: "一支视频", description: "简介", durationSec: 125 },
	}),
};

/** 拓展形状:纯文字,没有视频,发布时间与 B 站那条不同。 */
const extEvent: PostEvent = {
	subscriptionId: "sub-ext",
	identity: { sourceKey: "ext-douyin", externalId: "u-9" },
	postId: "ext-post-1",
	url: "https://example.com/p/1",
	postNoun: "作品",
	post: post({ text: "只有一句话", publishedAt: "2026-05-16T08:00:00.000Z" }),
};

beforeEach(() => vi.clearAllMocks());

describe("统计只听 post-detected", () => {
	it("B 站形状:落一行,键是订阅 id,有视频,发布时间取 post.publishedAt,多收五格", async () => {
		const { bus, store, handle } = setup();
		bus.emit("post-detected", biliEvent);
		await handle.flush();
		expect(store.appendPost).toHaveBeenCalledTimes(1);
		expect(store.appendPost).toHaveBeenCalledWith("sub-bili", {
			id: "dyn-1",
			hasVideo: true,
			publishedAt: "2026-05-16T09:00:00.000Z",
			url: "https://www.bilibili.com/video/BV1xx",
			title: "一支视频",
			summary: "新视频来了\n视频标题：一支视频",
			topic: "日常",
			videoDurationSec: 125,
		});
	});

	it("拓展形状:落一行,键是订阅 id,没有视频,发布时间取 post.publishedAt,多收的格只有有的", async () => {
		const { bus, store, handle } = setup();
		bus.emit("post-detected", extEvent);
		await handle.flush();
		expect(store.appendPost).toHaveBeenCalledTimes(1);
		expect(store.appendPost).toHaveBeenCalledWith("sub-ext", {
			id: "ext-post-1",
			hasVideo: false,
			publishedAt: "2026-05-16T08:00:00.000Z",
			url: "https://example.com/p/1",
			summary: "只有一句话",
		});
	});

	it("B 站直播类动态(记成不带视频的作品):同样落一行", async () => {
		const { bus, store, handle } = setup();
		bus.emit("post-detected", {
			...biliEvent,
			postId: "dyn-live",
			post: post({ text: "直播预约" }),
		});
		await handle.flush();
		expect(store.appendPost).toHaveBeenCalledWith(
			"sub-bili",
			expect.objectContaining({ id: "dyn-live", hasVideo: false }),
		);
	});

	it("总开关关着不落作品行", async () => {
		const { bus, store, handle } = setup(false);
		bus.emit("post-detected", biliEvent);
		bus.emit("post-detected", extEvent);
		await handle.flush();
		expect(store.appendPost).not.toHaveBeenCalled();
	});

	it("dispose 之后不再记", async () => {
		const { bus, store, handle } = setup();
		handle.dispose();
		bus.emit("post-detected", biliEvent);
		await handle.flush();
		expect(store.appendPost).not.toHaveBeenCalled();
	});

	it("同一条作品的事件重放:都交给仓,由仓按 id 去重(重启后的重放靠它)", async () => {
		const { bus, store, handle } = setup();
		bus.emit("post-detected", biliEvent);
		bus.emit("post-detected", biliEvent);
		await handle.flush();
		expect(store.appendPost).toHaveBeenCalledTimes(2);
	});
});
