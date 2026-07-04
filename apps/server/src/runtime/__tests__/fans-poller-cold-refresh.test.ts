/**
 * ⑥ 批量冷刷 name/avatar:启动时用批量 user/cards(一发)刷新已 seed 的
 * cachedProfile 的昵称/头像,替代过去每 tick 逐 UP 拉整张 card 里那份从未在
 * 稳态被消费的 name/avatar。只更 name/avatar,fans 保留。
 */

import type { GlobalConfig } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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

const { startFansPoller } = await import("../fans-poller.js");
const { createNodeMessageBus } = await import("../message-bus.js");

const GLOBALS = { app: { fansCron: "*/10 * * * *" } } as unknown as GlobalConfig;
const SUB = { id: "s1", uid: "1", enabled: true };

let handle: { dispose(): void } | undefined;

beforeEach(() => {
	cronMock.instances.length = 0;
	vi.restoreAllMocks();
});
afterEach(() => {
	handle?.dispose();
	handle = undefined;
});

describe("⑥ 启动批量冷刷 name/avatar", () => {
	it("批量端点回新昵称/头像 → patch 更新 name/avatar,fans 不动", async () => {
		const prevProfile = {
			name: "旧名",
			avatar: "旧头",
			sign: "s",
			fans: 100,
			lastRefreshedAt: "x",
		};
		const rtPatch = vi.fn(async () => {});
		const getUserCardsBatch = vi.fn(async () => ({
			code: 0,
			data: { "1": { mid: "1", name: "新名", face: "新头" } },
		}));

		handle = startFansPoller({
			bus: createNodeMessageBus(),
			logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
			configStore: { getGlobals: () => GLOBALS, patchSubscription: vi.fn() } as never,
			subscriptionStore: { list: () => [SUB] } as never,
			subRuntimeStore: {
				get: vi.fn(() => ({ cachedProfile: { ...prevProfile } })),
				getAll: () => ({}),
				patch: rtPatch,
				prune: vi.fn(async () => {}),
				load: vi.fn(async () => {}),
			} as never,
			fansStore: {
				append: vi.fn(async () => {}),
				findNearestBefore: vi.fn(async () => null),
				findEarliest: vi.fn(async () => undefined),
				dropUid: vi.fn(async () => {}),
			} as never,
			api: {
				getUserCardsBatch,
				// 冷刷后首轮 tick 会走 relation/stat —— 给个稳定返回,避免未 mock 抛错。
				getRelationStat: vi.fn(async () => ({ code: 0, data: { follower: 100 } })),
				getUserCardInfo: vi.fn(),
			} as never,
			// 即时触发 3s 门,让启动流程一路跑到冷刷 + 首轮 tick。
			serviceCtx: {
				setTimeout: vi.fn((cb: () => void) => {
					cb();
					return undefined;
				}),
				setInterval: vi.fn(() => undefined),
			} as never,
		});

		await vi.waitFor(() => expect(getUserCardsBatch).toHaveBeenCalledWith(["1"]), {
			timeout: 2000,
			interval: 10,
		});
		// 冷刷那次 patch:name/avatar 更新,fans 保留。
		type PatchCall = [string, { cachedProfile?: Record<string, unknown> }];
		await vi.waitFor(
			() => {
				const calls = rtPatch.mock.calls as unknown as PatchCall[];
				const cold = calls.find((c) => c[1]?.cachedProfile?.name === "新名");
				expect(cold).toBeTruthy();
				expect(cold?.[1].cachedProfile).toMatchObject({ name: "新名", avatar: "新头", fans: 100 });
			},
			{ timeout: 2000, interval: 10 },
		);
	});
});
