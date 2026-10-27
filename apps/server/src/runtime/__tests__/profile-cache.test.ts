/**
 * 两条资料路共用的缓存写口(`createProfileCacheWriter`):
 * - 给了哪格换哪格,没给的沿用,粉丝团名不能被合并冲掉;
 * - 没给头像时先续期旧引用,图不在了才缺这一格;
 * - 只有名字 / 头像 / 粉丝变了才叫面板,简介不算;
 * - 变了的订阅 id 在窗口尾沿合并、一次发出。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger, Subscription } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createNodeMessageBus } from "../message-bus.js";
import { createProfileCacheWriter, type ProfileCacheWriter } from "../profile-cache.js";
import {
	createSubscriptionStateStore,
	type SubscriptionStateStore,
} from "../subscription-state-store.js";

const A = "b0000000-0000-4000-8000-000000000001";
const OLD_AVATAR = `${"a".repeat(64)}.png`;

function makeLogger(): Logger {
	return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

let dataDir: string;
let bus: ReturnType<typeof createNodeMessageBus>;
let subscriptionState: SubscriptionStateStore;
let keep: ReturnType<typeof vi.fn<(ref: string) => Promise<boolean>>>;
let writer: ProfileCacheWriter;
let announced: string[][];
/** 已经被删掉的订阅;写口提交前现查它。默认谁都在,删订阅的测试把 id 加进来。 */
let gone: Set<string>;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-profile-cache-"));
	bus = createNodeMessageBus();
	subscriptionState = createSubscriptionStateStore({ dataRoot: dataDir, logger: makeLogger() });
	keep = vi.fn(async () => true);
	gone = new Set();
	writer = createProfileCacheWriter({
		bus,
		subscriptionState,
		images: { keep },
		subscription: (id) => (gone.has(id) ? undefined : ({ id } as Subscription)),
		logger: makeLogger(),
		coalesceMs: 30,
	});
	announced = [];
	bus.on("subscription-profiles-changed", ({ subscriptionIds }) => {
		announced.push([...subscriptionIds]);
	});
});

afterEach(async () => {
	writer.dispose();
	await subscriptionState.close();
	vi.useRealTimers();
	await rm(dataDir, { recursive: true, force: true });
});

describe("profile-cache", () => {
	it("给了哪格换哪格;没给的名字、头像、简介、粉丝和粉丝团名都沿用", async () => {
		await subscriptionState.patch(A, {
			cachedProfile: {
				name: "旧名字",
				avatar: OLD_AVATAR,
				bio: "旧简介",
				followers: 1,
				fanClubName: "旧粉丝团",
				refreshedAt: "old",
			},
		});

		expect(await writer.write(A, { name: "新名字" })).toBe(true);
		expect(subscriptionState.get(A)?.cachedProfile).toMatchObject({
			name: "新名字",
			avatar: OLD_AVATAR,
			bio: "旧简介",
			followers: 1,
			fanClubName: "旧粉丝团",
		});

		expect(await writer.write(A, { bio: "新简介", followers: 2, fanClubName: "新粉丝团" })).toBe(
			true,
		);
		expect(subscriptionState.get(A)?.cachedProfile).toMatchObject({
			name: "新名字",
			avatar: OLD_AVATAR,
			bio: "新简介",
			followers: 2,
			fanClubName: "新粉丝团",
		});
		expect(subscriptionState.get(A)?.cachedProfile?.refreshedAt).not.toBe("old");
	});

	it("头像没给时续期后沿用;图不在了就缺这一格", async () => {
		await subscriptionState.patch(A, {
			cachedProfile: { name: "甲", avatar: OLD_AVATAR, refreshedAt: "old" },
		});
		await writer.write(A, { name: "新甲" });
		expect(keep).toHaveBeenCalledWith(OLD_AVATAR);
		expect(subscriptionState.get(A)?.cachedProfile?.avatar).toBe(OLD_AVATAR);

		const B = "b0000000-0000-4000-8000-000000000002";
		await subscriptionState.patch(B, {
			cachedProfile: { name: "乙", avatar: OLD_AVATAR, refreshedAt: "old" },
		});
		keep.mockResolvedValueOnce(false);
		await writer.write(B, { name: "新乙" });
		expect(subscriptionState.get(B)?.cachedProfile).not.toHaveProperty("avatar");
	});

	it("名字、头像、粉丝变了回 true;只改简介回 false", async () => {
		await subscriptionState.patch(A, {
			cachedProfile: { name: "甲", followers: 1, refreshedAt: "old" },
		});

		expect(await writer.write(A, { followers: 2 })).toBe(true);
		expect(await writer.write(A, { avatar: OLD_AVATAR })).toBe(true);
		expect(await writer.write(A, { bio: "新简介" })).toBe(false);
	});

	it("没有旧资料又没给名字、简介、粉丝时,只写空名字与刷新时间,不写假的 0", async () => {
		expect(await writer.write(A, {})).toBe(true);
		const profile = subscriptionState.get(A)?.cachedProfile;
		expect(profile).toMatchObject({ name: "" });
		expect(profile?.refreshedAt).toBeTypeOf("string");
		expect(profile).not.toHaveProperty("bio");
		expect(profile).not.toHaveProperty("followers");
		expect(profile).not.toHaveProperty("avatar");
		expect(profile).not.toHaveProperty("fanClubName");
	});

	it("空简介不是一格数据,bio 为空串时结果里没有 bio", async () => {
		await writer.write(A, { name: "甲", bio: "旧简介" });
		await writer.write(A, { bio: "" });
		expect(subscriptionState.get(A)?.cachedProfile).not.toHaveProperty("bio");
	});

	it("同一个 writer 的两次 write 交错:后一条不拿前一条的旧资料整份盖回去", async () => {
		const NEW_AVATAR = `${"c".repeat(64)}.png`;
		await subscriptionState.patch(A, {
			cachedProfile: { name: "旧名字", avatar: OLD_AVATAR, refreshedAt: "old" },
		});

		// 先发的那条没带头像 → 卡在「续期旧头像」;后发的那条带着新头像与粉丝团名。
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		keep.mockImplementation(async () => {
			await gate;
			return true;
		});

		const first = writer.write(A, { name: "拉的" });
		const second = writer.write(A, { name: "报的", avatar: NEW_AVATAR, fanClubName: "团" });
		release();
		await Promise.all([first, second]);

		expect(subscriptionState.get(A)?.cachedProfile).toMatchObject({
			name: "报的",
			avatar: NEW_AVATAR,
			fanClubName: "团",
		});
	});

	it("写到一半订阅被删并 prune:放闸后不留孤儿资料", async () => {
		await subscriptionState.patch(A, {
			cachedProfile: { name: "甲", avatar: OLD_AVATAR, refreshedAt: "old" },
		});

		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		keep.mockImplementation(async () => {
			await gate;
			return true;
		});

		const pending = writer.write(A, { name: "拉的" });
		await vi.waitFor(() => expect(keep).toHaveBeenCalledWith(OLD_AVATAR));
		gone.add(A);
		await subscriptionState.prune([]);
		release();
		await pending;

		expect(subscriptionState.get(A)).toBeUndefined();
	});

	it("窗口里两次 announce 合成一次,同一订阅只出现一次", () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

		writer.announce([A]);
		writer.announce([A]);
		vi.advanceTimersByTime(29);
		expect(announced).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(announced).toEqual([[A]]);
		vi.advanceTimersByTime(100);
		expect(announced).toEqual([[A]]);
	});

	it("announce([]) 不发事件", () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

		writer.announce([]);
		vi.advanceTimersByTime(100);
		expect(announced).toEqual([]);
	});
});

describe("profile-cache 新建时种资料(seed)", () => {
	it("这条订阅还没有资料 → 种下,回 true;build 跑一次", async () => {
		const build = vi.fn(async () => ({ name: "候选", avatar: OLD_AVATAR, followers: 42 }));

		expect(await writer.seed(A, build)).toBe(true);
		expect(build).toHaveBeenCalledTimes(1);
		const profile = subscriptionState.get(A)?.cachedProfile;
		expect(profile).toMatchObject({ name: "候选", avatar: OLD_AVATAR, followers: 42 });
		expect(profile?.refreshedAt).toBeTypeOf("string");
	});

	it("已经有资料(拓展先报了)→ 不动,回 false;build 不跑,头像不存", async () => {
		await subscriptionState.patch(A, { cachedProfile: { name: "先报的", refreshedAt: "old" } });
		const build = vi.fn(async () => ({ name: "候选" }));

		expect(await writer.seed(A, build)).toBe(false);
		expect(build).not.toHaveBeenCalled();
		expect(subscriptionState.get(A)?.cachedProfile).toEqual({
			name: "先报的",
			refreshedAt: "old",
		});
	});

	it("排在同一订阅先排进来的写后面:先报的那次写完,种资料看见了就不动", async () => {
		const reported = writer.write(A, { name: "先报的" });
		const build = vi.fn(async () => ({ name: "候选" }));
		const seeded = writer.seed(A, build);

		expect(await reported).toBe(true);
		expect(await seeded).toBe(false);
		expect(build).not.toHaveBeenCalled();
		expect(subscriptionState.get(A)?.cachedProfile?.name).toBe("先报的");
	});

	it("订阅已经删了 → 不种,build 不跑", async () => {
		gone.add(A);
		const build = vi.fn(async () => ({ name: "候选" }));

		expect(await writer.seed(A, build)).toBe(false);
		expect(build).not.toHaveBeenCalled();
		expect(subscriptionState.get(A)).toBeUndefined();
	});
});
