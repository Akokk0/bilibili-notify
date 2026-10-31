/**
 * 女仆的中立读工具(资料 / 最近作品 / 统计)在服务端的读口实现:`attachReadOnlyTools` 递给生成器的读口上的
 * `profile` / `recentPosts` / `stats`,与它背后的统计读口 `createCreatorStatsReader`。
 *
 * 钉住的是:按 `creator`(来源键:外部 id)找**启用着的**订阅;资料优先读缓存,来源没接上时 `not_found`;
 * 作品与统计在统计总开关关着时回 `not_configured`(资料不受总开关管:缓存本来就在);统计走真的统计仓与
 * 总览读口的一行。
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StatsOverviewResponse, UpStatsRow } from "@bilibili-notify/contract";
import { makeEmptySubscription, type Result } from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { noProfile } from "../../__tests__/support/no-candidates.js";
import { createStatsStore, type StatsStore } from "../../stats/store.js";
import { createCreatorStatsReader } from "../creator-stats.js";
import { attachReadOnlyTools } from "../read-only-tools.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const ALICE = makeEmptySubscription({
	id: "sub-alice",
	identity: { sourceKey: "acme", externalId: "alice-ext" },
});
const BOB_OFF = {
	...makeEmptySubscription({
		id: "sub-bob",
		identity: { sourceKey: "acme", externalId: "bob-ext" },
	}),
	enabled: false,
};

type Profiles = Record<string, { name?: string; followers?: number; bio?: string }>;

function readerOf(opts: {
	profiles?: Profiles;
	stats?: Parameters<typeof attachReadOnlyTools>[1]["stats"];
}) {
	const setCreatorReader = vi.fn();
	attachReadOnlyTools(
		{ setCreatorReader, setProvidedTools: vi.fn() },
		{
			timezone: () => "Asia/Shanghai",
			subscriptionStore: { list: () => [ALICE, BOB_OFF] },
			subscriptionStateStore: {
				get: (id: string) =>
					opts.profiles?.[id] ? { cachedProfile: opts.profiles[id] } : undefined,
			},
			platformLabel: (key: string) => key,
			identityLabel: (identity) => identity.externalId,
			sources: { get: () => undefined },
			searchCreators: async () => ({ ok: true, candidates: [] }),
			fetchProfile: (identity) => noProfile(identity, new AbortController().signal),
			providedTools: () => [],
			...(opts.stats ? { stats: opts.stats } : {}),
		},
	);
	return setCreatorReader.mock.calls[0]?.[0] as {
		profile(creator: string): Promise<Result<{ profile: Record<string, unknown> }>>;
		recentPosts(creator: string, limit: number): Promise<Result<{ posts: unknown[] }>>;
		stats(creator: string, days: number): Promise<Result<{ stats: Record<string, unknown> }>>;
	};
}

describe("reader.profile —— 只读资料缓存", () => {
	it("订阅着的人:缓存里的名字、粉丝数、简介;缺的格不带", async () => {
		const reader = readerOf({
			profiles: { "sub-alice": { name: "爱丽丝", followers: 99, bio: "简介" } },
		});
		expect(await reader.profile("acme:alice-ext")).toEqual({
			ok: true,
			profile: { name: "爱丽丝", followers: 99, bio: "简介" },
		});
		const bare = readerOf({ profiles: { "sub-alice": { name: "只有名字" } } });
		expect(await bare.profile("acme:alice-ext")).toEqual({
			ok: true,
			profile: { name: "只有名字" },
		});
	});

	// 验红:让停用订阅的缓存也答出来,第二条红。
	it("没订阅的人、停用的订阅、来源不在登记表 → not_found", async () => {
		const reader = readerOf({ profiles: { "sub-bob": { name: "停用的" } } });
		expect(await reader.profile("acme:nobody")).toMatchObject({ ok: false, code: "not_found" });
		expect(await reader.profile("acme:bob-ext")).toMatchObject({ ok: false, code: "not_found" });
		expect(await reader.profile("acme:alice-ext")).toMatchObject({ ok: false, code: "not_found" });
	});

	it("资料不受统计总开关管(缓存本来就在)", async () => {
		const reader = readerOf({
			profiles: { "sub-alice": { name: "爱丽丝" } },
			stats: {
				isEnabled: () => false,
				recentPosts: async () => [],
				statsRow: async () => undefined,
			},
		});
		expect(await reader.profile("acme:alice-ext")).toMatchObject({ ok: true });
	});
});

describe("reader.recentPosts / reader.stats —— 统计总开关与订阅", () => {
	const stats = (enabled: boolean) => ({
		isEnabled: () => enabled,
		recentPosts: vi.fn(async () => [{ publishedAt: "2026-10-01T00:00:00.000Z", title: "标题" }]),
		statsRow: vi.fn(async () => undefined),
	});

	// 验红:去掉总开关判断,这条红。
	it("总开关关着 → not_configured,话里说去哪开;不去碰统计仓", async () => {
		const s = stats(false);
		const reader = readerOf({ stats: s });
		const posts = await reader.recentPosts("acme:alice-ext", 5);
		const rows = await reader.stats("acme:alice-ext", 30);
		expect(posts).toMatchObject({ ok: false, code: "not_configured" });
		expect(rows).toMatchObject({ ok: false, code: "not_configured" });
		expect(s.recentPosts).not.toHaveBeenCalled();
		expect(s.statsRow).not.toHaveBeenCalled();
	});

	it("没订阅 / 停用的 → not_found(先于统计)", async () => {
		const reader = readerOf({ stats: stats(true) });
		for (const creator of ["acme:nobody", "acme:bob-ext"]) {
			expect(await reader.recentPosts(creator, 5)).toMatchObject({ ok: false, code: "not_found" });
			expect(await reader.stats(creator, 30)).toMatchObject({ ok: false, code: "not_found" });
		}
	});

	it("没接统计读口 → unavailable", async () => {
		const reader = readerOf({});
		expect(await reader.recentPosts("acme:alice-ext", 5)).toMatchObject({
			ok: false,
			code: "unavailable",
		});
		expect(await reader.stats("acme:alice-ext", 30)).toMatchObject({
			ok: false,
			code: "unavailable",
		});
	});

	it("统计行对不上(刚订阅、总览还没这一行)→ not_found", async () => {
		const reader = readerOf({ stats: stats(true) });
		expect(await reader.stats("acme:alice-ext", 30)).toMatchObject({
			ok: false,
			code: "not_found",
		});
	});
});

describe("createCreatorStatsReader —— 真的统计仓与总览读口", () => {
	let store: StatsStore;
	beforeEach(async () => {
		store = createStatsStore({
			dataRoot: await mkdtemp(join(tmpdir(), "bn-creator-stats-")),
			logger,
		});
	});

	const overviewWith = (rows: Partial<UpStatsRow>[]) =>
		vi.fn(async (_days: number, _tz: number) => ({ rows }) as unknown as StatsOverviewResponse);

	it("最近作品:按订阅 id 的文件键读,新的在前、取 limit 条,只交时间、标题、摘要", async () => {
		await store.appendPost("sub-alice", {
			id: "p1",
			hasVideo: false,
			publishedAt: "2026-09-01T00:00:00.000Z",
			title: "旧的",
		});
		await store.appendPost("sub-alice", {
			id: "p2",
			hasVideo: true,
			publishedAt: "2026-10-01T00:00:00.000Z",
			title: "新的",
			summary: "摘要",
			url: "https://acme.invalid/p2",
		});
		await store.appendPost("sub-bob", {
			id: "p3",
			hasVideo: false,
			publishedAt: "2026-10-02T00:00:00.000Z",
			title: "别人的",
		});
		const reader = createCreatorStatsReader({
			store,
			isEnabled: () => true,
			timezone: () => "Asia/Kolkata",
			overview: overviewWith([]),
		});
		expect(await reader.recentPosts("sub-alice", 5)).toEqual([
			{ publishedAt: "2026-10-01T00:00:00.000Z", title: "新的", summary: "摘要" },
			{ publishedAt: "2026-09-01T00:00:00.000Z", title: "旧的" },
		]);
		expect(await reader.recentPosts("sub-alice", 1)).toHaveLength(1);
		expect(await reader.recentPosts("sub-nobody", 5)).toEqual([]);
	});

	it("统计:用统计总览读口(天数、全局时区偏移),取这条订阅那一行,挑出要的几格", async () => {
		const overview = overviewWith([
			{ subscriptionId: "sub-other", posts: 1 },
			{
				subscriptionId: "sub-alice",
				followers: 500,
				netWindow: 20,
				posts: 6,
				videoPosts: 2,
				liveSessions: 1,
				liveHours: 2.5,
				lastActivityAt: "2026-10-03T00:00:00.000Z",
				series: [1, 2],
			},
		]);
		const reader = createCreatorStatsReader({
			store,
			isEnabled: () => true,
			timezone: () => "Asia/Kolkata",
			overview,
		});
		expect(await reader.statsRow("sub-alice", 14)).toEqual({
			followers: 500,
			netWindow: 20,
			posts: 6,
			videoPosts: 2,
			liveSessions: 1,
			liveHours: 2.5,
			lastActivityAt: "2026-10-03T00:00:00.000Z",
		});
		expect(overview).toHaveBeenCalledWith(14, -330);
		expect(await reader.statsRow("sub-nobody", 14)).toBeUndefined();
	});

	// 验红:isEnabled 改成读一次就缓存死的快照,这条红(见 stats/__tests__/enabled-switch.test.ts 的缓存读口)。
	it("总开关每次现问,不留快照", () => {
		let on = true;
		const reader = createCreatorStatsReader({
			store,
			isEnabled: () => on,
			timezone: () => "Asia/Kolkata",
			overview: overviewWith([]),
		});
		expect(reader.isEnabled()).toBe(true);
		on = false;
		expect(reader.isEnabled()).toBe(false);
	});
});
