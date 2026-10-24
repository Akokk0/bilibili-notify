/**
 * 来源经 `ctx.reportProfile` 报的资料落盘(`createProfileReportHandler`,3b-42):
 * 给了哪格改哪格、粉丝数按资料刷新间隔稀释记样本(统计关着不记)、写完当场叫资料刷新重算这几行。
 * 头像已经是图库引用(来源先 `storeImage` 存好),这里不再收字节。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PNG_BYTES } from "../../__tests__/support/avatar-fixtures.js";
import type { FollowersStore } from "../../followers/store.js";
import { createImageStore, type ImageStore, type ImageWriter } from "../../images/image-store.js";
import { createStatsRecorderCore } from "../../stats/recorder.js";
import type { StatsStore } from "../../stats/store.js";
import { createNodeMessageBus } from "../message-bus.js";
import { createProfileReportHandler, type ProfileReportHandler } from "../reported-profiles.js";
import {
	createSubscriptionStateStore,
	type SubscriptionStateStore,
} from "../subscription-state-store.js";

const A = "d0000000-0000-4000-8000-000000000001";
const GONE = "d0000000-0000-4000-8000-000000000003";

function makeLogger(): Logger {
	return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

let dataDir: string;
let subscriptionState: SubscriptionStateStore;
let imageStore: ImageStore;
let images: ImageWriter;
let handler: ProfileReportHandler;
let statsOn: boolean;
let appended: Array<{ key: string; followers: number }>;
let activeCalls: Array<{ key: string; kind: string }>;
let refreshed: string[][];
let order: string[];
let cron: string;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-profile-report-"));
	subscriptionState = createSubscriptionStateStore({ dataRoot: dataDir, logger: makeLogger() });
	imageStore = createImageStore({ dir: join(dataDir, "images") });
	images = imageStore.register({
		name: "订阅资料",
		listRefs: () => subscriptionState.listImageRefs(),
	});
	statsOn = true;
	cron = "*/10 * * * *";
	appended = [];
	activeCalls = [];
	refreshed = [];
	order = [];
	const fans = {
		append: vi.fn(async (key: string, sample: { followers: number }) => {
			appended.push({ key, followers: sample.followers });
		}),
		listSamplesSince: vi.fn(async () => []),
		drop: vi.fn(async () => {}),
	} as unknown as FollowersStore;
	const core = createStatsRecorderCore({
		store: {} as unknown as StatsStore,
		followers: fans,
		logger: makeLogger(),
		isEnabled: () => statsOn,
	});
	const recorder = {
		recordReportedFollowers: core.recordReportedFollowers,
		recordActive: (key: string, kind: Parameters<typeof core.recordActive>[1]) => {
			activeCalls.push({ key, kind });
			core.recordActive(key, kind);
		},
	};
	handler = createProfileReportHandler({
		bus: createNodeMessageBus(),
		subscriptionState,
		images: images as ImageWriter,
		subscriptionIds: () => [A],
		recorder,
		profileRefreshCron: () => cron,
		refreshReportedEntries: async (ids) => {
			order.push("refresh");
			refreshed.push([...ids]);
		},
		logger: makeLogger(),
		coalesceMs: 10,
	});
});

afterEach(async () => {
	handler.dispose();
	await imageStore.close();
	await rm(dataDir, { recursive: true, force: true });
});

describe("createProfileReportHandler", () => {
	it("给了哪格改哪格:没给的格沿用原来的,头像是图库引用就原样放进去", async () => {
		const put = await images.put(PNG_BYTES);
		if (!put.ok) throw new Error(put.message);
		await subscriptionState.patch(A, {
			cachedProfile: {
				name: "旧名字",
				bio: "旧简介",
				fanClubName: "旧团",
				followers: 5,
				refreshedAt: "t",
			},
		});
		handler.report([A], { name: "新名字", avatar: put.ref, followers: 9 });
		await handler.idle();
		expect(subscriptionState.get(A)?.cachedProfile).toMatchObject({
			name: "新名字",
			avatar: put.ref,
			followers: 9,
			bio: "旧简介",
			fanClubName: "旧团",
		});
		handler.report([A], { name: "新名字", bio: "新简介", fanClubName: "新团" });
		await handler.idle();
		expect(subscriptionState.get(A)?.cachedProfile).toMatchObject({
			avatar: put.ref,
			followers: 9,
			bio: "新简介",
			fanClubName: "新团",
		});
	});

	it("订阅已经不在了:不种资料、不记样本、不叫资料刷新", async () => {
		handler.report([GONE], { name: "丙", followers: 3 });
		await handler.idle();
		expect(subscriptionState.get(GONE)).toBeUndefined();
		expect(appended).toEqual([]);
		expect(refreshed).toEqual([]);
	});

	it("粉丝数按资料刷新的间隔稀释记样本:间隔内再报不再记", async () => {
		handler.report([A], { name: "甲", followers: 100 });
		await handler.idle();
		await vi.waitFor(() => expect(appended).toEqual([{ key: A, followers: 100 }]));
		handler.report([A], { name: "甲", followers: 101 });
		await handler.idle();
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(appended).toEqual([{ key: A, followers: 100 }]);
		// 资料缓存里的数不稀释,永远是最新报的。
		expect(subscriptionState.get(A)?.cachedProfile?.followers).toBe(101);
		expect(activeCalls.filter((c) => c.kind === "followers")).toHaveLength(2);
	});

	it("没报粉丝数:不记样本、不记「在记」", async () => {
		handler.report([A], { name: "甲" });
		await handler.idle();
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(appended).toEqual([]);
		expect(activeCalls).toEqual([]);
	});

	it("统计关着:资料照写,样本不记", async () => {
		statsOn = false;
		handler.report([A], { name: "甲", followers: 100 });
		await handler.idle();
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(subscriptionState.get(A)?.cachedProfile?.followers).toBe(100);
		expect(appended).toEqual([]);
	});

	it("写完当场叫资料刷新重算这几行(只叫写了的那些订阅)", async () => {
		handler.report([A, GONE], { name: "甲", followers: 1 });
		await handler.idle();
		expect(refreshed).toEqual([[A]]);
		expect(subscriptionState.get(A)?.cachedProfile?.name).toBe("甲");
	});

	it("close 之后再来的不处理", async () => {
		await handler.close();
		handler.report([A], { name: "甲" });
		await handler.idle();
		expect(subscriptionState.get(A)).toBeUndefined();
	});
});
