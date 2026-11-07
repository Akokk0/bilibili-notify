/**
 * 统计的定时压缩(`startStatsCompaction`,ADR-0027 决策 15;㉘c、㉘d):开机一次、之后每 6 小时一次,
 * 先压粉丝样本、接着压「在记」的账。
 * 时钟注入;定时器用假时钟推进。
 */

import type { Disposable } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	makeTrackingContext,
	type TrackingContext,
} from "../../__tests__/support/track-context.js";
import type { FollowersStore } from "../../followers/store.js";
import { type RecordingCompactSummary, startStatsCompaction } from "../compaction.js";

const SIX_HOURS = 6 * 60 * 60 * 1000;
const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
const report = (rewritten = false, rowsBefore = 0, rowsAfter = 0, badLines = 0) => ({
	rowsBefore,
	rowsAfter,
	badLines,
	rewritten,
});

let ctx: TrackingContext;
let log: ReturnType<typeof logger>;
let handles: Disposable[];

/** 假时钟上的 `serviceCtx.setInterval`:返回的句柄 dispose 就清掉定时器。 */
const setInterval_ = (fn: () => void, ms: number): Disposable => {
	const id = globalThis.setInterval(fn, ms);
	return { dispose: () => clearInterval(id) };
};

function makeStore(keys: string[], compact?: FollowersStore["compact"]) {
	const calls: Array<[string, Date]> = [];
	const store = {
		keys: vi.fn(async () => keys),
		compact: vi.fn(async (key: string, now: Date) => {
			calls.push([key, now]);
			return compact ? compact(key, now) : report();
		}),
	};
	return { store: store as unknown as FollowersStore, calls, raw: store };
}

const noRecording = (): RecordingCompactSummary => ({ files: 0, squeezed: 0, badLines: 0 });

/** 账那一半的替身:记下被叫到时的此刻与先后。 */
function makeRecorder(compact?: (now: Date) => Promise<RecordingCompactSummary>) {
	const calls: Date[] = [];
	const recorder = {
		compactRecording: vi.fn(async (now: Date) => {
			calls.push(now);
			return compact ? compact(now) : noRecording();
		}),
	};
	return { recorder, calls };
}

function start(
	store: FollowersStore,
	intervalMs?: number,
	recorder: ReturnType<typeof makeRecorder>["recorder"] = makeRecorder().recorder,
) {
	const handle = startStatsCompaction({
		serviceCtx: { setInterval: setInterval_, track: ctx.track } as never,
		store,
		recorder,
		logger: log as never,
		intervalMs,
		now: () => new Date(),
	});
	handles.push(handle);
	return handle;
}

beforeEach(() => {
	vi.useFakeTimers({ now: new Date("2026-06-30T12:00:00.000Z") });
	ctx = makeTrackingContext();
	log = logger();
	handles = [];
});
afterEach(() => {
	for (const h of handles) h.dispose();
	vi.useRealTimers();
});

describe("startStatsCompaction", () => {
	it("压缩诊断分开记录汇总计数与原始异常，失败不阻止账本压缩", async () => {
		const error = new Error("disk", { cause: new Error("io") });
		const { store } = makeStore(["bad", "good"], async (key) => {
			if (key === "bad") throw error;
			return report(true, 10, 4, 2);
		});
		const { recorder } = makeRecorder(async () => ({ files: 1, squeezed: 3, badLines: 1 }));
		start(store, undefined, recorder);
		await ctx.settled();
		expect(log.warn).toHaveBeenCalledWith("粉丝样本压缩失败", { key: "bad", error });
		expect(log.info.mock.calls).toEqual([
			["粉丝样本压缩完成", { files: 1, squeezed: 6, badLines: 2 }],
			["统计记录账本压缩完成", { files: 1, squeezed: 3, badLines: 1 }],
		]);
		expect(recorder.compactRecording).toHaveBeenCalledTimes(1);
	});

	it("开机跑一次:盘上每个文件各压一遍,用注入的此刻;这一轮登记进 track", async () => {
		const { store, calls } = makeStore(["a", "b"]);
		start(store);
		expect(ctx.tracked).toHaveLength(1);
		await ctx.settled();
		expect(calls.map(([key]) => key)).toEqual(["a", "b"]);
		expect(calls.every(([, now]) => now.toISOString() === "2026-06-30T12:00:00.000Z")).toBe(true);
	});

	it("之后每 6 小时一次(默认间隔);没到点不跑", async () => {
		const { store, raw } = makeStore(["a"]);
		start(store);
		await ctx.settled();
		expect(raw.compact).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(SIX_HOURS - 1);
		await ctx.settled();
		expect(raw.compact).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(1);
		await ctx.settled();
		expect(raw.compact).toHaveBeenCalledTimes(2);
		expect(raw.compact.mock.calls[1]?.[1].toISOString()).toBe("2026-06-30T18:00:00.000Z");
		expect(ctx.tracked).toHaveLength(2);

		await vi.advanceTimersByTimeAsync(SIX_HOURS);
		await ctx.settled();
		expect(raw.compact).toHaveBeenCalledTimes(3);
	});

	it("dispose 之后不再跑", async () => {
		const { store, raw } = makeStore(["a"]);
		const handle = start(store);
		await ctx.settled();
		handle.dispose();
		await vi.advanceTimersByTimeAsync(SIX_HOURS * 3);
		await ctx.settled();
		expect(raw.compact).toHaveBeenCalledTimes(1);
	});

	it("一个文件压不动:记 warn、不挡后面的文件,登记进去的那件事不拒", async () => {
		const { store, calls } = makeStore(["a", "b", "c"], async (key) => {
			if (key === "b") throw new Error("boom");
			return report();
		});
		start(store);
		const settled = await ctx.settled();
		expect(settled).toEqual([{ status: "fulfilled", value: undefined }]);
		expect(calls.map(([key]) => key)).toEqual(["a", "b", "c"]);
		expect(log.warn).toHaveBeenCalledTimes(1);
		expect(log.warn.mock.calls[0]?.[1]).toMatchObject({ key: "b", error: expect.any(Error) });
	});

	it("列不出文件:记 warn,不抛;下一轮照来", async () => {
		const { store, raw } = makeStore(["a"]);
		raw.keys.mockRejectedValueOnce(new Error("no dir"));
		start(store);
		expect(await ctx.settled()).toEqual([{ status: "fulfilled", value: undefined }]);
		expect(log.warn).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(SIX_HOURS);
		await ctx.settled();
		expect(raw.compact).toHaveBeenCalledTimes(1);
	});

	it("有改写时记一条 info(几个文件、压掉几行、丢了几条坏行);什么都没改写就不吵", async () => {
		const quiet = makeStore(["a"]);
		start(quiet.store);
		await ctx.settled();
		expect(log.info).not.toHaveBeenCalled();

		const loud = makeStore(["a", "b"], async (key) =>
			key === "a" ? report(true, 100, 40, 2) : report(true, 10, 9, 0),
		);
		start(loud.store);
		await ctx.settled();
		expect(log.info).toHaveBeenCalledTimes(1);
		expect(log.info).toHaveBeenCalledWith("粉丝样本压缩完成", {
			files: 2,
			squeezed: 61,
			badLines: 2,
		});
	});
});

describe("startStatsCompaction — 在记的账", () => {
	it("开机一轮:先压完粉丝样本,再压账,账用同一个注入的此刻", async () => {
		const order: string[] = [];
		const { store } = makeStore(["a"], async () => {
			order.push("followers");
			return report();
		});
		const { recorder, calls } = makeRecorder(async () => {
			order.push("recording");
			return noRecording();
		});
		start(store, undefined, recorder);
		await ctx.settled();
		expect(order).toEqual(["followers", "recording"]);
		expect(calls.map((d) => d.toISOString())).toEqual(["2026-06-30T12:00:00.000Z"]);
	});

	it("之后每 6 小时,账也跟着压一次", async () => {
		const { store } = makeStore(["a"]);
		const { recorder, calls } = makeRecorder();
		start(store, undefined, recorder);
		await ctx.settled();
		await vi.advanceTimersByTimeAsync(SIX_HOURS);
		await ctx.settled();
		expect(calls.map((d) => d.toISOString())).toEqual([
			"2026-06-30T12:00:00.000Z",
			"2026-06-30T18:00:00.000Z",
		]);
	});

	it("粉丝那一边出错(列不出文件)不挡账;账那一边出错也不挡下一轮,各记一条 warn", async () => {
		const { store, raw } = makeStore(["a"]);
		raw.keys.mockRejectedValueOnce(new Error("no dir"));
		const { recorder, calls } = makeRecorder();
		start(store, undefined, recorder);
		expect(await ctx.settled()).toEqual([{ status: "fulfilled", value: undefined }]);
		expect(calls).toHaveLength(1);
		expect(log.warn).toHaveBeenCalledTimes(1);

		const failing = makeRecorder(async () => {
			throw new Error("ledger boom");
		});
		start(makeStore(["a"]).store, undefined, failing.recorder);
		await ctx.settled();
		expect(failing.calls).toHaveLength(1);
		expect(log.warn).toHaveBeenCalledTimes(2);
		expect(log.warn.mock.calls[1]?.[1]).toMatchObject({
			error: expect.objectContaining({ message: "ledger boom" }),
		});
	});

	it("账有改写时记一条 info(几个文件、压掉几行、丢几条坏行);没改写不吵", async () => {
		start(makeStore([]).store, undefined, makeRecorder().recorder);
		await ctx.settled();
		expect(log.info).not.toHaveBeenCalled();

		const loud = makeRecorder(async () => ({ files: 3, squeezed: 40, badLines: 1 }));
		start(makeStore([]).store, undefined, loud.recorder);
		await ctx.settled();
		expect(log.info).toHaveBeenCalledWith("统计记录账本压缩完成", {
			files: 3,
			squeezed: 40,
			badLines: 1,
		});
	});
});
