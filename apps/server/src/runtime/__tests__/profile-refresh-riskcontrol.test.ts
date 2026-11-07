/**
 * ① profileRefreshCron 解耦 + ② 单条资料失败不阻断别的订阅。
 *
 * ①:ProfileRefresh 的 cron 取 `globals.profileRefreshCron`(不再复用 dynamicCron)。
 * ②:风控与退避归来源;核心收到这一条失败只跳过它,同一来源后面的订阅照刷,
 *    下一拍也照常再问来源。
 */

import { fail, type GlobalSettings, ok } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { fakeProfileImages } from "../../__tests__/support/profile-images.js";

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

const { startMigratedProfileRefresh } = await import("./profile-refresh-support.js");
const { createNodeMessageBus } = await import("../message-bus.js");

const GLOBALS = {
	profileRefreshCron: "*/10 * * * *",
} as unknown as GlobalSettings;

const PROFILE = {
	name: "UP",
	bio: "s",
	followers: 100,
	refreshedAt: "x",
};
const CARD = { name: "UP", face: "", sign: "s", fans: 100 };

function baseDeps(over: {
	subs: Array<{
		id: string;
		identity: { sourceKey: string; externalId: string };
		enabled: boolean;
	}>;
	fetchUserCard?: ReturnType<typeof vi.fn>;
	rtGet?: ReturnType<typeof vi.fn>;
}) {
	const bus = createNodeMessageBus();
	return {
		bus,
		images: fakeProfileImages(),
		isStatsEnabled: () => true,
		logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
		configStore: { getGlobals: () => GLOBALS, patchSubscription: vi.fn() } as never,
		subscriptionStore: { list: () => over.subs } as never,
		subscriptionStateStore: {
			get: over.rtGet ?? vi.fn(() => ({ cachedProfile: { ...PROFILE } })),
			getAll: () => ({}),
			patch: vi.fn(async () => {}),
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
			fetchUserCard:
				over.fetchUserCard ?? vi.fn(async () => ok({ data: { card: { ...CARD, fans: 1 } } })),
		} as never,
		serviceCtx: {
			setTimeout: vi.fn(() => undefined),
			setInterval: vi.fn(() => undefined),
			track: vi.fn(),
			signal: new AbortController().signal,
		} as never,
	};
}

let handle: { dispose(): void } | undefined;

beforeEach(() => {
	cronMock.instances.length = 0;
	vi.restoreAllMocks();
});
afterEach(() => {
	handle?.dispose();
	handle = undefined;
});

describe("① profileRefreshCron 解耦", () => {
	it("cron 用 profileRefreshCron(动态轮询那条在 B 站自己的设置里,粉丝轮询不碰)", () => {
		handle = startMigratedProfileRefresh(
			baseDeps({
				subs: [{ id: "s1", identity: { sourceKey: "bilibili", externalId: "1" }, enabled: true }],
			}),
		);
		expect(cronMock.instances).toHaveLength(1);
		expect(cronMock.instances[0]?.cronTime).toBe("*/10 * * * *");
	});
});

describe("② 单条资料失败", () => {
	it("一个订阅命中 -352 只跳过它,同来源下一条照刷;下一拍仍然照常问", async () => {
		const fetchUserCard = vi.fn(async (uid: string) =>
			uid === "1"
				? fail("rate_limited", "blocked", { upstreamCode: -352 })
				: ok({ data: { card: { ...CARD, name: "UP2", fans: 5 } } }),
		);
		handle = startMigratedProfileRefresh(
			baseDeps({
				subs: [
					{ id: "s1", identity: { sourceKey: "bilibili", externalId: "1" }, enabled: true },
					{ id: "s2", identity: { sourceKey: "bilibili", externalId: "2" }, enabled: true },
				],
				fetchUserCard,
			}),
		);

		cronMock.instances[0]?.onTick();
		await vi.waitFor(() => expect(fetchUserCard).toHaveBeenCalledTimes(2), {
			timeout: 2000,
			interval: 10,
		});
		expect(fetchUserCard.mock.calls.map(([uid]) => uid)).toEqual(["1", "2"]);

		cronMock.instances[0]?.onTick();
		await vi.waitFor(() => expect(fetchUserCard).toHaveBeenCalledTimes(4));
	});
});
