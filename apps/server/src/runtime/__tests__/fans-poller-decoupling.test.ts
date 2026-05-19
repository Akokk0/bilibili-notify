/**
 * 回归测试 — FansPoller↔SubRuntimeStore 解耦(Bug 1 的真正修复点)。
 *
 * Bug 1 链:FansPoller 每 tick 经 configStore.patchSubscription 写
 * cachedProfile.fans → ConfigStore emit config-changed:subscriptions →
 * SubscriptionStore.replaceAll 整数组 diff → 伪 subscription-changed{update} →
 * DynamicEngine 重订阅 + `[ops]` info-log 每 ~2min 刷屏。
 *
 * 修复后 FansPoller 每 tick 改写 subRuntimeStore.patch(独立文件、**无事件**),
 * configStore 仅被读 getGlobals().app.dynamicCron。本测试用 dynamic-engine.test
 * 同款 `vi.mock("cron")` FakeCronJob 捕获 onTick,手动驱动**恰好一次** tick,
 * 断言:
 *   1. configStore.patchSubscription 一次都没被调(Bug 1 链入口被切断);
 *   2. subRuntimeStore.patch 被调,且 payload = { cachedProfile, fansBaseline }
 *      (首次 tick 同时写 baseline);
 *   3. 整个 tick 期间 bus 上没有 config-changed / subscription-changed 冒泡。
 */

import type { GlobalConfig } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// cron mock — FakeCronJob 捕获 onTick,不真正排程(同 dynamic-engine.test 套路)。
const cronMock = vi.hoisted(() => {
	const instances: Array<{ cronTime: string; onTick: () => void }> = [];
	class FakeCronJob {
		running = false;
		constructor(
			public cronTime: string,
			public onTick: () => void,
		) {
			instances.push(this);
		}
		start(): void {
			this.running = true;
		}
		stop(): void {
			this.running = false;
		}
	}
	return { instances, FakeCronJob };
});
vi.mock("cron", () => ({ CronJob: cronMock.FakeCronJob }));

// SUT imported AFTER vi.mock.
const { startFansPoller } = await import("../fans-poller.js");
const { createNodeMessageBus } = await import("../message-bus.js");

const GLOBALS = {
	app: { dynamicCron: "*/2 * * * *" },
} as unknown as GlobalConfig;

const SUB = { id: "sub-1", uid: "12345", enabled: true };

function makeApi(fans: number) {
	return {
		getUserCardInfo: vi.fn(async (_uid: string) => ({
			code: 0,
			data: {
				card: { mid: SUB.uid, name: "测试UP", face: "f.png", sign: "s", fans },
			},
		})),
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

describe("FansPoller 一次 tick — 与 ConfigStore 解耦", () => {
	it("tick 写 subRuntimeStore.patch,且**绝不**调 configStore.patchSubscription", async () => {
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

		handle = startFansPoller({
			bus,
			logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
			configStore: {
				getGlobals: () => GLOBALS,
				patchSubscription,
			} as never,
			subscriptionStore: { list: () => [SUB] } as never,
			subRuntimeStore: {
				get: rtGet,
				getAll: () => ({}),
				patch: rtPatch,
				prune: vi.fn(async () => {}),
				load: vi.fn(async () => {}),
			} as never,
			fansStore: { append, findNearestBefore, dropUid: vi.fn(async () => {}) } as never,
			api: api as never,
			serviceCtx: {
				// 让首轮 3s 延时 tick 永不触发(我们手动驱动 onTick),避免双跑。
				setTimeout: vi.fn(() => undefined),
				setInterval: vi.fn(() => undefined),
			} as never,
		});

		// FakeCronJob 已被构造,onTick 即 FansPoller 内部 tick。手动驱动一次。
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

		// (2) 写进 SubRuntimeStore:首次 tick 同时带 cachedProfile + fansBaseline。
		const [id, payload] = rtPatch.mock.calls[0] as unknown as [
			string,
			{ cachedProfile?: Record<string, unknown>; fansBaseline?: Record<string, unknown> },
		];
		expect(id).toBe("sub-1");
		expect(payload.cachedProfile).toMatchObject({ name: "测试UP", fans: 4242 });
		expect(payload.cachedProfile?.lastRefreshedAt).toBeTypeOf("string");
		expect(payload.fansBaseline).toMatchObject({ value: 4242 });

		// (3) 整个 tick 期间 bus 上没有 config-changed / subscription-changed 冒泡。
		expect(configChangedSpy).not.toHaveBeenCalled();
		expect(subChangedSpy).not.toHaveBeenCalled();
	});

	it("已有 fansBaseline 时:tick 只写 cachedProfile,不重写 baseline,仍不碰 configStore", async () => {
		const bus = createNodeMessageBus();
		const patchSubscription = vi.fn(async () => SUB);
		const rtPatch = vi.fn(async () => {});
		// 既有 runtime:baseline 已存在,cachedProfile 已 seed
		const rtGet = vi.fn(() => ({
			cachedProfile: { name: "旧名", avatar: "a", sign: "s", fans: 100, lastRefreshedAt: "x" },
			fansBaseline: { value: 80, ts: "2026-04-01T00:00:00.000Z" },
		}));
		const api = makeApi(120);

		handle = startFansPoller({
			bus,
			logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
			configStore: { getGlobals: () => GLOBALS, patchSubscription } as never,
			subscriptionStore: { list: () => [SUB] } as never,
			subRuntimeStore: {
				get: rtGet,
				getAll: () => ({}),
				patch: rtPatch,
				prune: vi.fn(async () => {}),
				load: vi.fn(async () => {}),
			} as never,
			fansStore: {
				append: vi.fn(async () => {}),
				findNearestBefore: vi.fn(async () => null),
				dropUid: vi.fn(async () => {}),
			} as never,
			api: api as never,
			serviceCtx: {
				setTimeout: vi.fn(() => undefined),
				setInterval: vi.fn(() => undefined),
			} as never,
		});

		cronMock.instances[0]?.onTick();
		await vi.waitFor(() => expect(rtPatch).toHaveBeenCalledTimes(1), {
			timeout: 2000,
			interval: 10,
		});

		expect(patchSubscription).not.toHaveBeenCalled();
		const [, payload] = rtPatch.mock.calls[0] as unknown as [
			string,
			{ cachedProfile?: Record<string, unknown>; fansBaseline?: unknown },
		];
		// 逐键替换 + baseline 已存在 → payload 不带 fansBaseline(不冲掉既有 anchor)
		expect(payload.fansBaseline).toBeUndefined();
		expect(payload.cachedProfile).toMatchObject({ name: "旧名", fans: 120 });
	});
});
