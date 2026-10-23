/**
 * 两条资料路共用的缓存写口(`createProfileCacheWriter`):
 * - 给了哪格换哪格,没给的沿用,粉丝团名不能被合并冲掉;
 * - 没给头像时先续期旧引用,图不在了才缺这一格;
 * - 只有名字 / 头像 / 粉丝变了才叫面板,签名不算;
 * - 变了的订阅 id 在窗口尾沿合并、一次发出。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createNodeMessageBus } from "../message-bus.js";
import { createProfileCacheWriter, type ProfileCacheWriter } from "../profile-cache.js";
import { createSubRuntimeStore, type SubRuntimeStore } from "../sub-runtime-store.js";

const A = "b0000000-0000-4000-8000-000000000001";
const OLD_AVATAR = `${"a".repeat(64)}.png`;

function makeLogger(): Logger {
	return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

let dataDir: string;
let bus: ReturnType<typeof createNodeMessageBus>;
let subRuntime: SubRuntimeStore;
let keep: ReturnType<typeof vi.fn<(ref: string) => Promise<boolean>>>;
let writer: ProfileCacheWriter;
let announced: string[][];

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-profile-cache-"));
	bus = createNodeMessageBus();
	subRuntime = createSubRuntimeStore({ dataRoot: dataDir, logger: makeLogger() });
	keep = vi.fn(async () => true);
	writer = createProfileCacheWriter({
		bus,
		subRuntime,
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
	await subRuntime.close();
	vi.useRealTimers();
	await rm(dataDir, { recursive: true, force: true });
});

describe("profile-cache", () => {
	it("给了哪格换哪格;没给的名字、头像、签名、粉丝和粉丝团名都沿用", async () => {
		await subRuntime.patch(A, {
			cachedProfile: {
				name: "旧名字",
				avatar: OLD_AVATAR,
				avatarUrl: "https://example.com/avatar.png",
				sign: "旧签名",
				fans: 1,
				fanClubName: "旧粉丝团",
				lastRefreshedAt: "old",
			},
		});

		expect(await writer.write(A, { name: "新名字" })).toBe(true);
		expect(subRuntime.get(A)?.cachedProfile).toMatchObject({
			name: "新名字",
			avatar: OLD_AVATAR,
			avatarUrl: "https://example.com/avatar.png",
			sign: "旧签名",
			fans: 1,
			fanClubName: "旧粉丝团",
		});

		expect(await writer.write(A, { sign: "新签名", fans: 2, fanClubName: "新粉丝团" })).toBe(true);
		expect(subRuntime.get(A)?.cachedProfile).toMatchObject({
			name: "新名字",
			avatar: OLD_AVATAR,
			avatarUrl: "https://example.com/avatar.png",
			sign: "新签名",
			fans: 2,
			fanClubName: "新粉丝团",
		});
		expect(subRuntime.get(A)?.cachedProfile?.lastRefreshedAt).not.toBe("old");
	});

	it("头像没给时续期后沿用;图不在了就缺这一格", async () => {
		await subRuntime.patch(A, {
			cachedProfile: { name: "甲", avatar: OLD_AVATAR, sign: "", lastRefreshedAt: "old" },
		});
		await writer.write(A, { name: "新甲" });
		expect(keep).toHaveBeenCalledWith(OLD_AVATAR);
		expect(subRuntime.get(A)?.cachedProfile?.avatar).toBe(OLD_AVATAR);

		const B = "b0000000-0000-4000-8000-000000000002";
		await subRuntime.patch(B, {
			cachedProfile: { name: "乙", avatar: OLD_AVATAR, sign: "", lastRefreshedAt: "old" },
		});
		keep.mockResolvedValueOnce(false);
		await writer.write(B, { name: "新乙" });
		expect(subRuntime.get(B)?.cachedProfile).not.toHaveProperty("avatar");
	});

	it("名字、头像、粉丝变了回 true;只改签名回 false", async () => {
		await subRuntime.patch(A, {
			cachedProfile: { name: "甲", sign: "", fans: 1, lastRefreshedAt: "old" },
		});

		expect(await writer.write(A, { fans: 2 })).toBe(true);
		expect(await writer.write(A, { avatar: OLD_AVATAR })).toBe(true);
		expect(await writer.write(A, { sign: "新签名" })).toBe(false);
	});

	it("没有旧资料又没给名字、签名、粉丝时,写空串但不写假的 0", async () => {
		expect(await writer.write(A, {})).toBe(true);
		const profile = subRuntime.get(A)?.cachedProfile;
		expect(profile).toMatchObject({ name: "", sign: "" });
		expect(profile).not.toHaveProperty("fans");
		expect(profile).not.toHaveProperty("avatar");
		expect(profile).not.toHaveProperty("fanClubName");
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
