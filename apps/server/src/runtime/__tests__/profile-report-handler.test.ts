/**
 * 来源经 `ctx.reportProfile` 报的资料落盘(`createProfileReportHandler`,3b-42):
 * 给了哪格改哪格、粉丝数按资料刷新间隔稀释记样本(统计关着不记)、写完当场叫资料刷新重算这几行。
 * 头像已经是图库引用(来源先 `storeImage` 存好),这里不再收字节。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger, Subscription } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PNG_BYTES } from "../../__tests__/support/avatar-fixtures.js";
import type { FollowersStore } from "../../followers/store.js";
import { createImageStore, type ImageStore, type ImageWriter } from "../../images/image-store.js";
import { statsFileKey } from "../../stats/file-key.js";
import { createStatsRecorderCore } from "../../stats/recorder.js";
import type { StatsStore } from "../../stats/store.js";
import { createNodeMessageBus } from "../message-bus.js";
import { createProfileCacheWriter, type ProfileCacheWriter } from "../profile-cache.js";
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
let writer: ProfileCacheWriter;
let handler: ProfileReportHandler;
/** 此刻还在的订阅(现查);R18 那条测试在写到一半时把 A 摘掉。 */
let subs: Map<string, Subscription>;
/** 卡住某张头像的续期(`keep`)的闸;没挂就是立即放行。 */
let hold: { ref: string; gate: Promise<void> } | undefined;
/** 假的图库续期口:挂在 writer 上,测试等它被调到来确认写到了哪一条。 */
let keep: ReturnType<typeof vi.fn<(ref: string) => Promise<boolean>>>;
/** 删订阅那一步调记录器:`core.drop`,与 `stats/recorder.ts` 的删订阅监听同一口径。 */
let drop: (key: string) => void;
let statsOn: boolean;
let appended: Array<{ key: string; followers: number }>;
/** 「在记」落到统计仓的行(假的统计仓会像真的一样被 `drop` 删掉)。 */
let activeRows: Array<{ key: string; kind: string }>;
/** 记录器被叫「记在记」的次数(一小时同一项只在仓里落一行,次数与行数不是一回事)。 */
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
	activeRows = [];
	activeCalls = [];
	refreshed = [];
	order = [];
	hold = undefined;
	subs = new Map([[A, { id: A, enabled: true } as Subscription]]);
	keep = vi.fn(async (ref: string) => {
		if (hold?.ref === ref) await hold.gate;
		return true;
	});
	const fans = {
		append: vi.fn(async (key: string, sample: { followers: number }) => {
			appended.push({ key, followers: sample.followers });
		}),
		listSamplesSince: vi.fn(async () => []),
		// 像真仓删文件一样(按订阅 id 的粉丝文件):`drop` 之后再追加才会留下,之前的被一起删掉。
		drop: vi.fn(async (key: string) => removeKey(appended, key)),
	} as unknown as FollowersStore;
	// 统计仓也照真的:删掉这个键的行,之后才落地的行才会留下。
	const store = {
		listRecording: vi.fn(async () => []),
		appendRecording: vi.fn(async (key: string, row: { kind: string }) => {
			activeRows.push({ key, kind: row.kind });
		}),
		drop: vi.fn(async (key: string) => removeKey(activeRows, key)),
	} as unknown as StatsStore;
	const core = createStatsRecorderCore({
		store,
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
	writer = createProfileCacheWriter({
		bus: createNodeMessageBus(),
		subscriptionState,
		images: { keep },
		subscription: (id) => subs.get(id),
		logger: makeLogger(),
		coalesceMs: 10,
	});
	handler = createProfileReportHandler({
		profileCache: writer,
		subscription: (id) => subs.get(id),
		recorder,
		profileRefreshCron: () => cron,
		refreshReportedEntries: async (ids) => {
			order.push("refresh");
			refreshed.push([...ids]);
		},
		logger: makeLogger(),
	});
	drop = (key: string) => core.drop(key);
});

afterEach(async () => {
	handler.dispose();
	writer.dispose();
	await imageStore.close();
	await rm(dataDir, { recursive: true, force: true });
});

/** 把某个键的行从假仓里删掉(假仓的「删文件」)。 */
function removeKey<T extends { key: string }>(rows: T[], key: string): void {
	for (let i = rows.length - 1; i >= 0; i--) if (rows[i]?.key === key) rows.splice(i, 1);
}

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
		expect(activeCalls.filter((call) => call.kind === "followers")).toHaveLength(2);
	});

	it("上报展开成两条、一条写到一半时另一条被删:放闸后不再给它记样本与「在记」", async () => {
		const B = "d0000000-0000-4000-8000-000000000002";
		const A_AVATAR = `${"a".repeat(64)}.png`;
		const B_AVATAR = `${"b".repeat(64)}.png`;
		subs.set(B, { id: B, enabled: true } as Subscription);
		await subscriptionState.patch(A, {
			cachedProfile: { name: "甲", avatar: A_AVATAR, refreshedAt: "t" },
		});
		await subscriptionState.patch(B, {
			cachedProfile: { name: "乙", avatar: B_AVATAR, refreshedAt: "t" },
		});

		// A 先写、立即放行;B 卡住,趁这个窗口把 A 删掉并排上 `drop`。
		let release!: () => void;
		hold = {
			ref: B_AVATAR,
			gate: new Promise<void>((resolve) => {
				release = resolve;
			}),
		};
		handler.report([A, B], { name: "n", followers: 9 });
		await vi.waitFor(() => expect(keep).toHaveBeenCalledWith(B_AVATAR));

		subs.delete(A);
		drop(statsFileKey({ id: A }));
		release();
		await handler.idle();
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(appended.filter((sample) => sample.key === statsFileKey({ id: A }))).toEqual([]);
		expect(activeRows.filter((row) => row.key === statsFileKey({ id: A }))).toEqual([]);
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
