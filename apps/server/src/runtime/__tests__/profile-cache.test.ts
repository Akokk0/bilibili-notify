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
import type { Logger } from "@bilibili-notify/internal";
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

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-profile-cache-"));
	bus = createNodeMessageBus();
	subscriptionState = createSubscriptionStateStore({ dataRoot: dataDir, logger: makeLogger() });
	keep = vi.fn(async () => true);
	writer = createProfileCacheWriter({
		bus,
		subscriptionState,
		images: { keep },
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
