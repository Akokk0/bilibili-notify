/**
 * 总览的 30 秒缓存有一个**作废口**(㉙a 先把口留好,㉙d 清理统计之后用它):缓存键不含「统计被清」这件事,
 * 不作废的话清完的 30 秒里面板还会读到已经不存在的行。
 */

import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createStatsOverview } from "../stats.js";
import type { RouteDeps } from "../types.js";

const NOW = Date.UTC(2026, 4, 16, 12, 0, 0);

function makeDeps(listSamplesSince: (...args: unknown[]) => Promise<unknown[]>) {
	return {
		runtime: {
			fansStore: { listSamplesSince, findNearestBefore: async () => undefined },
			statsStore: {
				listPosts: async () => [],
				listLiveSessions: async () => [],
				listRecording: async () => [],
			},
			engines: null,
			fansPoller: null,
			subRuntimeStore: { get: () => undefined },
		},
		store: {
			getSubscriptions: () => [
				{ id: "id-1", identity: { sourceKey: "bilibili", externalId: "1" }, enabled: true },
			],
		},
	} as unknown as RouteDeps;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});

describe("createStatsOverview.invalidate", () => {
	it("对照:不作废时 TTL 内第二次读命中缓存、不再读盘", async () => {
		const listSamplesSince = vi.fn(async () => []);
		const overview = createStatsOverview(makeDeps(listSamplesSince));
		await overview(30, 0);
		await overview(30, 0);
		expect(listSamplesSince).toHaveBeenCalledTimes(1);
	});

	it("作废之后下一次读重新读盘(每个窗口参数的缓存都清掉)", async () => {
		const listSamplesSince = vi.fn(async () => []);
		const overview = createStatsOverview(makeDeps(listSamplesSince));
		await overview(30, 0);
		await overview(7, -480);
		expect(listSamplesSince).toHaveBeenCalledTimes(2);
		overview.invalidate();
		await overview(30, 0);
		await overview(7, -480);
		expect(listSamplesSince).toHaveBeenCalledTimes(4);
	});

	it("算的过程中被作废:这一份读的是作废之前的盘,算完不写进缓存", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const listSamplesSince = vi.fn(async () => {
			await gate;
			return [];
		});
		const overview = createStatsOverview(makeDeps(listSamplesSince));
		const inflight = overview(30, 0);
		await vi.advanceTimersByTimeAsync(0);
		overview.invalidate();
		release();
		await inflight;
		await overview(30, 0);
		expect(listSamplesSince).toHaveBeenCalledTimes(2);
	});
});
