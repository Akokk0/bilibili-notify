/**
 * 单元测试 — `createStatsRecorder`(mock bus + mock store)。
 *
 * Recorder = 中立的记录器 + 各来源适配(ADR-0020 决策 17)。直播场次由
 * `live-source.test.ts` 单独守;这里守记录器自己的作品、收尾、清理与「在记」。
 * 作品行由 `post-detected` 的监听记(B 站与拓展共用,事件自带订阅 id)。
 *
 * 守护契约:
 *   - post-detected → 作品行按事件的订阅 id 落,有没有视频取 post.video
 *   - dispose 后不再写任何东西
 */

import type { LiveSession, LiveSessionChange, MessageBus } from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { FollowersStore } from "../../followers/store.js";
import { createStatsRecorder, createStatsRecorderCore } from "../recorder.js";
import type { StatsStore } from "../store.js";

function makeBus() {
	const handlers = new Map<string, Array<(payload?: unknown) => void>>();
	const bus = {
		emit: () => {},
		on: (event: string, handler: (payload?: unknown) => void) => {
			const arr = handlers.get(event) ?? [];
			arr.push(handler);
			handlers.set(event, arr);
			// 真解绑 —— dispose 用例要验的是「recorder 归还了 bus 句柄」这个契约,
			// 而不是它内部有没有自己记一个 disposed 标志位。
			return {
				dispose: () => {
					const cur = handlers.get(event);
					if (cur)
						handlers.set(
							event,
							cur.filter((h) => h !== handler),
						);
				},
			};
		},
	} as unknown as MessageBus;
	return {
		bus,
		trigger: (event: string, payload?: unknown) => {
			for (const h of handlers.get(event) ?? []) h(payload);
		},
	};
}

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
		appendRecording: ReturnType<typeof vi.fn>;
		listRecording: ReturnType<typeof vi.fn>;
		appendPost: ReturnType<typeof vi.fn>;
		openLiveSession: ReturnType<typeof vi.fn>;
		closeLiveSession: ReturnType<typeof vi.fn>;
		drop: ReturnType<typeof vi.fn>;
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
	} satisfies Record<keyof FollowersStore, unknown> as unknown as FollowersStore & {
		append: ReturnType<typeof vi.fn>;
	};
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

let clock: string;
const now = () => new Date(clock);

beforeEach(() => {
	clock = "2026-05-16T10:00:00.000Z";
	vi.clearAllMocks();
});

/** 订阅启用着、作品与直播开关都开着(「在记」的两格条件)。 */
const ON = { enabled: true, recordsPosts: true, recordsLive: true };

/** 两位 UP:uid "1" / "2",订阅 id "id-1" / "id-2"。 */
const SUBS = [
	{ id: "id-1", identity: { sourceKey: "bilibili", externalId: "1" }, ...ON },
	{ id: "id-2", identity: { sourceKey: "bilibili", externalId: "2" }, ...ON },
];

function liveSession(over: Partial<LiveSession> = {}): LiveSession {
	return {
		subscriptionId: "id-1",
		sourceKey: "bilibili",
		startedAt: "2026-05-16T09:00:00.000Z",
		detectedAt: "2026-05-16T10:00:00.000Z",
		...over,
	};
}

function liveStart(current = liveSession()): LiveSessionChange {
	return {
		kind: "start",
		subscriptionId: current.subscriptionId,
		session: current,
		trigger: "start-signal",
		details: {},
	};
}

function liveEnd(current = liveSession()): LiveSessionChange {
	return {
		kind: "end",
		subscriptionId: current.subscriptionId,
		session: current,
		reason: "signal",
		endedAt: "2026-05-16T12:00:00.000Z",
	};
}

function setup(subs: () => readonly unknown[] = () => SUBS) {
	const { bus, trigger } = makeBus();
	const store = makeStore();
	const handle = createStatsRecorder({
		isEnabled: () => true,
		bus,
		store,
		followers: makeFans(),
		logger,
		now,
		subscriptions: subs as never,
		sources: { get: () => undefined },
	});
	return { trigger, store, handle };
}

// 作品行(`post-detected`,B 站与拓展共用一个监听)的完整用例在 `post-detected.test.ts`(真总线,两种形状各喂一条);
// 这里只钉:键是事件里的订阅 id,不是 uid。
describe("StatsRecorder — 作品事件(post-detected)", () => {
	it("视频作品 → appendPost 记成有视频,按订阅 id 落(不是 uid),发布时间取 post.publishedAt", async () => {
		const { trigger, store } = setup();
		trigger("post-detected", {
			subscriptionId: "id-1",
			identity: { sourceKey: "bilibili", externalId: "1" },
			postId: "abc",
			url: "https://www.bilibili.com/video/BVabc",
			post: {
				creator: { name: "某人" },
				publishedAt: "2026-05-16T09:00:00.000Z",
				text: "",
				video: { cover: {}, title: "视频", description: "" },
			},
		});
		await vi.waitFor(() => expect(store.appendPost).toHaveBeenCalled());
		expect(store.appendPost).toHaveBeenCalledWith(
			"id-1",
			expect.objectContaining({
				id: "abc",
				hasVideo: true,
				publishedAt: "2026-05-16T09:00:00.000Z",
			}),
		);
	});
});

describe("StatsRecorder — 订阅删除清理", () => {
	it("subscription-changed 的 remove → drop,不留孤儿文件", async () => {
		const { trigger, store } = setup();
		trigger("subscription-changed", {
			ops: [
				{
					kind: "remove",
					sub: { id: "id-1", identity: { sourceKey: "bilibili", externalId: "1" } },
				},
				{ kind: "add", sub: { identity: { sourceKey: "bilibili", externalId: "2" } } },
			],
		});
		await vi.waitFor(() => expect(store.drop).toHaveBeenCalled());
		expect(store.drop).toHaveBeenCalledTimes(1);
		expect(store.drop).toHaveBeenCalledWith("id-1");
	});

	it("一次删掉 B 站、拓展、在册的非 B 站内置来源订阅 → 三条统计文件各删一次", async () => {
		const subscriptions = [
			{ id: "bili-1", identity: { sourceKey: "bilibili", externalId: "1" }, ...ON },
			{ id: "ext-1", identity: { sourceKey: "douyin", externalId: "1" }, ...ON },
			{ id: "builtin-1", identity: { sourceKey: "acme.inprocess", externalId: "1" }, ...ON },
		];
		const { trigger, store } = setup(() => subscriptions);
		trigger("subscription-changed", {
			ops: subscriptions.map((sub) => ({ kind: "remove", sub })),
		});
		await vi.waitFor(() => expect(store.drop).toHaveBeenCalledTimes(3));
		expect(store.drop.mock.calls.map((call) => call[0]).sort()).toEqual([
			"bili-1",
			"builtin-1",
			"ext-1",
		]);
	});

	it("退订正在直播的 UP → 关服时不再给他补下播帧,免得把刚删的文件重建出来", async () => {
		// `openLive` 曾经只在正常下播时被摘掉。退订时 `drop` 已经 unlink 了那两个
		// jsonl,但这位 uid 还留在 `openLive` 里 —— 关服的 closeOpenSessions 会给他
		// 再 append 一帧 end,把 stats/live/<uid>.jsonl 整个重新创建出来,从此成为
		// 一份谁也不会再读、也不会再被清理的孤儿。
		const { trigger, store, handle } = setup();
		trigger("live-session-changed", liveStart());
		await vi.waitFor(() => expect(store.openLiveSession).toHaveBeenCalled());

		trigger("subscription-changed", {
			ops: [
				{
					kind: "remove",
					sub: { id: "id-1", identity: { sourceKey: "bilibili", externalId: "1" } },
				},
			],
		});
		await vi.waitFor(() => expect(store.drop).toHaveBeenCalled());

		await handle.closeOpenSessions();
		expect(store.closeLiveSession).not.toHaveBeenCalled();
	});
});

describe("StatsRecorder — dispose", () => {
	it("dispose 后事件不再落盘", async () => {
		const { trigger, store, handle } = setup();
		handle.dispose();
		trigger("post-detected", {
			subscriptionId: "id-1",
			identity: { sourceKey: "bilibili", externalId: "1" },
			postId: "a",
			url: "https://t.bilibili.com/a",
			post: { creator: { name: "某人" }, publishedAt: "2026-05-16T09:00:00.000Z", text: "" },
		});
		trigger("live-session-changed", liveStart());
		await handle.flush();
		expect(store.appendPost).not.toHaveBeenCalled();
		expect(store.openLiveSession).not.toHaveBeenCalled();
	});
});

describe("StatsRecorder — 关服时闭合在播场次", () => {
	it("关服时把敞开的场写上下播帧,不丢掉已经播的时长", async () => {
		// 关服路径不会触发真实下播事件(teardown/cancel 都不翻 liveStatus),
		// 不补这一帧的话,这一场永远等不到 end,已观测到的时长就白丢了。
		const { trigger, store, handle } = setup();
		trigger("live-session-changed", liveStart());
		await vi.waitFor(() => expect(store.openLiveSession).toHaveBeenCalled());

		clock = "2026-05-16T12:00:00.000Z";
		await handle.closeOpenSessions();
		expect(store.closeLiveSession).toHaveBeenCalledWith("id-1", {
			endedAt: "2026-05-16T12:00:00.000Z",
		});
	});

	it("没有在播的场次 → 不写多余的帧", async () => {
		const { store, handle } = setup();
		await handle.closeOpenSessions();
		expect(store.closeLiveSession).not.toHaveBeenCalled();
	});

	it("已经正常下播的场次不会在关服时被重复闭合", async () => {
		const { trigger, store, handle } = setup();
		trigger("live-session-changed", liveStart());
		trigger("live-session-changed", liveEnd());
		await vi.waitFor(() => expect(store.closeLiveSession).toHaveBeenCalledTimes(1));

		await handle.closeOpenSessions();
		expect(store.closeLiveSession).toHaveBeenCalledTimes(1);
	});
});

describe("中立记录器(给各来源适配用的那一面)", () => {
	function core(isEnabled: () => boolean = () => true) {
		const store = makeStore();
		const fans = makeFans();
		const recorder = createStatsRecorderCore({
			store,
			followers: fans,
			logger,
			now,
			isEnabled,
		});
		return { store, fans, recorder };
	}

	it("同一键间隔很短的两条拉取样本都保留,报来的样本仍按间隔稀释", async () => {
		const { fans, recorder } = core();
		recorder.recordFollowers("pulled", 100);
		clock = "2026-05-16T10:00:01.000Z";
		recorder.recordFollowers("pulled", 101);
		recorder.recordReportedFollowers("reported", 200, 60_000);
		clock = "2026-05-16T10:00:02.000Z";
		recorder.recordReportedFollowers("reported", 201, 60_000);
		await recorder.flush();
		const samplesFor = (key: string) =>
			fans.append.mock.calls.filter(([written]) => written === key).map(([, sample]) => sample);
		expect(samplesFor("pulled")).toEqual([
			{ sampledAt: "2026-05-16T10:00:00.000Z", followers: 100 },
			{ sampledAt: "2026-05-16T10:00:01.000Z", followers: 101 },
		]);
		expect(samplesFor("reported")).toEqual([
			{ sampledAt: "2026-05-16T10:00:01.000Z", followers: 200 },
		]);
	});

	it("拉取样本落盘后 Promise 才落定", async () => {
		const { fans, recorder } = core();
		let finishAppend: (() => void) | undefined;
		fans.append.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finishAppend = resolve;
				}),
		);
		let settled = false;
		const pending = recorder.recordFollowers("key", 1200).then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		finishAppend?.();
		await pending;
		expect(settled).toBe(true);
		expect(fans.append).toHaveBeenCalledWith("key", {
			sampledAt: "2026-05-16T10:00:00.000Z",
			followers: 1200,
		});
	});

	it("总开关关着时拉取样本直接落定,时序里没有", async () => {
		let enabled = false;
		const { fans, recorder } = core(() => enabled);
		await expect(recorder.recordFollowers("key", 1200)).resolves.toBeUndefined();
		expect(fans.append).not.toHaveBeenCalled();
		enabled = true;
		await recorder.recordFollowers("key", 1200);
		expect(fans.append).toHaveBeenCalledTimes(1);
	});

	it.each([Number.NaN, -1, 1.5])("拉取样本 %s 不是有限非负整数 → 不写", async (value) => {
		const { fans, recorder } = core();
		await expect(recorder.recordFollowers("key", value)).resolves.toBeUndefined();
		expect(fans.append).not.toHaveBeenCalled();
	});

	it("拉取样本更新稀释时刻:间隔内紧跟的报来样本被丢掉", async () => {
		const { fans, recorder } = core();
		await recorder.recordFollowers("key", 100);
		clock = "2026-05-16T10:00:01.000Z";
		recorder.recordReportedFollowers("key", 101, 60_000);
		await recorder.flush();
		expect(fans.append).toHaveBeenCalledTimes(1);
		expect(fans.append).toHaveBeenCalledWith("key", {
			sampledAt: "2026-05-16T10:00:00.000Z",
			followers: 100,
		});
	});

	it("关一场时把场次引擎交来的 peak 原样带进下播帧", async () => {
		const { store, recorder } = core();
		recorder.openSession("ext-a", { startedAt: "2026-05-16T09:00:00.000Z" });
		recorder.closeSession("ext-a", { endedAt: "2026-05-16T10:00:00.000Z", peakTotalViewers: 800 });
		recorder.openSession("ext-b", { startedAt: "2026-05-16T09:00:00.000Z" });
		recorder.closeSession("ext-b", { endedAt: "2026-05-16T10:00:00.000Z", peakTotalViewers: 1200 });
		await vi.waitFor(() => expect(store.closeLiveSession).toHaveBeenCalledTimes(2));
		expect(store.closeLiveSession).toHaveBeenNthCalledWith(1, "ext-a", {
			endedAt: expect.any(String),
			peakTotalViewers: 800,
		});
		expect(store.closeLiveSession).toHaveBeenNthCalledWith(2, "ext-b", {
			endedAt: expect.any(String),
			peakTotalViewers: 1200,
		});
	});

	it("非有限数的累计观看不收", async () => {
		const { store, recorder } = core();
		recorder.openSession("k", { startedAt: "2026-05-16T09:00:00.000Z" });
		recorder.closeSession("k", {
			endedAt: "2026-05-16T10:00:00.000Z",
			peakTotalViewers: Number.NaN,
		});
		await vi.waitFor(() => expect(store.closeLiveSession).toHaveBeenCalled());
		expect(store.closeLiveSession).toHaveBeenCalledWith("k", { endedAt: expect.any(String) });
	});

	it("drop 忘掉在飞的状态并删文件", async () => {
		const { store, recorder } = core();
		recorder.openSession("ext-y", { startedAt: "2026-05-16T09:00:00.000Z" });
		recorder.drop("ext-y");
		await vi.waitFor(() => expect(store.drop).toHaveBeenCalledWith("ext-y"));
		await recorder.closeOpenSessions();
		expect(store.closeLiveSession).not.toHaveBeenCalled();
	});
});

describe("中立记录器 —— 「在记」小账按整点小时记(ADR-0027 决策 13)", () => {
	const HOUR = 3_600_000;
	const T = Date.parse("2026-05-16T10:20:00.000Z");
	const hourRow = (kind: string, at = T) => {
		const from = Math.floor(at / HOUR) * HOUR;
		return {
			kind,
			startedAt: new Date(from).toISOString(),
			endedAt: new Date(from + HOUR).toISOString(),
		};
	};
	const make = (existing: Array<ReturnType<typeof hourRow>> = []) => {
		const store = makeStore();
		store.listRecording.mockResolvedValue(existing);
		const core = createStatsRecorderCore({
			store,
			followers: makeFans(),
			logger,
			now,
			isEnabled: () => true,
		});
		return { store, core };
	};

	it("同一小时同一项只落一行:正好一个 UTC 整点小时", async () => {
		const { store, core } = make();
		core.recordActive("id-1", "posts");
		core.recordActive("id-1", "posts");
		core.recordActive("id-1", "posts", T + 30 * 60_000);
		await core.flush();
		expect(store.appendRecording).toHaveBeenCalledTimes(1);
		expect(store.appendRecording).toHaveBeenCalledWith("id-1", hourRow("posts"));
	});

	it("项与键各自独立;跨小时落第二行", async () => {
		const { store, core } = make();
		core.recordActive("id-1", "posts");
		core.recordActive("id-1", "live");
		core.recordActive("id-2", "posts");
		await core.flush();
		expect(
			store.appendRecording.mock.calls
				.map((c) => `${c[0]}/${(c[1] as { kind: string }).kind}`)
				.sort(),
		).toEqual(["id-1/live", "id-1/posts", "id-2/posts"]);
		core.recordActive("id-1", "posts", T + HOUR);
		await core.flush();
		expect(store.appendRecording).toHaveBeenCalledTimes(4);
		expect(store.appendRecording).toHaveBeenLastCalledWith("id-1", hourRow("posts", T + HOUR));
	});

	it("重启(新建记录器、同一份盘)后同一小时不重复落;盘上没有的项照落", async () => {
		const { store: first, core: firstCore } = make();
		firstCore.recordActive("id-1", "posts");
		await firstCore.flush();
		expect(first.appendRecording).toHaveBeenCalledTimes(1);
		// 重启:新记录器,盘上已有这个小时的 posts(还有一条合好的长区间 followers 盖着这个小时)。
		const { store, core } = make([
			hourRow("posts"),
			{
				kind: "followers",
				startedAt: "2026-05-16T00:00:00.000Z",
				endedAt: "2026-05-16T23:00:00.000Z",
			},
		]);
		core.recordActive("id-1", "posts");
		core.recordActive("id-1", "followers");
		core.recordActive("id-1", "live");
		await core.flush();
		expect(store.appendRecording.mock.calls.map((c) => (c[1] as { kind: string }).kind)).toEqual([
			"live",
		]);
	});

	it("上一个小时的也收(资料刷新一轮跨过整点:上个小时采的、下个小时才发出事件),再早的丢掉", async () => {
		const { store, core } = make();
		core.recordActive("id-1", "posts", T + HOUR);
		core.recordActive("id-1", "followers", T + 30 * 60_000);
		core.recordActive("id-1", "followers", T - HOUR);
		await core.flush();
		expect(
			store.appendRecording.mock.calls.map(
				(c) =>
					`${c[0]}/${(c[1] as { kind: string; startedAt: string }).kind}/${(c[1] as { startedAt: string }).startedAt}`,
			),
		).toEqual([
			`id-1/posts/${hourRow("posts", T + HOUR).startedAt}`,
			`id-1/followers/${hourRow("followers", T).startedAt}`,
		]);
	});

	it("订阅删了(drop):内存里的小时标记一并忘掉,同名键重新来过", async () => {
		const { store, core } = make();
		core.recordActive("id-1", "posts");
		await core.flush();
		core.drop("id-1");
		core.recordActive("id-1", "posts");
		await core.flush();
		expect(store.appendRecording).toHaveBeenCalledTimes(2);
	});
});
