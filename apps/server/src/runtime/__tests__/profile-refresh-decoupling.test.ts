/**
 * 回归测试 — ProfileRefresh↔SubscriptionStateStore 解耦(Bug 1 的真正修复点)。
 *
 * Bug 1 链:ProfileRefresh 每 tick 经 configStore.patchSubscription 写
 * cachedProfile.followers → ConfigStore emit config-changed:subscriptions →
 * SubscriptionStore.replaceAll 整数组 diff → 伪 subscription-changed{update} →
 * DynamicPoller 重订阅 + `[ops]` info-log 每 ~2min 刷屏。
 *
 * 修复后 ProfileRefresh 每 tick 改写 subscriptionStateStore.patch(独立文件、**无事件**),
 * configStore 仅被读 getGlobals().profileRefreshCron。本测试用 dynamic-poller.test
 * 同款 `vi.mock("cron")` FakeCronJob 捕获 onTick,手动驱动**恰好一次** tick,
 * 断言:
 *   1. configStore.patchSubscription 一次都没被调(Bug 1 链入口被切断);
 *   2. subscriptionStateStore.patch 被调,且 payload = { cachedProfile }
 *      (首次 tick 不另写起点);
 *   3. 整个 tick 期间 bus 上没有 config-changed / subscription-changed 冒泡。
 */

import { type GlobalSettings, ok } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { fakeProfileImages, PROFILE_IMAGE_REF } from "../../__tests__/support/profile-images.js";

// cron mock — FakeCronJob 捕获 onTick,不真正排程(同 dynamic-poller.test 套路)。
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

// SUT imported AFTER vi.mock.
const { startMigratedProfileRefresh } = await import("./profile-refresh-support.js");
const { createNodeMessageBus } = await import("../message-bus.js");

const GLOBALS = {
	profileRefreshCron: "*/2 * * * *",
} as unknown as GlobalSettings;

const SUB = {
	id: "sub-1",
	identity: { sourceKey: "bilibili", externalId: "12345" },
	enabled: true,
};

function makeApi(fans: number) {
	return {
		fetchUserCard: vi.fn(async (_uid: string) =>
			ok({
				data: {
					card: { mid: SUB.identity.externalId, name: "测试UP", face: "f.png", sign: "s", fans },
				},
			}),
		),
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

describe("ProfileRefresh 一次 tick — 与 ConfigStore 解耦", () => {
	it("tick 写 subscriptionStateStore.patch,且**绝不**调 configStore.patchSubscription", async () => {
		const bus = createNodeMessageBus();
		const patchSubscription = vi.fn(async () => SUB);
		const rtPatch = vi.fn(async () => {});
		const rtGet = vi.fn(() => undefined); // 首次:无既有 runtime
		const append = vi.fn(async () => {});
		const findNearestBefore = vi.fn(async () => null);
		const api = makeApi(4242);

		// bus 上挂探针:整个 tick 期间不应出现这两类事件冒泡。
		const configChangedSpy = vi.fn();
		const subChangedSpy = vi.fn();
		bus.on("config-changed", configChangedSpy);
		bus.on("subscription-changed", subChangedSpy);

		handle = startMigratedProfileRefresh({
			images: fakeProfileImages(),
			isStatsEnabled: () => true,
			bus,
			logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
			configStore: {
				getGlobals: () => GLOBALS,
				patchSubscription,
			} as never,
			subscriptionStore: { list: () => [SUB] } as never,
			subscriptionStateStore: {
				get: rtGet,
				getAll: () => ({}),
				patch: rtPatch,
				prune: vi.fn(async () => {}),
				load: vi.fn(async () => {}),
			} as never,
			fansStore: {
				append,
				findNearestBefore,
				findEarliest: vi.fn(async () => undefined),
				drop: vi.fn(async () => {}),
			} as never,
			api: api as never,
			serviceCtx: {
				// 让首轮 3s 延时 tick 永不触发(我们手动驱动 onTick),避免双跑。
				setTimeout: vi.fn(() => undefined),
				setInterval: vi.fn(() => undefined),
				track: vi.fn(),
				signal: new AbortController().signal,
			} as never,
		});

		// FakeCronJob 已被构造,onTick 即 ProfileRefresh 内部 tick。手动驱动一次。
		expect(cronMock.instances).toHaveLength(1);
		cronMock.instances[0]?.onTick();

		// tick 内部有 await api / append / findNearestBefore / patch + 200ms sleep。
		// 轮询直到 rtPatch 被调用(最多 ~1s),避免脆弱的固定 sleep。
		await vi.waitFor(
			() => {
				expect(rtPatch).toHaveBeenCalledTimes(1);
			},
			{ timeout: 2000, interval: 10 },
		);

		// (1) Bug 1 链入口被切断:configStore.patchSubscription 一次都没调。
		expect(patchSubscription).not.toHaveBeenCalled();

		// (2) 写进 SubscriptionStateStore:只写 cachedProfile。
		const [id, payload] = rtPatch.mock.calls[0] as unknown as [
			string,
			{ cachedProfile?: Record<string, unknown> },
		];
		expect(id).toBe("sub-1");
		expect(payload.cachedProfile).toMatchObject({ name: "测试UP", followers: 4242 });
		// 来源把头像抓进图库后只交引用;来源地址留在来源自己的状态里。
		expect(payload.cachedProfile).toMatchObject({
			avatar: PROFILE_IMAGE_REF,
		});
		expect(payload.cachedProfile?.refreshedAt).toBeTypeOf("string");

		// (3) 整个 tick 期间 bus 上没有 config-changed / subscription-changed 冒泡。
		expect(configChangedSpy).not.toHaveBeenCalled();
		expect(subChangedSpy).not.toHaveBeenCalled();
	});
});
