/**
 * 测试 — FansPoller restoreFromDisk 启动时对 fansBaseline 做自愈。
 *
 * 起因:c4e9dcd 把 fansBaseline 从 Subscription 搬到 sub-runtime.json 时旧值没
 * 迁过来,重启后 fans-poller 看 baseline 缺失就把当时值当作"订阅起点"重写,
 * 概览 Tab"起点"列(基于被错误重写的 baseline)失真。jsonl 是 append-only
 * ground truth,以它为准修复。
 *
 * 守护契约:
 *   1. earliest.ts < baseline.ts → 调 patch 重置 baseline 为 earliest,deltaSubscribed
 *      跟着用新 baseline 算
 *   2. earliest.ts >= baseline.ts → 不动 baseline(正常 case)
 *   3. baseline 不存在 → 不触发 self-heal(留给首次 tick 写)
 *   4. earliest 不存在(全新 sub) → 不触发 self-heal
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

const GLOBALS = { app: { dynamicCron: "*/2 * * * *" } } as unknown as GlobalConfig;
const SUB = { id: "sub-1", uid: "12345", enabled: true };

let handle: { dispose(): void } | undefined;

beforeEach(() => {
	cronMock.instances.length = 0;
	vi.restoreAllMocks();
});
afterEach(() => {
	handle?.dispose();
	handle = undefined;
});

function runPoller(opts: {
	findEarliest: ReturnType<typeof vi.fn>;
	findNearestBefore: ReturnType<typeof vi.fn>;
	rtGet: ReturnType<typeof vi.fn>;
	rtPatch: ReturnType<typeof vi.fn>;
}) {
	const bus = createNodeMessageBus();
	return startFansPoller({
		bus,
		logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
		configStore: { getGlobals: () => GLOBALS, patchSubscription: vi.fn() } as never,
		subscriptionStore: { list: () => [SUB] } as never,
		subRuntimeStore: {
			get: opts.rtGet,
			getAll: () => ({}),
			patch: opts.rtPatch,
			prune: vi.fn(async () => {}),
			load: vi.fn(async () => {}),
		} as never,
		fansStore: {
			append: vi.fn(async () => {}),
			findNearestBefore: opts.findNearestBefore,
			findEarliest: opts.findEarliest,
			dropUid: vi.fn(async () => {}),
		} as never,
		api: {
			getUserCardInfo: vi.fn(async () => ({ code: 0, data: { card: { fans: 0 } } })),
		} as never,
		serviceCtx: {
			setTimeout: vi.fn(() => undefined),
			setInterval: vi.fn(() => undefined),
		} as never,
	});
}

describe("restoreFromDisk — fansBaseline 自愈", () => {
	it("earliest 比 baseline 早 → patch 重置 baseline 为 earliest", async () => {
		const earliest = { ts: "2026-05-13T10:00:00.000Z", value: 1000 };
		const oldBaseline = { ts: "2026-05-19T06:30:00.000Z", value: 1500 };
		const rtPatch = vi.fn(async () => {});
		handle = runPoller({
			rtGet: vi.fn(() => ({ fansBaseline: oldBaseline })),
			rtPatch,
			findEarliest: vi.fn(async () => earliest),
			findNearestBefore: vi.fn(async () => ({ ts: "2026-05-20T00:00:00.000Z", value: 1600 })),
		});
		await vi.waitFor(
			() => expect(rtPatch).toHaveBeenCalledWith("sub-1", { fansBaseline: earliest }),
			{ timeout: 2000, interval: 10 },
		);
	});

	it("earliest 等于 baseline → 不调 patch(语义一致,正常态)", async () => {
		const same = { ts: "2026-05-19T06:30:00.000Z", value: 1500 };
		const rtPatch = vi.fn(async () => {});
		handle = runPoller({
			rtGet: vi.fn(() => ({ fansBaseline: same })),
			rtPatch,
			findEarliest: vi.fn(async () => same),
			findNearestBefore: vi.fn(async () => ({ ts: "2026-05-20T00:00:00.000Z", value: 1600 })),
		});
		// 给后台 restoreFromDisk 跑完的窗口(它无 cron 触发,但有 await)。
		await new Promise((r) => setTimeout(r, 200));
		expect(rtPatch).not.toHaveBeenCalled();
	});

	it("earliest 晚于 baseline(理论不应出现,但容错)→ 不调 patch", async () => {
		const oldBaseline = { ts: "2026-05-13T10:00:00.000Z", value: 1000 };
		const later = { ts: "2026-05-19T00:00:00.000Z", value: 1300 };
		const rtPatch = vi.fn(async () => {});
		handle = runPoller({
			rtGet: vi.fn(() => ({ fansBaseline: oldBaseline })),
			rtPatch,
			findEarliest: vi.fn(async () => later),
			findNearestBefore: vi.fn(async () => ({ ts: "2026-05-20T00:00:00.000Z", value: 1600 })),
		});
		await new Promise((r) => setTimeout(r, 200));
		expect(rtPatch).not.toHaveBeenCalled();
	});

	it("baseline 不存在(全新 sub)→ 不触发 self-heal,留给首次 tick 写", async () => {
		const earliest = { ts: "2026-05-13T10:00:00.000Z", value: 1000 };
		const rtPatch = vi.fn(async () => {});
		handle = runPoller({
			rtGet: vi.fn(() => ({})),
			rtPatch,
			findEarliest: vi.fn(async () => earliest),
			findNearestBefore: vi.fn(async () => ({ ts: "2026-05-20T00:00:00.000Z", value: 1600 })),
		});
		await new Promise((r) => setTimeout(r, 200));
		expect(rtPatch).not.toHaveBeenCalled();
	});

	it("earliest 不存在(jsonl 空)→ 不触发 self-heal", async () => {
		const oldBaseline = { ts: "2026-05-19T06:30:00.000Z", value: 1500 };
		const rtPatch = vi.fn(async () => {});
		handle = runPoller({
			rtGet: vi.fn(() => ({ fansBaseline: oldBaseline })),
			rtPatch,
			findEarliest: vi.fn(async () => undefined),
			findNearestBefore: vi.fn(async () => ({ ts: "2026-05-20T00:00:00.000Z", value: 1600 })),
		});
		await new Promise((r) => setTimeout(r, 200));
		expect(rtPatch).not.toHaveBeenCalled();
	});
});
