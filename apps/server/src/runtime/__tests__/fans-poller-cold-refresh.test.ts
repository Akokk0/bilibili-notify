/**
 * ⑥ 批量冷刷 name/avatar:启动时用批量 user/cards(一发)刷新已 seed 的
 * cachedProfile 的昵称/头像,替代过去每 tick 逐 UP 拉整张 card 里那份从未在
 * 稳态被消费的 name/avatar。只更 name/avatar,fans 保留。
 */

import { type GlobalConfig, ok } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { fakeProfileImages, PROFILE_IMAGE_REF } from "../../__tests__/support/profile-images.js";

const cronMock = vi.hoisted(() => {
	const instances: Array<{ cronTime: string; onTick: () => void }> = [];
	class FakeCronJob {
		isActive = false;
		constructor(
			public cronTime: string,
			public onTick: () => void,
		) {
			instances.push(this);
		}
		start(): void {
			this.isActive = true;
		}
		stop(): void {
			this.isActive = false;
		}
	}
	return { instances, FakeCronJob };
});
vi.mock("cron", () => ({ CronJob: cronMock.FakeCronJob }));

const { startFansPoller } = await import("../fans-poller.js");
const { createNodeMessageBus } = await import("../message-bus.js");

const GLOBALS = { profileRefreshCron: "*/10 * * * *" } as unknown as GlobalConfig;
const subOf = (n: number) => ({
	id: `s${n}`,
	identity: { sourceKey: "bilibili", externalId: String(n) },
	enabled: true,
});
type Profile = Record<string, unknown>;
type PatchCall = [string, { cachedProfile?: Profile }];

let handle: { dispose(): void } | undefined;

beforeEach(() => {
	cronMock.instances.length = 0;
	vi.restoreAllMocks();
});
afterEach(() => {
	handle?.dispose();
	handle = undefined;
});

/**
 * 起一个粉丝轮询,只看启动时那一次冷刷。`profiles` 是订阅 id → 资料缓存(patch 会写回它,和真仓一样);
 * `cards` 是批量端点回的「uid → { name, face }」。
 */
function startWith(opts: {
	profiles: Record<string, Profile>;
	cards: Record<string, { name: string; face?: string }>;
	images?: ReturnType<typeof fakeProfileImages>;
}) {
	const profiles = opts.profiles;
	const subs = Object.keys(profiles).map((id) => subOf(Number(id.slice(1))));
	const rtPatch = vi.fn(async (id: string, partial: { cachedProfile?: Profile }) => {
		if (partial.cachedProfile) profiles[id] = partial.cachedProfile;
	});
	const fetchUserCards = vi.fn(async () => ({
		code: 0,
		data: Object.fromEntries(
			Object.entries(opts.cards).map(([uid, card]) => [uid, { mid: uid, ...card }]),
		),
	}));
	const images = opts.images ?? fakeProfileImages();
	handle = startFansPoller({
		images,
		isStatsEnabled: () => true,
		bus: createNodeMessageBus(),
		logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
		configStore: { getGlobals: () => GLOBALS, patchSubscription: vi.fn() } as never,
		subscriptionStore: { list: () => subs } as never,
		subRuntimeStore: {
			get: vi.fn((id: string) =>
				profiles[id] ? { cachedProfile: { ...profiles[id] } } : undefined,
			),
			getAll: () => ({}),
			patch: rtPatch,
			prune: vi.fn(async () => {}),
			load: vi.fn(async () => {}),
		} as never,
		fansStore: {
			append: vi.fn(async () => {}),
			findNearestBefore: vi.fn(async () => null),
			findEarliest: vi.fn(async () => undefined),
			drop: vi.fn(async () => {}),
		} as never,
		api: {
			fetchUserCards,
			// 冷刷后首轮 tick 会走 relation/stat —— 给个稳定返回,避免未 mock 抛错。
			fetchRelationStat: vi.fn(async () => ({ code: 0, data: { follower: 100 } })),
			fetchUserCard: vi.fn(),
		} as never,
		// 即时触发 3s 门,让启动流程一路跑到冷刷 + 首轮 tick。
		serviceCtx: {
			setTimeout: vi.fn((cb: () => void) => {
				cb();
				return undefined;
			}),
			setInterval: vi.fn(() => undefined),
			track: vi.fn(),
			signal: new AbortController().signal,
		} as never,
	});
	return { profiles, rtPatch, fetchUserCards, images };
}

const PROFILE_OF = (extra: Profile = {}): Profile => ({
	name: "旧名",
	sign: "s",
	fans: 100,
	lastRefreshedAt: "x",
	...extra,
});

describe("⑥ 启动批量冷刷 name/avatar", () => {
	it("批量端点回新昵称/新头像 → 名字更新、头像抓进图库(avatar + 来源地址 avatarUrl),fans 不动", async () => {
		const run = startWith({
			profiles: { s1: PROFILE_OF({ avatarUrl: "https://example.com/old.png" }) },
			cards: { "1": { name: "新名", face: "https://example.com/new.png" } },
		});
		await vi.waitFor(() => expect(run.fetchUserCards).toHaveBeenCalledWith(["1"]), {
			timeout: 2000,
			interval: 10,
		});
		await vi.waitFor(
			() =>
				expect(run.profiles.s1).toMatchObject({
					name: "新名",
					avatar: PROFILE_IMAGE_REF,
					avatarUrl: "https://example.com/new.png",
					fans: 100,
				}),
			{ timeout: 2000, interval: 10 },
		);
		expect(run.images.fetchImage).toHaveBeenCalledTimes(1);
	});

	it("地址没变且已有 avatar → 零网络,名字也没变就不写盘", async () => {
		const run = startWith({
			profiles: {
				s1: PROFILE_OF({
					name: "名",
					avatar: PROFILE_IMAGE_REF,
					avatarUrl: "https://example.com/a.png",
				}),
			},
			cards: { "1": { name: "名", face: "https://example.com/a.png" } },
		});
		await vi.waitFor(() => expect(run.fetchUserCards).toHaveBeenCalled(), {
			timeout: 2000,
			interval: 10,
		});
		await new Promise((r) => setTimeout(r, 100));
		expect(run.images.fetchImage).not.toHaveBeenCalled();
		// 冷刷的写保留原来的 lastRefreshedAt("x");首轮 tick 的写会换成当下时间。
		const coldPatches = (run.rtPatch.mock.calls as unknown as PatchCall[]).filter(
			(c) => c[1].cachedProfile?.lastRefreshedAt === "x",
		);
		expect(coldPatches).toHaveLength(0);
	});

	it("老资料只有 avatarUrl(没有 avatar)→ 冷刷补上头像", async () => {
		const run = startWith({
			profiles: { s1: PROFILE_OF({ name: "名", avatarUrl: "https://example.com/a.png" }) },
			cards: { "1": { name: "名", face: "https://example.com/a.png" } },
		});
		await vi.waitFor(() => expect(run.profiles.s1).toMatchObject({ avatar: PROFILE_IMAGE_REF }), {
			timeout: 2000,
			interval: 10,
		});
		expect(run.profiles.s1).toMatchObject({ avatarUrl: "https://example.com/a.png", fans: 100 });
	});

	it("批量端点没给头像地址、资料里记着地址却没有 avatar → 用记着的地址补", async () => {
		const run = startWith({
			profiles: { s1: PROFILE_OF({ name: "名", avatarUrl: "https://example.com/a.png" }) },
			cards: { "1": { name: "名" } },
		});
		await vi.waitFor(() => expect(run.profiles.s1).toMatchObject({ avatar: PROFILE_IMAGE_REF }), {
			timeout: 2000,
			interval: 10,
		});
	});

	it("抓头像最多同时 3 张", async () => {
		let inFlight = 0;
		let peak = 0;
		const release: Array<() => void> = [];
		const images = {
			fetchImage: vi.fn(async () => {
				inFlight++;
				peak = Math.max(peak, inFlight);
				await new Promise<void>((resolve) => release.push(resolve));
				inFlight--;
				return ok({ ref: PROFILE_IMAGE_REF });
			}),
		};
		const ids = [1, 2, 3, 4, 5, 6, 7];
		startWith({
			profiles: Object.fromEntries(
				ids.map((n) => [
					`s${n}`,
					PROFILE_OF({ name: "名", avatarUrl: `https://example.com/${n}.png` }),
				]),
			),
			cards: Object.fromEntries(ids.map((n) => [String(n), { name: "名" }])),
			images: images as never,
		});
		await vi.waitFor(() => expect(inFlight).toBe(3), { timeout: 2000, interval: 10 });
		// 放行到全部抓完:任何时刻都不超过 3。
		await vi.waitFor(
			() => {
				for (const done of release.splice(0)) done();
				expect(images.fetchImage).toHaveBeenCalledTimes(7);
			},
			{ timeout: 2000, interval: 10 },
		);
		expect(peak).toBe(3);
	});

	it("某张头像一直抓不回来,也不拖住名字的更新", async () => {
		const images = { fetchImage: vi.fn(() => new Promise<never>(() => {})) };
		const run = startWith({
			profiles: { s1: PROFILE_OF({ avatarUrl: "https://example.com/old.png" }) },
			cards: { "1": { name: "新名", face: "https://example.com/new.png" } },
			images: images as never,
		});
		await vi.waitFor(() => expect(run.profiles.s1).toMatchObject({ name: "新名" }), {
			timeout: 2000,
			interval: 10,
		});
		expect(images.fetchImage).toHaveBeenCalled();
	});
});
