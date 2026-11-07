/**
 * 粉丝轮询的后台活要登记进 `ctx.track()`(切片 ③:关停等它们落定,各写道才关门)。
 *
 * 不登记的话,关停在 flush 段让各写道关门时,tick 写了一半的样本 / 资料缓存、没删完的粉丝时序都会被拒
 * (`queue_closed`)—— 数据就丢了。所以每条用例的骨架都是:把那笔写停在半路 → 断言登记进去的
 * 这件事此刻还悬着 → 放行 → 断言写已经落定。
 */

import type { GlobalSettings } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { fakeProfileImages } from "../../__tests__/support/profile-images.js";
import {
	deferred,
	makeTrackingContext,
	stillPending,
} from "../../__tests__/support/track-context.js";

// cron mock:捕获 onTick,不真正排程(同 profile-refresh-decoupling 的套路)。
const cronMock = vi.hoisted(() => {
	const instances: Array<{ cronTime: string; onTick: () => void }> = [];
	class FakeCronJob {
		constructor(
			public cronTime: string,
			public onTick: () => void,
		) {
			instances.push(this);
		}
		start(): void {}
		stop(): void {}
	}
	return { instances, FakeCronJob };
});
vi.mock("cron", () => ({ CronJob: cronMock.FakeCronJob }));

const { startMigratedProfileRefresh } = await import("./profile-refresh-support.js");
const { createNodeMessageBus } = await import("../message-bus.js");

const GLOBALS = { profileRefreshCron: "*/10 * * * *" } as unknown as GlobalSettings;
const SUB = {
	id: "sub-1",
	identity: { sourceKey: "bilibili", externalId: "12345" },
	enabled: true,
} as const;

let handle: { dispose(): void } | undefined;
beforeEach(() => {
	cronMock.instances.length = 0;
});
afterEach(() => {
	handle?.dispose();
	handle = undefined;
});

function makeLogger() {
	return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

interface Options {
	append?: () => Promise<void>;
	drop?: () => Promise<void>;
	prune?: () => Promise<void>;
	/** 关停后定时器被清:`setTimeout` 给出的回调永远不会触发(和真实的 `clearTimers` 一样)。 */
	list?: () => unknown[];
}

function start(options: Options = {}) {
	const ctx = makeTrackingContext();
	const bus = createNodeMessageBus();
	const logger = makeLogger();
	const runtimePatch = vi.fn(async () => {});
	const append = vi.fn(options.append ?? (async () => {}));
	const drop = vi.fn(options.drop ?? (async () => {}));
	const prune = vi.fn(options.prune ?? (async () => {}));
	const fetchUserCard = vi.fn(async () => ({ data: { card: { name: "甲", fans: 4242 } } }));
	const setTimeout = vi.fn(() => ({ dispose() {} }));
	handle = startMigratedProfileRefresh({
		images: fakeProfileImages(),
		isStatsEnabled: () => true,
		bus,
		logger: logger as never,
		configStore: { getGlobals: () => GLOBALS, patchSubscription: vi.fn() } as never,
		subscriptionStore: { list: options.list ?? (() => [SUB]) } as never,
		subscriptionStateStore: {
			get: vi.fn(() => ({
				cachedProfile: { name: "甲", followers: 1, refreshedAt: "x" },
			})),
			getAll: () => ({}),
			patch: runtimePatch,
			prune,
			load: vi.fn(async () => {}),
		} as never,
		fansStore: {
			append,
			findNearestBefore: vi.fn(async () => null),
			findEarliest: vi.fn(async () => undefined),
			drop,
		} as never,
		api: { fetchUserCard } as never,
		serviceCtx: {
			setTimeout,
			setInterval: vi.fn(() => ({ dispose() {} })),
			track: ctx.track,
			signal: ctx.signal,
		} as never,
	});
	return {
		ctx,
		bus,
		logger,
		runtimePatch,
		append,
		drop,
		prune,
		fetchUserCard,
		setTimeout,
	};
}

describe("profile refresh × ctx.track", () => {
	it("cron 到点的 tick 登记进 track:样本写落定、资料缓存也写完,它才落定", async () => {
		const release = deferred();
		const { ctx, append, runtimePatch } = start({ append: () => release.promise });
		// 开机那一轮在等 3s 门(定时器从不触发),此刻只有它一件登记着。
		await vi.waitFor(() => expect(ctx.tracked).toHaveLength(1));

		cronMock.instances[0]?.onTick();

		expect(ctx.tracked).toHaveLength(2);
		const tick = ctx.tracked[1] as Promise<unknown>;
		await vi.waitFor(() => expect(append).toHaveBeenCalledTimes(1)); // 样本写走到了半路
		expect(await stillPending(tick)).toBe(true);
		expect(runtimePatch).toHaveBeenCalledTimes(1); // 资料已先写,样本的队还悬着
		release.resolve();
		await tick;
		expect(runtimePatch).toHaveBeenCalledTimes(1);
	});

	it("开机首轮:等 3s 门的时候被关停叫醒,马上落定,不再冷刷、不再跑 sweep", async () => {
		const { ctx, append, fetchUserCard, setTimeout } = start();
		await vi.waitFor(() => expect(setTimeout).toHaveBeenCalled()); // 走到了 3s 门
		expect(ctx.tracked).toHaveLength(1);
		const first = ctx.tracked[0] as Promise<unknown>;
		expect(await stillPending(first)).toBe(true);

		// 关停第一步:中止 signal,紧接着清定时器 —— 这里的定时器本来就永不触发。
		ctx.abort();

		expect(await stillPending(first, 200)).toBe(false);
		expect(fetchUserCard).not.toHaveBeenCalled();
		expect(append).not.toHaveBeenCalled();
	});

	it("删订阅:删粉丝时序与清资料缓存都登记进 track,写完才落定", async () => {
		const dropRelease = deferred();
		const pruneRelease = deferred();
		const { ctx, bus, drop, prune } = start({
			drop: () => dropRelease.promise,
			prune: () => pruneRelease.promise,
			list: () => [],
		});
		await vi.waitFor(() => expect(ctx.tracked).toHaveLength(1));

		bus.emit("subscription-changed", { ops: [{ kind: "remove", sub: SUB as never }] });

		await vi.waitFor(() => expect(drop).toHaveBeenCalledWith("sub-1"));
		await vi.waitFor(() => expect(prune).toHaveBeenCalled());
		expect(ctx.tracked).toHaveLength(3);
		const [, dropTask, pruneTask] = ctx.tracked as [
			Promise<unknown>,
			Promise<unknown>,
			Promise<unknown>,
		];
		expect(await stillPending(dropTask)).toBe(true);
		expect(await stillPending(pruneTask)).toBe(true);
		dropRelease.resolve();
		pruneRelease.resolve();
		await Promise.all([dropTask, pruneTask]);
	});

	it("删粉丝时序 / 清资料缓存失败:登记进去的那件事不拒,记一条 warn(以前连 catch 都没有)", async () => {
		const { ctx, bus, logger } = start({
			drop: async () => {
				throw new Error("disk gone");
			},
			prune: async () => {
				throw new Error("queue closed");
			},
			list: () => [],
		});
		await vi.waitFor(() => expect(ctx.tracked).toHaveLength(1));

		bus.emit("subscription-changed", { ops: [{ kind: "remove", sub: SUB as never }] });

		const [, dropTask, pruneTask] = ctx.tracked as [
			Promise<unknown>,
			Promise<unknown>,
			Promise<unknown>,
		];
		await expect(dropTask).resolves.toBeUndefined();
		await expect(pruneTask).resolves.toBeUndefined();
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("disk gone"));
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("queue closed"));
	});
});
