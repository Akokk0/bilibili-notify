import type {
	ExtensionContext,
	ExtensionSourceContext,
	SourceSubscriptionView,
} from "@bilibili-notify/extension";
import { fail, ok } from "@bilibili-notify/extension";
import { expect, it, vi } from "vite-plus/test";
import { createDouyinSource } from "../source";

const secUid = "MS4wLjABAAAAalice";
const user = {
	sec_uid: secUid,
	unique_id: "alice_42",
	nickname: "小鱼",
	avatar_thumb: { url_list: ["https://images.example/u.jpg"] },
};
const signal = new AbortController().signal;

function fixture() {
	const result = (data: unknown): ReturnType<import("../source").DouyinSourceClient["posts"]> =>
		Promise.resolve(ok({ data }));
	let account = new AbortController();
	const switchAccount = () => {
		account.abort();
		account = new AbortController();
	};
	const client = {
		sessionSignal: () => account.signal,
		profile: vi.fn((_id: string, _signal: AbortSignal) => result({ user })),
		account: vi.fn((_name: string, _signal: AbortSignal) => result({ user_info: user })),
		search: vi.fn((_name: string, _signal: AbortSignal) => result({ user_list: [] })),
		posts: vi.fn((_id: string, _cursor: string, _signal: AbortSignal) =>
			result({ aweme_list: [], has_more: 0 }),
		),
		room: vi.fn((_webRid: string, _roomId: string, _signal: AbortSignal) =>
			result({ data: { data: [] } }),
		),
		expand: vi.fn(async (url: URL, _signal: AbortSignal) => ok({ url })),
	};
	let tick: () => void | Promise<void> = () => {};
	let changed: () => void = () => {};
	const setSubs = (views: SourceSubscriptionView[]) => {
		subs = views;
		changed();
	};
	let subs: SourceSubscriptionView[] = [
		{ externalId: secUid, features: new Set(["post"]), monitorsLive: false },
	];
	const context = {
		signal,
		subscriptions: () => subs,
		onSubscriptionsChanged: (fn: () => void) => {
			changed = fn;
			return {
				dispose() {
					changed = () => {};
				},
			};
		},
		onDispose: vi.fn(),
		reportProfile: vi.fn(),
		reportPost: vi.fn(),
		reportLive: vi.fn(),
		reportProblem: vi.fn(),
		resolveProblem: vi.fn(),
	};
	const host = {
		setInterval(fn: () => void) {
			tick = fn;
			return {
				dispose() {
					tick = () => {};
				},
			};
		},
		signal,
		i18n: { t: (key: string, values?: { account: string }) => values?.account ?? key },
		fetchImage: vi.fn(async () => ok({ ref: "image:avatar" })),
	};
	const source = createDouyinSource(host as unknown as ExtensionContext, client);
	return {
		source,
		switchAccount,
		host,
		client,
		result,
		context,
		setSubs,
		tick: () => tick(),
		start: async () => {
			await source.start(context as unknown as ExtensionSourceContext);
			await tick();
		},
	};
}

it("resolves an account and a shared homepage to the same verified author", async () => {
	const { source, client } = fixture();
	const byAccount = await source.searchCreators("alice_42", signal);
	const byPage = await source.searchCreators(
		`抖音主页 https://www.douyin.com/user/${secUid}`,
		signal,
	);
	expect(byAccount).toMatchObject({
		ok: true,
		candidates: [{ externalId: secUid, name: "小鱼", avatar: "image:avatar" }],
	});
	expect(byPage).toEqual(byAccount);
	expect(client.profile).toHaveBeenCalledWith(secUid, expect.any(AbortSignal));
});

it("checks short-link destinations and limits distinct, distinguishable nickname candidates", async () => {
	const { source, client, result } = fixture();
	client.expand.mockResolvedValue(
		ok({ url: new URL(`https://www.douyin.com.evil.example/user/${secUid}`) }),
	);
	expect(await source.searchCreators("1.23 分享 https://v.douyin.com/abc/", signal)).toMatchObject({
		ok: false,
		code: "invalid",
	});
	expect(client.expand).toHaveBeenCalledTimes(1);
	expect(client.profile).not.toHaveBeenCalled();
	const second = { ...user, sec_uid: "second", unique_id: "fish_b" };
	const rows = [
		user,
		user,
		second,
		...Array.from({ length: 10 }, (_, i) => ({ ...user, sec_uid: `other${i}` })),
	];
	client.search.mockImplementation(() =>
		result({ user_list: rows.map((user_info) => ({ user_info })) }),
	);
	const found = await source.searchCreators("小鱼", signal);
	expect(found.ok && found.candidates).toHaveLength(10);
	expect(found.ok && found.candidates.slice(0, 2)).toMatchObject([
		{ externalId: secUid, displayId: "alice_42" },
		{ externalId: "second", displayId: "fish_b" },
	]);
	expect(found.ok && found.candidates[0]?.bio).toBeUndefined();
	expect(client.account).not.toHaveBeenCalled();
});

it("reports only the verified profile, preserving a missing follower count", async () => {
	const { source, client, result } = fixture();
	const identity = { sourceKey: "douyin", externalId: secUid };
	const profile = await source.fetchProfile(identity, signal);
	expect(profile).toEqual({
		ok: true,
		name: "小鱼",
		displayId: "alice_42",
		avatar: "image:avatar",
	});
	client.profile.mockImplementation(() => result({ user: { ...user, sec_uid: "unexpected" } }));
	expect(await source.fetchProfile(identity, signal)).toMatchObject({ ok: false });
});

const work = (id: string, sec: number, extra: Record<string, unknown> = {}) => ({
	aweme_id: id,
	create_time: sec,
	desc: `作品 ${id}`,
	author: user,
	video: { cover: { url_list: ["https://images.example/cover"] }, duration: 2300 },
	...extra,
});
it("baselines silently, skips old pinned posts and reports complete pages oldest first, once each", async () => {
	const { start, client, tick, context, result } = fixture();
	const old = work("100", 100);
	client.posts.mockImplementationOnce(() => result({ aweme_list: [old], has_more: 0 }));
	await start();
	expect(context.reportPost).not.toHaveBeenCalled();
	const pinned = work("50", 50, { is_top: 1 });
	const noteText = "📸 百校联赛\n赛点回顾\n#洲同学报到 #三角洲行动";
	const note = work("201", 200, {
		desc: noteText,
		text_extra: [
			{ type: 1, start: 12, end: 18, hashtag_name: "洲同学报到" },
			{ type: 1, start: 19, end: 25, hashtag_name: "三角洲行动" },
		],
		statistics: { digg_count: 1507, comment_count: 974, share_count: 69, collect_count: 201 },
		images: Array.from({ length: 17 }, () => ({ url_list: ["https://images.example/album"] })),
	});
	const latest = work("202", 200);
	const page = { aweme_list: [pinned, latest], has_more: 1, max_cursor: 42 };
	client.posts
		.mockImplementationOnce(() => result(page))
		.mockImplementationOnce(async () => fail("unavailable", "page blocked"));
	await tick();
	expect(context.reportPost).not.toHaveBeenCalled();
	client.posts
		.mockImplementationOnce(() => result(page))
		.mockImplementationOnce(() => result({ aweme_list: [latest, note, old], has_more: 0 }));
	await tick();
	expect(context.reportPost.mock.calls.map((call) => call[1].postId)).toEqual(["201", "202"]);
	expect(context.reportPost.mock.calls[0][1]).toMatchObject({
		url: "https://www.douyin.com/note/201",
		post: {
			publishedAt: "1970-01-01T00:03:20.000Z",
			text: noteText,
			richText: [
				{ kind: "text", text: "📸 百校联赛\n赛点回顾\n" },
				{ kind: "topic", text: "#洲同学报到", name: "洲同学报到" },
				{ kind: "text", text: " " },
				{ kind: "topic", text: "#三角洲行动", name: "三角洲行动" },
			],
			stats: { likes: 1507, comments: 974, shares: 69, saves: 201 },
			images: Array.from({ length: 17 }, () => "image:avatar"),
		},
	});
	expect(context.reportPost.mock.calls[1][1]).toMatchObject({
		url: "https://www.douyin.com/video/202",
		post: { video: { cover: "image:avatar" } },
	});
	client.posts.mockImplementationOnce(() =>
		result({ aweme_list: [latest, note, old], has_more: 0 }),
	);
	await tick();
	expect(context.reportPost).toHaveBeenCalledTimes(2);
});

it("aborts an in-flight author on removal and creates a fresh baseline after resubscription or restart", async () => {
	const { source, start, tick, client, setSubs, context, result } = fixture();
	const sub: SourceSubscriptionView = {
		externalId: secUid,
		features: new Set(["post"]),
		monitorsLive: false,
	};
	await start();
	let release!: (value: Awaited<ReturnType<typeof result>>) => void;
	let observed!: AbortSignal;
	client.posts.mockImplementationOnce((_id, _cursor, signal) => {
		observed = signal;
		return new Promise((done) => {
			release = done;
		});
	});
	const inFlight = tick();
	await vi.waitFor(() => expect(observed).toBeDefined());
	setSubs([]);
	expect(observed.aborted).toBe(true);
	release(await result({ aweme_list: [work("123", 200)], has_more: 0 }));
	await inFlight;
	expect(context.reportPost).not.toHaveBeenCalled();
	client.posts.mockImplementation(() => result({ aweme_list: [work("456", 400)], has_more: 0 }));
	setSubs([sub]);
	await tick();
	await source.stop();
	await start();
	expect(context.reportPost).not.toHaveBeenCalled();
	await source.stop();
});
it("requires a progressing cursor, retaining the last complete watermark after a looping page", async () => {
	const { start, tick, client, context, result } = fixture();
	await start();
	client.posts.mockImplementationOnce(() =>
		result({ aweme_list: [work("2", 2)], has_more: 1, max_cursor: 0 }),
	);
	await tick();
	expect(context.reportPost).not.toHaveBeenCalled();
	expect(context.reportProblem).toHaveBeenCalledWith(
		expect.objectContaining({ code: "douyin_posts", externalId: secUid }),
	);
	client.posts.mockImplementationOnce(() =>
		result({ aweme_list: [work("1", 1), work("2", 2)], has_more: 0 }),
	);
	await tick();
	expect(context.reportPost.mock.calls.map((call) => call[1].postId)).toEqual(["1", "2"]);
});

it("observes a live session once, retains it through uncertainty and distinguishes start, periodic verification and end", async () => {
	const { source, start, tick, client, setSubs, context, result } = fixture();
	const roomId = "7490000000000000001",
		webRid = "4387654";
	let liveStatus: number | undefined = 1;
	const online = () => ({
		...user,
		live_status: liveStatus,
		room_data: JSON.stringify({ owner: { web_rid: webRid } }),
		room_id_str: roomId,
	});
	client.profile.mockImplementation(() => result({ user: online() }));
	client.room.mockImplementation(() =>
		result({
			data: { data: [{ id_str: roomId, status: 2, title: "晚间直播", create_time: 1700000000 }] },
		}),
	);
	const identity = { sourceKey: "douyin", externalId: secUid };
	setSubs([
		{
			externalId: secUid,
			features: new Set(["liveStart", "liveEnd", "liveStreaming"]),
			monitorsLive: true,
		},
	]);
	await start();
	expect(context.reportLive.mock.calls.map((call) => call[1].kind)).toEqual(["status"]);
	expect(context.reportLive.mock.calls[0][1]).toMatchObject({
		isLive: true,
		details: { url: `https://live.douyin.com/${webRid}` },
	});
	expect(client.profile).toHaveBeenCalledTimes(1);
	expect(await source.fetchLiveStatus(identity, signal)).toMatchObject({
		ok: true,
		kind: "live",
		details: { title: "晚间直播" },
	});
	await tick();
	liveStatus = undefined;
	await tick();
	expect(await source.fetchLiveStatus(identity, signal)).toMatchObject({ ok: false });
	liveStatus = 1;
	client.room.mockImplementationOnce(async () =>
		fail("rate_limited", "challenge", { upstreamCode: "douyin.cooldown" }),
	);
	await tick();
	await tick();
	expect(context.reportLive).toHaveBeenCalledTimes(1);
	liveStatus = 0;
	await tick();
	await tick();
	expect(await source.fetchLiveStatus(identity, signal)).toEqual({ ok: true, kind: "offline" });
	liveStatus = 1;
	await tick();
	expect(context.reportLive.mock.calls.map((call) => call[1].kind)).toEqual([
		"status",
		"end",
		"start",
	]);
	await source.stop();
	await start();
	expect(context.reportLive.mock.calls.map((call) => call[1].kind)).toEqual([
		"status",
		"end",
		"start",
		"status",
	]);
	expect(client.posts).not.toHaveBeenCalled();
});

it.each([
	{
		room: { start_time: "1700000000", user_count: 27, stats: { total_user: 1250 } },
		subPartition: { partition: { title: "三角洲行动" } },
		details: { category: "三角洲行动", currentViewers: 27, totalViewers: 1250 },
		startedAt: "2023-11-14T22:13:20.000Z",
	},
	{
		room: {
			start_time: 0,
			create_time: 1700000000,
			stats: { user_count_str: "27", total_user_str: "0" },
		},
		subPartition: undefined,
		details: { category: "游戏", currentViewers: 27, totalViewers: 0 },
		startedAt: undefined,
	},
	{
		room: { create_time: 1700000000, user_count: 27, stats: { total_user_str: "5万+" } },
		subPartition: undefined,
		details: { category: "游戏", currentViewers: 27 },
		startedAt: undefined,
	},
])(
	"reports the room category, explicit start time and exact viewer counts %#",
	async ({ room, subPartition, details, startedAt }) => {
		const { source, client, result } = fixture();
		const roomId = "7490000000000000001";
		const webRid = "4387654";
		client.profile.mockImplementation(() =>
			result({
				user: {
					...user,
					live_status: 1,
					room_id_str: roomId,
					room_data: { owner: { web_rid: webRid } },
				},
			}),
		);
		client.room.mockImplementation(() =>
			result({
				data: {
					data: [{ id_str: roomId, status: 2, ...room }],
					partition_road_map: { partition: { title: "游戏" }, sub_partition: subPartition },
				},
			}),
		);
		expect(
			await source.fetchLiveStatus({ sourceKey: "douyin", externalId: secUid }, signal),
		).toStrictEqual({
			ok: true,
			kind: "live",
			...(startedAt && { startedAt }),
			details: { url: `https://live.douyin.com/${webRid}`, ...details },
		});
	},
);

it("stops requests before they can report, and does not infer a room's identity from a different session", async () => {
	const { source, start, tick, client, setSubs, context, result } = fixture();
	setSubs([{ externalId: secUid, features: new Set(["liveStart"]), monitorsLive: true }]);
	client.profile.mockImplementation(() =>
		result({
			user: { ...user, live_status: 1, room_id_str: "89", room_data: '{"owner":{"web_rid":"12"}}' },
		}),
	);
	client.room.mockImplementation(() => result({ data: { data: [{ id_str: "88", status: 2 }] } }));
	await start();
	expect(context.reportLive).not.toHaveBeenCalled();
	let observed!: AbortSignal;
	let release!: (value: Awaited<ReturnType<typeof result>>) => void;
	client.room.mockImplementationOnce((_web, _room, signal) => {
		observed = signal;
		return new Promise((done) => {
			release = done;
		});
	});
	const inFlight = tick();
	await vi.waitFor(() => expect(observed).toBeDefined());
	await source.stop();
	expect(observed.aborted).toBe(true);
	release(await result({ data: { data: [{ id_str: "89", status: 2 }] } }));
	await inFlight;
	expect(context.reportLive).not.toHaveBeenCalled();
});

it("ignores unchanged subscription notifications and immediately checks only newly added authors", async () => {
	const { start, client, context, setSubs } = fixture();
	const first: SourceSubscriptionView = {
		externalId: secUid,
		features: new Set(["post"]),
		monitorsLive: false,
	};
	await start();
	setSubs([first]);
	await Promise.resolve();
	expect(client.profile).toHaveBeenCalledTimes(1);
	const extra = { ...first, externalId: "MS4wLjABAAAAsecond" };
	setSubs([first, extra]);
	await vi.waitFor(() => expect(client.posts).toHaveBeenCalledTimes(2));
	expect(client.profile.mock.calls.map((call) => call[0])).toEqual([secUid, extra.externalId]);
	expect(context.reportPost).not.toHaveBeenCalled();
});

it("records a failed periodic live check for its author and clears it only when that author recovers", async () => {
	const { source, start, client, context, result } = fixture();
	await start();
	const identity = { sourceKey: "douyin", externalId: secUid };
	const issue = { externalId: secUid, code: "douyin_live" };
	client.profile.mockImplementationOnce(() => result({ user: { ...user, live_status: null } }));
	expect(await source.fetchLiveStatus(identity, signal)).toMatchObject({ ok: false });
	expect(context.reportProblem).toHaveBeenCalledWith({ ...issue, message: "error.live" });
	client.profile.mockImplementationOnce(() =>
		result({ user: { ...user, sec_uid: "other", live_status: 0 } }),
	);
	await source.fetchLiveStatus({ ...identity, externalId: "other" }, signal);
	expect(context.resolveProblem).not.toHaveBeenCalledWith(issue);
	client.profile.mockImplementationOnce(() => result({ user: { ...user, live_status: 0 } }));
	await source.fetchLiveStatus(identity, signal);
	expect(context.resolveProblem).toHaveBeenCalledWith(issue);
});

it("never combines works from two accounts when the session changes during pagination", async () => {
	const { start, tick, client, context, result, switchAccount } = fixture();
	await start();
	const first = { aweme_list: [work("2", 2)], has_more: 1, max_cursor: 1 };
	let release!: (value: Awaited<ReturnType<typeof result>>) => void;
	let observed!: AbortSignal;
	client.posts
		.mockImplementationOnce(() => result(first))
		.mockImplementationOnce((_id, _cursor, signal) => {
			observed = signal;
			return new Promise((done) => {
				release = done;
			});
		});
	const old = tick();
	await vi.waitFor(() => expect(observed).toBeDefined());
	switchAccount();
	expect(observed.aborted).toBe(true);
	release(await result({ aweme_list: [work("1", 1)], has_more: 0 }));
	await old;
	expect(context.reportPost).not.toHaveBeenCalled();
	client.posts.mockImplementationOnce(() => result({ aweme_list: [work("4", 4)], has_more: 0 }));
	await tick();
	expect(context.reportPost.mock.calls.map((call) => call[1].postId)).toEqual(["4"]);
});

it("does not claim a complete checkpoint on a missing page even when two new posts share the baseline second", async () => {
	const { start, tick, client, context, result } = fixture();
	client.posts.mockImplementationOnce(() =>
		result({ aweme_list: [work("10", 100), work("1", 80)], has_more: 0 }),
	);
	await start();
	const first = { aweme_list: [work("30", 100), work("10", 100)], has_more: 1, max_cursor: "34" };
	client.posts
		.mockImplementationOnce(() => result(first))
		.mockImplementationOnce(() => result({ status_code: 0 }));
	await tick();
	expect(context.reportPost).not.toHaveBeenCalled();
	client.posts
		.mockImplementationOnce(() => result(first))
		.mockImplementationOnce(() =>
			result({ aweme_list: [work("20", 100), work("1", 80)], has_more: 0 }),
		);
	await tick();
	expect(context.reportPost.mock.calls.map((call) => call[1].postId)).toEqual(["20", "30"]);
});
