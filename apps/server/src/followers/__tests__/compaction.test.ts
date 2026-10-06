/**
 * 粉丝样本的定时压缩(`startFollowersCompaction`,ADR-0027 决策 15;㉘c):开机一次、之后每 6 小时一次。
 * 时钟注入;定时器用假时钟推进。
 */

import type { Disposable } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	makeTrackingContext,
	type TrackingContext,
} from "../../__tests__/support/track-context.js";
import { startFollowersCompaction } from "../compaction.js";
import type { FollowersStore } from "../store.js";

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

function start(store: FollowersStore, intervalMs?: number) {
	const handle = startFollowersCompaction({
		serviceCtx: { setInterval: setInterval_, track: ctx.track } as never,
		store,
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

describe("startFollowersCompaction", () => {
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
		expect(String(log.warn.mock.calls[0]?.[0])).toContain("b");
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
		const text = String(log.info.mock.calls[0]?.[0]);
		expect(text).toContain("2 file(s)");
		expect(text).toContain("squeezed 61 row(s)"); // 压掉 (100-40) + (10-9) = 61 行
		expect(text).toContain("2 bad line(s)");
	});
});
