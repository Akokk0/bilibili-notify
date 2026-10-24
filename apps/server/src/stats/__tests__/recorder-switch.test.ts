/**
 * **统计总开关在记录器入口拦着**(ADR-0027 决策 9、16;㉙a)。
 *
 * 开关由装配处注入一个 `isEnabled()`,记录器在 `recordPost / openSession / recordReportedFollowers / recordActive` 四个入口
 * 头上判一次。关着时:作品、新开的场次、粉丝样本、「在记」的账都不落盘;**开着时开的场次关着时照样收尾**
 * (一场的头尾不分家),关着时新来的开播不开场、没开过场的下播不写孤立的 `end`。
 *
 * 每条「不写」的断言都配一条同样调用、开着时会写的对照 —— 只断言「没写」会在什么都没发生时空绿。
 */

import type { MessageBus, PostEvent } from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { FollowersStore } from "../../followers/store.js";
import { createStatsRecorder, createStatsRecorderCore } from "../recorder.js";
import type { StatsStore } from "../store.js";

function makeStore() {
	return {
		appendPost: vi.fn(async () => {}),
		openLiveSession: vi.fn(async () => {}),
		closeLiveSession: vi.fn(async () => {}),
		appendRecording: vi.fn(async () => {}),
		listRecording: vi.fn(async () => []),
		recordingKeys: vi.fn(async () => []),
		compactRecording: vi.fn(async () => ({
			rowsBefore: 0,
			rowsAfter: 0,
			badLines: 0,
			rewritten: false,
		})),
		drop: vi.fn(async () => {}),
	} as unknown as StatsStore & {
		appendPost: ReturnType<typeof vi.fn>;
		openLiveSession: ReturnType<typeof vi.fn>;
		closeLiveSession: ReturnType<typeof vi.fn>;
		appendRecording: ReturnType<typeof vi.fn>;
		compactRecording: ReturnType<typeof vi.fn>;
		recordingKeys: ReturnType<typeof vi.fn>;
	};
}

function makeFans() {
	return {
		append: vi.fn(async () => {}),
		listSamplesSince: vi.fn(async () => []),
		drop: vi.fn(async () => {}),
	} as unknown as FollowersStore & { append: ReturnType<typeof vi.fn> };
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const NOW = "2026-05-16T10:00:00.000Z";
const KEY = "id-1";

let enabled: boolean;

function setupCore() {
	const store = makeStore();
	const fans = makeFans();
	const core = createStatsRecorderCore({
		store,
		followers: fans,
		logger,
		now: () => new Date(NOW),
		isEnabled: () => enabled,
	});
	return { store, fans, core };
}

/** 五种写入口各来一遍。 */
async function touchEverything(core: ReturnType<typeof setupCore>["core"]) {
	core.recordPost(KEY, { id: "p1", hasVideo: true, publishedAt: NOW });
	core.openSession(KEY, { startedAt: "2026-05-16T09:00:00.000Z" });
	core.recordReportedFollowers(KEY, 1234, 0);
	core.recordActive(KEY, "posts");
	core.recordActive(KEY, "followers");
	await core.flush();
}

beforeEach(() => {
	vi.clearAllMocks();
	enabled = true;
});

describe("记录器 × 总开关 — 关着不落盘", () => {
	it("对照:开着时作品、开场、粉丝样本、「在记」都会写", async () => {
		const { store, fans, core } = setupCore();
		await touchEverything(core);
		expect(store.appendPost).toHaveBeenCalledTimes(1);
		expect(store.openLiveSession).toHaveBeenCalledTimes(1);
		expect(fans.append).toHaveBeenCalledTimes(1);
		expect(store.appendRecording).toHaveBeenCalledTimes(2);
	});

	it("关着:作品、新开的场次、粉丝样本、「在记」一行都不写", async () => {
		enabled = false;
		const { store, fans, core } = setupCore();
		await touchEverything(core);
		expect(store.appendPost).not.toHaveBeenCalled();
		expect(store.openLiveSession).not.toHaveBeenCalled();
		expect(fans.append).not.toHaveBeenCalled();
		expect(store.appendRecording).not.toHaveBeenCalled();
	});
});

describe("记录器 × 总开关 — 正在播的那一场照常收尾", () => {
	it("开着时开场 → 关掉 → 下播:下播帧照写,场次引擎给的峰值照带", async () => {
		const { store, core } = setupCore();
		core.openSession(KEY, { startedAt: "2026-05-16T09:00:00.000Z" });
		enabled = false;
		core.closeSession(KEY, { endedAt: "2026-05-16T11:00:00.000Z", peakTotalViewers: 250 });
		await core.flush();
		expect(store.openLiveSession).toHaveBeenCalledTimes(1);
		expect(store.closeLiveSession).toHaveBeenCalledWith(KEY, {
			endedAt: "2026-05-16T11:00:00.000Z",
			peakTotalViewers: 250,
		});
	});

	it("关着时新来的开播不开场,它的下播也不写孤立的 end", async () => {
		enabled = false;
		const { store, core } = setupCore();
		core.openSession(KEY, { startedAt: "2026-05-16T09:00:00.000Z" });
		core.closeSession(KEY, { endedAt: "2026-05-16T11:00:00.000Z", peakTotalViewers: 100 });
		await core.flush();
		expect(store.openLiveSession).not.toHaveBeenCalled();
		expect(store.closeLiveSession).not.toHaveBeenCalled();
	});

	it("对照:开着时没开过场的下播,照旧写 end(行为不变,孤立 end 在配对时丢弃)", async () => {
		const { store, core } = setupCore();
		core.closeSession(KEY, { endedAt: "2026-05-16T11:00:00.000Z", peakTotalViewers: 5 });
		await core.flush();
		expect(store.closeLiveSession).toHaveBeenCalledTimes(1);
	});

	it("关着时下播收了场之后,同一场不会再收第二次(forget 照跑)", async () => {
		const { store, core } = setupCore();
		core.openSession(KEY, { startedAt: "2026-05-16T09:00:00.000Z" });
		enabled = false;
		core.closeSession(KEY, { endedAt: "2026-05-16T11:00:00.000Z" });
		core.closeSession(KEY, { endedAt: "2026-05-16T11:05:00.000Z" });
		await core.flush();
		expect(store.closeLiveSession).toHaveBeenCalledTimes(1);
	});

	it("关停补帧:开着时开的场次,关着时关服也补下播帧", async () => {
		const { store, core } = setupCore();
		core.openSession(KEY, { startedAt: "2026-05-16T09:00:00.000Z" });
		enabled = false;
		await core.closeOpenSessions();
		expect(store.closeLiveSession).toHaveBeenCalledTimes(1);
	});
});

describe("记录器 × 总开关 — 关了又开,之后的照记", () => {
	it("关 → 开:开了以后的作品 / 开场 / 粉丝样本 / 「在记」都落盘", async () => {
		enabled = false;
		const { store, fans, core } = setupCore();
		await touchEverything(core);
		expect(store.appendPost).not.toHaveBeenCalled();
		enabled = true;
		await touchEverything(core);
		expect(store.appendPost).toHaveBeenCalledTimes(1);
		expect(store.openLiveSession).toHaveBeenCalledTimes(1);
		expect(fans.append).toHaveBeenCalledTimes(1);
		expect(store.appendRecording).toHaveBeenCalledTimes(2);
	});
});

describe("记录器 reset(原 clear)— 只清内存里的在飞状态,不删盘", () => {
	it("开着的场次被 reset 之后,关停不再给它补下播帧;盘上的开场不动", async () => {
		const { store, core } = setupCore();
		core.openSession(KEY, { startedAt: "2026-05-16T09:00:00.000Z" });
		core.reset();
		await core.closeOpenSessions();
		expect(store.openLiveSession).toHaveBeenCalledTimes(1);
		expect(store.closeLiveSession).not.toHaveBeenCalled();
		expect(store.drop).not.toHaveBeenCalled();
	});
});

describe("记录器 × 总开关 — 压缩不受它管", () => {
	it("关着时 compactRecording 照跑", async () => {
		enabled = false;
		const { store, core } = setupCore();
		store.recordingKeys.mockResolvedValue(["k1", "k2"]);
		await core.compactRecording(new Date(NOW));
		expect(store.compactRecording).toHaveBeenCalledTimes(2);
	});
});

describe("记录器 × 总开关 — 热更新(整条采集链,下一条事件就按新值办)", () => {
	function makeBus() {
		const handlers = new Map<string, Array<(payload?: unknown) => void>>();
		const bus = {
			emit: () => {},
			on: (event: string, handler: (payload?: unknown) => void) => {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
				return { dispose: () => {} };
			},
		} as unknown as MessageBus;
		return {
			bus,
			trigger: (event: string, payload?: unknown) => {
				for (const h of handlers.get(event) ?? []) h(payload);
			},
		};
	}

	it("运行中改开关:不重新挂适配,下一条动态就按新值", async () => {
		const { bus, trigger } = makeBus();
		const store = makeStore();
		createStatsRecorder({
			bus,
			store,
			followers: makeFans(),
			profileRefreshCron: () => "*/10 * * * *",
			logger,
			now: () => new Date(NOW),
			isEnabled: () => enabled,
			subscriptions: () => [
				{
					id: KEY,
					identity: { sourceKey: "bilibili", externalId: "1" },
					enabled: true,
					recordsPosts: true,
					recordsLive: true,
				},
			],
			sources: { get: () => undefined },
		});
		const dynamic = (id: string): PostEvent => ({
			subscriptionId: KEY,
			identity: { sourceKey: "bilibili", externalId: "1" },
			postId: id,
			url: `https://t.bilibili.com/${id}`,
			post: { creator: { name: "某人" }, publishedAt: new Date(NOW).toISOString(), text: "" },
		});

		trigger("post-detected", dynamic("a"));
		await vi.waitFor(() => expect(store.appendPost).toHaveBeenCalledTimes(1));

		enabled = false;
		trigger("post-detected", dynamic("b"));
		await new Promise((r) => setTimeout(r, 20));
		expect(store.appendPost).toHaveBeenCalledTimes(1);

		enabled = true;
		trigger("post-detected", dynamic("c"));
		await vi.waitFor(() => expect(store.appendPost).toHaveBeenCalledTimes(2));
	});
});
